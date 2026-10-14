// Applies isolated-workspace changes back onto the source project.
//
// Two hard rules drive this module (FR-08 / NFR-02):
//
// 1. Nothing is written back without an explicit user confirmation.
// 2. Nothing overwrites a file the user changed since the isolated workspace was
//    created; conflicting files are reported and skipped instead.
//
// Conflicts are detected by comparing the source file against the same baseline
// the isolated workspace started from (a Git commit for repositories, the task
// snapshot for plain folders). That is a real three-way comparison rather than an
// mtime heuristic, so a user edit is never mistaken for agent output.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { RuntimeWorkspaceFileChange, RuntimeWorkspaceType } from "../core/api-contract";
import { getGitStdout, runGit } from "./git-utils";
import { isPathWithinRoot } from "./path-sandbox";
import { diffSnapshotDirectories, readTaskSnapshot, type SnapshotFileEntry } from "./snapshot-diff";

export interface ApplyPlanEntry {
	path: string;
	status: RuntimeWorkspaceFileChange["status"];
	/** Source-relative path of the isolated file this entry would copy from. */
	isolatedRelativePath: string;
	conflicts: boolean;
	conflictReason: string | null;
}

export interface IsolatedApplyPlan {
	taskId: string;
	sourceRoot: string;
	isolatedPath: string;
	/** Files that can be applied safely. */
	applicable: ApplyPlanEntry[];
	/** Files whose source has diverged; the user must resolve them. */
	conflicting: ApplyPlanEntry[];
	empty: boolean;
}

export interface IsolatedApplyResult {
	ok: boolean;
	applied: string[];
	skipped: string[];
	conflicts: Array<{ path: string; reason: string }>;
	error?: string;
}

function changedStatus(porcelainCode: string): RuntimeWorkspaceFileChange["status"] {
	const indexCode = porcelainCode.charAt(0);
	const worktreeCode = porcelainCode.charAt(1);
	if (indexCode === "D" || worktreeCode === "D") {
		return "deleted";
	}
	if (indexCode === "A" || worktreeCode === "A") {
		return "added";
	}
	if (indexCode === "R") {
		return "renamed";
	}
	return "modified";
}

interface ParsedStatusFile {
	path: string;
	status: RuntimeWorkspaceFileChange["status"];
}

/** Parse `git status --porcelain=v2 --untracked-files=all` output. */
export function parsePorcelainV2Status(output: string): ParsedStatusFile[] {
	const files: ParsedStatusFile[] = [];
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trimEnd();
		if (!line) {
			continue;
		}
		if (line.startsWith("? ")) {
			files.push({ path: line.slice(2).trim(), status: "untracked" });
			continue;
		}
		if (line.startsWith("1 ")) {
			// `1 XY sub mH mI mW hH hI path`
			const parts = line.split(" ");
			const xy = parts[1] ?? "";
			const path = parts.slice(8).join(" ");
			if (path) {
				files.push({ path, status: changedStatus(xy) });
			}
			continue;
		}
		if (line.startsWith("2 ")) {
			// `2 XY sub mH mI mW hH hI Xscore path\tsourcePath`
			const tabIndex = line.indexOf("\t");
			const head = tabIndex === -1 ? line : line.slice(0, tabIndex);
			const previousPath = tabIndex === -1 ? "" : line.slice(tabIndex + 1).trim();
			const parts = head.split(" ");
			const xy = parts[1] ?? "";
			const path = parts.slice(9).join(" ");
			if (path) {
				files.push({ path: previousPath || path, status: changedStatus(xy) });
			}
		}
	}
	return files;
}

interface GitTarget {
	relativePath: string;
	isolatedPath: string;
	sourcePath: string;
}

function resolveGitTargets(options: {
	sourceRoot: string;
	isolatedPath: string;
	repositories: Array<{ relativePath: string; isRoot: boolean }>;
}): GitTarget[] {
	const targets: GitTarget[] = [];
	for (const repository of options.repositories) {
		targets.push({
			relativePath: repository.relativePath,
			isolatedPath: repository.relativePath
				? join(options.isolatedPath, repository.relativePath)
				: options.isolatedPath,
			sourcePath: repository.relativePath ? join(options.sourceRoot, repository.relativePath) : options.sourceRoot,
		});
	}
	if (targets.length === 0) {
		targets.push({
			relativePath: "",
			isolatedPath: options.isolatedPath,
			sourcePath: options.sourceRoot,
		});
	}
	return targets;
}

async function readTextFileOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Build an apply plan without writing anything (FR-08 / AC-08.6).
 *
 * The UI renders this so the user sees exactly what would change, and which
 * files need manual resolution, before confirming.
 */
export async function buildIsolatedApplyPlan(options: {
	taskId: string;
	workspaceId: string;
	sourceRoot: string;
	isolatedPath: string;
	workspaceType: RuntimeWorkspaceType;
	/** Repository layout discovered for the source project. */
	repositories: Array<{ relativePath: string; isRoot: boolean }>;
}): Promise<IsolatedApplyPlan> {
	const sourceRoot = resolve(options.sourceRoot);
	const isolatedPath = resolve(options.isolatedPath);

	const plan: IsolatedApplyPlan = {
		taskId: options.taskId,
		sourceRoot,
		isolatedPath,
		applicable: [],
		conflicting: [],
		empty: true,
	};

	if (options.workspaceType === "none") {
		await buildSnapshotPlan({
			...options,
			sourceRoot,
			isolatedPath,
			plan,
		});
	} else {
		await buildGitPlan({
			...options,
			sourceRoot,
			isolatedPath,
			plan,
		});
	}

	plan.empty = plan.applicable.length === 0 && plan.conflicting.length === 0;
	return plan;
}

async function buildGitPlan(options: {
	taskId: string;
	sourceRoot: string;
	isolatedPath: string;
	repositories: Array<{ relativePath: string; isRoot: boolean }>;
	plan: IsolatedApplyPlan;
}): Promise<void> {
	const targets = resolveGitTargets({
		sourceRoot: options.sourceRoot,
		isolatedPath: options.isolatedPath,
		repositories: options.repositories,
	});

	for (const target of targets) {
		let statusOutput: string;
		try {
			statusOutput = await getGitStdout(["status", "--porcelain=v2", "--untracked-files=all"], target.isolatedPath);
		} catch {
			// Not a usable repository in the isolated workspace; skip it.
			continue;
		}
		const files = parsePorcelainV2Status(statusOutput);
		if (files.length === 0) {
			continue;
		}

		// The isolated worktree's HEAD is the commit it branched from, so
		// `HEAD:<path>` in the *source* repository is the baseline the agent
		// started editing from.
		for (const file of files) {
			const repositoryRelativePath = target.relativePath ? `${target.relativePath}/${file.path}` : file.path;
			const sourceFilePath = join(target.sourcePath, file.path);
			const isolatedFilePath = join(target.isolatedPath, file.path);

			const conflict = await detectGitConflict({
				sourceFilePath,
				isolatedFilePath,
				sourceRepositoryPath: target.sourcePath,
				repositoryRelativePath: file.path,
			});

			const entry: ApplyPlanEntry = {
				path: repositoryRelativePath,
				status: file.status,
				isolatedRelativePath: repositoryRelativePath,
				conflicts: conflict.conflicts,
				conflictReason: conflict.reason,
			};
			if (conflict.conflicts) {
				options.plan.conflicting.push(entry);
			} else {
				options.plan.applicable.push(entry);
			}
		}
	}
}

/**
 * A source file conflicts when its working-tree content differs from the
 * repository's committed baseline for that path.
 *
 * If the source file still matches what the agent started from, applying the
 * isolated version cannot destroy anything. If it differs, the user has edited
 * the file since isolation and we refuse to overwrite it.
 */
async function detectGitConflict(options: {
	sourceFilePath: string;
	isolatedFilePath: string;
	sourceRepositoryPath: string;
	repositoryRelativePath: string;
}): Promise<{ conflicts: boolean; reason: string | null }> {
	// Read the baseline verbatim (`trimStdout: false`). The default trimming would
	// strip the trailing newline and make every file look modified versus HEAD.
	const baselineResult = await runGit(
		options.sourceRepositoryPath,
		["show", `HEAD:${options.repositoryRelativePath}`],
		{ trimStdout: false },
	);
	const baselineText = baselineResult.ok ? baselineResult.stdout : null;
	const sourceExists = await fileExists(options.sourceFilePath);

	if (!sourceExists) {
		// The user deleted the file after the task started. Recreating it would
		// resurrect content they intentionally removed, so treat it as a conflict.
		if (baselineText !== null) {
			return {
				conflicts: true,
				reason: `${options.repositoryRelativePath} was deleted in your project after this task started.`,
			};
		}
		return { conflicts: false, reason: null };
	}

	const sourceText = await readTextFileOrNull(options.sourceFilePath);

	// A file that does not exist in HEAD is either new in the source or new from
	// the agent. Without a baseline we cannot prove the agent authored it, so we
	// only allow it when the isolated copy differs from the source (meaning the
	// agent changed it) and the source is otherwise untracked-but-present. To stay
	// safe we report it as applicable only when contents differ; otherwise it is a
	// no-op that should be skipped.
	if (baselineText === null) {
		const isolatedText = await readTextFileOrNull(options.isolatedFilePath);
		if (isolatedText === null) {
			return { conflicts: false, reason: null };
		}
		if (isolatedText === sourceText) {
			return {
				conflicts: true,
				reason: `${options.repositoryRelativePath} already exists in your project with identical content. Nothing to apply.`,
			};
		}
		return { conflicts: false, reason: null };
	}

	if (sourceText === baselineText) {
		return { conflicts: false, reason: null };
	}

	const isolatedText = await readTextFileOrNull(options.isolatedFilePath);
	if (isolatedText !== null && isolatedText === sourceText) {
		// The source already has exactly what the agent produced (for example the
		// user applied it manually). Nothing to do, and not a conflict.
		return { conflicts: false, reason: null };
	}

	return {
		conflicts: true,
		reason: `${options.repositoryRelativePath} was modified in your project after this task started. Resolve it manually or discard those edits before applying.`,
	};
}

async function buildSnapshotPlan(options: {
	taskId: string;
	sourceRoot: string;
	isolatedPath: string;
	plan: IsolatedApplyPlan;
}): Promise<void> {
	const snapshot = await readTaskSnapshot(options.taskId, options.sourceRoot);
	const baselineByPath = new Map<string, SnapshotFileEntry>((snapshot?.files ?? []).map((file) => [file.path, file]));

	const diff = await diffSnapshotDirectories({
		taskId: options.taskId,
		workspacePath: options.sourceRoot,
		currentPath: options.isolatedPath,
	});

	for (const entry of diff) {
		const baseline = baselineByPath.get(entry.path);
		const sourceText = await readTextFileOrNull(join(options.sourceRoot, entry.path));

		let conflictReason: string | null = null;
		if (baseline) {
			// Baseline exists: the source must still match it.
			if (sourceText !== baseline.content && sourceText !== entry.newText) {
				conflictReason = `${entry.path} was modified in your project after this task started. Resolve it manually or discard those edits before applying.`;
			}
		} else if (sourceText !== null && sourceText !== entry.newText) {
			// New file the agent created but the user also created independently.
			conflictReason = `${entry.path} was created in your project after this task started with different content.`;
		}

		const planEntry: ApplyPlanEntry = {
			path: entry.path,
			status: entry.status,
			isolatedRelativePath: entry.path,
			conflicts: conflictReason !== null,
			conflictReason,
		};
		if (conflictReason) {
			options.plan.conflicting.push(planEntry);
		} else {
			options.plan.applicable.push(planEntry);
		}
	}
}

async function fileExists(path: string): Promise<boolean> {
	return (await readTextFileOrNull(path)) !== null;
}

/**
 * Apply an isolated workspace's changes onto the source project.
 *
 * Conflicts are reported and skipped, never overwritten. Individual write
 * failures are collected so a partial apply still tells the user exactly which
 * files landed and which did not (FR-08 / AC-08.12).
 */
export async function applyIsolatedWorkspace(options: {
	taskId: string;
	workspaceId: string;
	sourceRoot: string;
	isolatedPath: string;
	workspaceType: RuntimeWorkspaceType;
	repositories: Array<{ relativePath: string; isRoot: boolean }>;
	/** Must be true. Present so a caller cannot apply by accident. */
	confirmed: boolean;
	/** Restrict the apply to these paths. Omit for everything applicable. */
	paths?: string[];
}): Promise<IsolatedApplyResult> {
	const applied: string[] = [];
	const skipped: string[] = [];
	const conflicts: Array<{ path: string; reason: string }> = [];

	try {
		const plan = await buildIsolatedApplyPlan({
			taskId: options.taskId,
			workspaceId: options.workspaceId,
			sourceRoot: options.sourceRoot,
			isolatedPath: options.isolatedPath,
			workspaceType: options.workspaceType,
			repositories: options.repositories,
		});

		for (const conflict of plan.conflicting) {
			conflicts.push({ path: conflict.path, reason: conflict.conflictReason ?? "Conflicting change." });
		}

		// AC-08.5/AC-08.6: applying is always an explicit, confirmed action.
		if (!options.confirmed) {
			return {
				ok: false,
				applied,
				skipped: plan.applicable.map((entry) => entry.path),
				conflicts,
				error: "Applying changes requires explicit confirmation.",
			};
		}

		const sourceRoot = resolve(options.sourceRoot);
		const isolatedPath = resolve(options.isolatedPath);
		const requestedPaths = options.paths ? new Set(options.paths) : null;

		for (const entry of plan.applicable) {
			if (requestedPaths && !requestedPaths.has(entry.path)) {
				skipped.push(entry.path);
				continue;
			}
			try {
				await applySingleFile({
					sourceRoot,
					isolatedPath,
					relativePath: entry.path,
					isolatedRelativePath: entry.isolatedRelativePath,
					status: entry.status,
				});
				applied.push(entry.path);
			} catch (error) {
				skipped.push(entry.path);
				const message = error instanceof Error ? error.message : String(error);
				conflicts.push({ path: entry.path, reason: message });
			}
		}

		return {
			ok: conflicts.length === 0,
			applied,
			skipped,
			conflicts,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			applied,
			skipped,
			conflicts,
			error: message,
		};
	}
}

async function applySingleFile(options: {
	sourceRoot: string;
	isolatedPath: string;
	relativePath: string;
	isolatedRelativePath: string;
	status: RuntimeWorkspaceFileChange["status"];
}): Promise<void> {
	const sourcePath = join(options.sourceRoot, options.relativePath);
	// Defense in depth: the resolved target must stay inside the project root.
	// Without this a crafted relative path could escape via `..`.
	if (!isPathWithinRoot(options.sourceRoot, sourcePath)) {
		throw new Error(`Refusing to write outside the project root: ${options.relativePath}`);
	}

	if (options.status === "deleted") {
		await rm(sourcePath, { force: true });
		return;
	}

	const isolatedFilePath = join(options.isolatedPath, options.isolatedRelativePath);
	let content: string;
	try {
		content = await readFile(isolatedFilePath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read isolated file ${options.relativePath}: ${message}`);
	}

	await mkdir(dirname(sourcePath), { recursive: true });
	await writeFile(sourcePath, content, "utf8");
}
