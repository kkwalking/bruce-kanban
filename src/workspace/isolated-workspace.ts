// Creates and manages per-task isolated workspaces.
//
// Two strategies, chosen by what the project root actually is:
//
// - Git-rooted projects use `git worktree`, which keeps the isolated directory
//   cheap and lets Git own the file lifecycle.
// - Everything else (plain folders, multi-repository parents, `google-repo`
//   checkouts) uses a structural directory copy that preserves relative paths
//   inside the workspace.
//
// In all cases the source workspace is treated as read-only from the isolated
// side: nothing here ever writes into the project root.
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type {
	RuntimeTaskExecutionMode,
	RuntimeTaskWorkspaceInstance,
	RuntimeWorkspaceType,
} from "../core/api-contract";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { getIsolatedWorkspacesRootPath, getRuntimeHomePath, getTaskWorktreesHomePath } from "../state/runtime-paths";
import { readGitHeadInfo, runGit } from "./git-utils";
import { isPathWithinRoot } from "./path-sandbox";
import { captureTaskSnapshot, hasTaskSnapshot } from "./snapshot-diff";
import { normalizeTaskIdForWorktreePath } from "./task-worktree-path";
import { loadWorkspaceDiscovery } from "./workspace-discovery";

/**
 * Directories that are never copied into an isolated workspace.
 *
 * These are large, regenerable, or contain machine-local metadata that would
 * break if relocated.
 */
const ISOLATION_COPY_SKIP_DIRECTORIES = new Set([
	".git", // Git metadata is handled by worktree/init logic, never copied blindly.
	".repo", // google-repo metadata; each sub-repo gets its own metadata handling.
	"node_modules",
	".next",
	".nuxt",
	".turbo",
	".parcel-cache",
	".svelte-kit",
	"dist",
	"build",
	"coverage",
	"target",
	"__pycache__",
	".venv",
	"venv",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".terraform",
	".gradle",
	".idea",
	".vscode",
	".DS_Store",
]);

/**
 * Files that may contain credentials or machine-specific secrets.
 *
 * Isolation must never silently duplicate secrets into a new location. These
 * are skipped by default; users who need them can still copy them manually.
 */
const ISOLATION_COPY_SKIP_FILES = new Set([
	".env",
	".env.local",
	".env.development",
	".env.development.local",
	".env.production",
	".env.production.local",
	".env.test",
	".env.test.local",
	".npmrc",
	".pypirc",
	".netrc",
	"_netrc",
	".git-credentials",
	".htpasswd",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	".pem",
	".key",
	".pfx",
	".p12",
]);

/**
 * Credential-ish path segments matched against any path segment.
 *
 * Matches both directories (`.ssh/`) and files (`credentials.json`,
 * `secret-key.pem`) so a nested credential file is excluded, not just a
 * credential *directory*.
 */
const ISOLATION_SECRET_PATH_PATTERN = /(^|\/)(secrets?|credentials?|\.ssh|\.aws|\.gnupg|\.docker)(\/|\.|$)/i;
const ISOLATION_CREDENTIAL_FILE_PATTERN = /(^|\/)(id_[a-z0-9]+|.*\.(pem|key|p12|pfx|keystore|jks))$/i;

const ISOLATION_LOCKFILE_NAME = "kanban-isolated-workspace.lock";
const MAX_ISOLATION_COPY_FILES = 200_000;
/** Cap on repository discovery inside a copied tree. */
const MAX_ISOLATED_REPOSITORY_SCAN = 2_000;

export interface IsolatedWorkspaceStrategy {
	kind: "git-worktree" | "directory-copy";
	/** The Git repository the worktree is created from, when applicable. */
	repositoryPath: string | null;
}

export interface IsolatedWorkspaceResult {
	ok: boolean;
	instance: RuntimeTaskWorkspaceInstance | null;
	error?: string;
	/** True when an existing isolated workspace was reused rather than recreated. */
	reused?: boolean;
}

function toPosix(path: string): string {
	return path.replaceAll("\\", "/");
}

function isSecretPath(relativePath: string): boolean {
	const normalized = toPosix(relativePath);
	const basename = normalized.split("/").at(-1) ?? "";
	if (ISOLATION_COPY_SKIP_FILES.has(basename)) {
		return true;
	}
	if (basename.startsWith(".env")) {
		return true;
	}
	if (ISOLATION_SECRET_PATH_PATTERN.test(normalized)) {
		return true;
	}
	return ISOLATION_CREDENTIAL_FILE_PATTERN.test(normalized);
}

function isSkippedDirectory(name: string): boolean {
	return ISOLATION_COPY_SKIP_DIRECTORIES.has(name);
}

function getIsolatedWorkspacePath(taskId: string, sourceRoot: string): string {
	const normalizedTaskId = normalizeTaskIdForWorktreePath(taskId);
	// Scope by project root hash so two projects with equal task IDs cannot collide.
	const rootHash = createHash("sha256").update(resolve(sourceRoot)).digest("hex").slice(0, 12);
	return join(getIsolatedWorkspacesRootPath(), `${normalizedTaskId}-${rootHash}`, "workspace");
}

function getIsolatedWorkspaceRootForTask(taskId: string, sourceRoot: string): string {
	return dirname(getIsolatedWorkspacePath(taskId, sourceRoot));
}

function getIsolatedWorkspaceLockRequest(taskId: string, sourceRoot: string): LockRequest {
	const root = getIsolatedWorkspaceRootForTask(taskId, sourceRoot);
	return {
		path: root,
		type: "directory",
		lockfileName: ISOLATION_LOCKFILE_NAME,
	};
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

async function assertNothingPointsBackToSource(options: {
	isolatedPath: string;
	sourceRoot: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
	// Walk the isolated tree looking for symlinks that escape into the source
	// workspace. A writable symlink back into the project root would silently
	// defeat isolation, so we refuse to use such a workspace.
	const stack: string[] = [options.isolatedPath];
	let visited = 0;
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			break;
		}
		visited += 1;
		if (visited > MAX_ISOLATION_COPY_FILES) {
			return {
				ok: false,
				reason:
					"Isolated workspace is larger than Kanban can verify for safety. Clean it up and use a narrower project root.",
			};
		}
		let entries: Array<{ name: string; isSymbolicLink: () => boolean; isDirectory: () => boolean }>;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const entryPath = join(current, entry.name);
			if (entry.isSymbolicLink()) {
				let target: string;
				try {
					target = await readFileLinkTarget(entryPath);
				} catch {
					continue;
				}
				const resolvedTarget = isAbsolute(target) ? resolve(target) : resolve(dirname(entryPath), target);
				if (isPathWithinRoot(options.sourceRoot, resolvedTarget)) {
					return {
						ok: false,
						reason: `Isolated workspace contains a symlink back into the source workspace (${entryPath}). Refusing to use it.`,
					};
				}
				continue;
			}
			if (entry.isDirectory()) {
				stack.push(entryPath);
			}
		}
	}
	return { ok: true };
}

async function readFileLinkTarget(path: string): Promise<string> {
	return await readlink(path);
}

interface CopyStats {
	fileCount: number;
	sizeBytes: number;
	skippedSecretPaths: number;
}

/**
 * Recursively copy a project directory into an isolated location.
 *
 * Preserves the relative structure by construction (a plain recursive copy),
 * and skips secrets and regenerable build output.
 */
async function copyWorkspaceTree(options: { sourceRoot: string; targetRoot: string }): Promise<CopyStats> {
	const stats: CopyStats = { fileCount: 0, sizeBytes: 0, skippedSecretPaths: 0 };

	const copyDirectory = async (
		sourceDirectory: string,
		targetDirectory: string,
		relativeDirectory: string,
	): Promise<void> => {
		await mkdir(targetDirectory, { recursive: true });
		let entries: Array<{
			name: string;
			isSymbolicLink: () => boolean;
			isDirectory: () => boolean;
			isFile: () => boolean;
		}>;
		try {
			entries = await readdir(sourceDirectory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (stats.fileCount > MAX_ISOLATION_COPY_FILES) {
				throw new Error(
					`Isolated workspace is too large to copy safely (more than ${MAX_ISOLATION_COPY_FILES} files). Narrow the project root or copy manually.`,
				);
			}
			const relativeChildPath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
			const sourcePath = join(sourceDirectory, entry.name);
			const targetPath = join(targetDirectory, entry.name);

			if (isSecretPath(relativeChildPath)) {
				stats.skippedSecretPaths += 1;
				continue;
			}

			if (entry.isSymbolicLink()) {
				// Recreate the link rather than following it. Never dereference, so a
				// link pointing outside the workspace does not get materialized.
				let linkTarget: string;
				try {
					linkTarget = await readFileLinkTarget(sourcePath);
				} catch {
					continue;
				}
				if (isAbsolute(linkTarget)) {
					stats.skippedSecretPaths += 1;
					continue;
				}
				await mkdir(dirname(targetPath), { recursive: true });
				await symlink(linkTarget, targetPath).catch(() => {});
				continue;
			}

			if (entry.isDirectory()) {
				if (isSkippedDirectory(entry.name)) {
					continue;
				}
				await copyDirectory(sourcePath, targetPath, relativeChildPath);
				continue;
			}

			if (!entry.isFile()) {
				continue;
			}

			try {
				await cp(sourcePath, targetPath, { force: true });
				const fileStat = await stat(targetPath);
				stats.fileCount += 1;
				stats.sizeBytes += fileStat.size;
			} catch {
				// Unreadable individual files should not abort the whole isolation.
			}
		}
	};

	await copyDirectory(options.sourceRoot, options.targetRoot, "");
	return stats;
}

/**
 * Prepare Git metadata inside an isolated copy of a Git repository.
 *
 * The copied `.git` directory contains absolute paths pointing at the source
 * repository. Copying it verbatim would make Git operations inside the isolated
 * workspace mutate the source repository's index/branch state. Re-initializing
 * with a fresh repository plus the source's commit objects keeps history
 * available without sharing mutable state.
 */
async function initializeIsolatedGitRepository(options: {
	sourceRepository: string;
	isolatedRepository: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
	const headInfo = await readGitHeadInfo(options.sourceRepository);
	const initResult = await runGit(options.isolatedRepository, ["init", "--quiet"]);
	if (!initResult.ok) {
		return {
			ok: false,
			reason: `Could not initialize Git metadata in the isolated workspace. ${initResult.error ?? ""}`.trim(),
		};
	}
	if (!headInfo.headCommit) {
		// No commits to seed; an empty repository is still a valid isolated place to work.
		return { ok: true };
	}
	const sourceGitDir = await runGit(options.sourceRepository, ["rev-parse", "--absolute-git-dir"]);
	if (!sourceGitDir.ok || !sourceGitDir.stdout) {
		return { ok: false, reason: "Could not resolve the source repository's Git directory." };
	}
	// Point the isolated repository at the source object database read-only.
	// Objects are immutable, so sharing them cannot corrupt the source repo,
	// and `core.worktree` stays local to the isolated clone.
	const alternatesPath = join(options.isolatedRepository, ".git", "objects", "info", "alternates");
	await mkdir(dirname(alternatesPath), { recursive: true });
	await lockedFileSystem.writeTextFileAtomic(alternatesPath, `${join(sourceGitDir.stdout, "objects")}\n`, {
		lock: null,
	});
	const resetResult = await runGit(options.isolatedRepository, ["reset", "--soft", headInfo.headCommit]);
	if (!resetResult.ok) {
		// History sharing failed; fall back to a plain initialized repository so the
		// agent can still work (it just will not see upstream history).
		return { ok: true };
	}
	await runGit(options.isolatedRepository, ["checkout", "--force", headInfo.headCommit]);
	return { ok: true };
}

async function getDirectorySize(path: string): Promise<{ fileCount: number; sizeBytes: number } | null> {
	try {
		let fileCount = 0;
		let sizeBytes = 0;
		const stack = [path];
		while (stack.length > 0) {
			const current = stack.pop();
			if (!current) {
				break;
			}
			const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
			for (const entry of entries) {
				const entryPath = join(current, entry.name);
				if (entry.isDirectory()) {
					stack.push(entryPath);
					continue;
				}
				if (!entry.isFile()) {
					continue;
				}
				const fileStat = await stat(entryPath).catch(() => null);
				if (!fileStat) {
					continue;
				}
				fileCount += 1;
				sizeBytes += fileStat.size;
			}
		}
		return { fileCount, sizeBytes };
	} catch {
		return null;
	}
}

export interface CreateIsolatedWorkspaceOptions {
	taskId: string;
	sourceRoot: string;
	workspaceId: string;
	baseRef: string;
}

/**
 * Create (or reuse) an isolated workspace for one task.
 *
 * Returns an explicit failure instead of falling back to direct mode when
 * isolation cannot be created, so a task never silently runs against the user's
 * real files.
 */
export async function createOrReuseIsolatedWorkspace(
	options: CreateIsolatedWorkspaceOptions,
): Promise<IsolatedWorkspaceResult> {
	const sourceRoot = resolve(options.sourceRoot);
	const isolatedPath = getIsolatedWorkspacePath(options.taskId, sourceRoot);

	try {
		return await lockedFileSystem.withLock(getIsolatedWorkspaceLockRequest(options.taskId, sourceRoot), async () => {
			if (await pathExists(isolatedPath)) {
				const safety = await assertNothingPointsBackToSource({ isolatedPath, sourceRoot });
				if (!safety.ok) {
					return { ok: false, instance: null, error: safety.reason };
				}
				// A workspace created before snapshots existed (or restored from disk) still
				// needs a baseline for review and apply to work.
				if (!(await hasTaskSnapshot(options.taskId, sourceRoot))) {
					const existingDiscovery = await loadWorkspaceDiscovery(options.workspaceId, sourceRoot);
					if (existingDiscovery.workspaceType === "none") {
						await captureTaskSnapshot({
							taskId: options.taskId,
							workspacePath: sourceRoot,
							sourcePath: isolatedPath,
						});
					}
				}
				return {
					ok: true,
					reused: true,
					instance: await buildInstance({
						taskId: options.taskId,
						sourceRoot,
						isolatedPath,
						mode: "isolated",
						workspaceType: null,
					}),
				};
			}

			await mkdir(dirname(isolatedPath), { recursive: true });

			const discovery = await loadWorkspaceDiscovery(options.workspaceId, sourceRoot, { force: true });
			const strategy = resolveIsolationStrategy(discovery.workspaceType, discovery.repositories, sourceRoot);

			if (strategy.kind === "git-worktree" && strategy.repositoryPath) {
				const worktreeResult = await createGitWorktreeIsolation({
					repositoryPath: strategy.repositoryPath,
					isolatedPath,
					baseRef: options.baseRef,
				});
				if (!worktreeResult.ok) {
					return { ok: false, instance: null, error: worktreeResult.error };
				}
			} else {
				await createDirectoryCopyIsolation({
					sourceRoot,
					isolatedPath,
					workspaceType: discovery.workspaceType,
				});
			}

			const safety = await assertNothingPointsBackToSource({ isolatedPath, sourceRoot });
			if (!safety.ok) {
				await rm(isolatedPath, { recursive: true, force: true }).catch(() => {});
				return { ok: false, instance: null, error: safety.reason };
			}

			/*
				Non-Git projects have no version-control baseline, so review and apply
				need one captured explicitly. Snapshotting the isolated copy (a faithful
				copy of the source) gives later diffs something to compare against while
				keeping the source workspace untouched.
			*/
			if (discovery.workspaceType === "none") {
				await captureTaskSnapshot({
					taskId: options.taskId,
					workspacePath: sourceRoot,
					sourcePath: isolatedPath,
				});
			}

			return {
				ok: true,
				reused: false,
				instance: await buildInstance({
					taskId: options.taskId,
					sourceRoot,
					isolatedPath,
					mode: "isolated",
					workspaceType: discovery.workspaceType,
				}),
			};
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			instance: null,
			error: `Could not create an isolated workspace: ${message}`,
		};
	}
}

function resolveIsolationStrategy(
	workspaceType: RuntimeWorkspaceType,
	repositories: Array<{ relativePath: string; workTreePath: string; isRoot: boolean }>,
	sourceRoot: string,
): IsolatedWorkspaceStrategy {
	if (workspaceType === "git") {
		const rootRepository = repositories.find((repository) => repository.isRoot) ?? repositories[0];
		return {
			kind: rootRepository ? "git-worktree" : "directory-copy",
			repositoryPath: rootRepository ? rootRepository.workTreePath : null,
		};
	}
	void sourceRoot;
	// `multi-git` and `google-repo` keep the same relative structure by copying,
	// which is what makes cross-repository isolation meaningful.
	return {
		kind: "directory-copy",
		repositoryPath: null,
	};
}

async function createGitWorktreeIsolation(options: {
	repositoryPath: string;
	isolatedPath: string;
	baseRef: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
	const baseRef = options.baseRef.trim();
	const resolveRef = async (): Promise<string | null> => {
		if (baseRef) {
			const requested = await runGit(options.repositoryPath, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
			if (requested.ok && requested.stdout) {
				return requested.stdout;
			}
		}
		const head = await runGit(options.repositoryPath, ["rev-parse", "--verify", "HEAD"]);
		return head.ok && head.stdout ? head.stdout : null;
	};

	const baseCommit = await resolveRef();
	if (!baseCommit) {
		return {
			ok: false,
			error: `Cannot create an isolated workspace: "${baseRef || "HEAD"}" does not resolve to a commit in ${options.repositoryPath}. Create an initial commit, then retry.`,
		};
	}

	await mkdir(dirname(options.isolatedPath), { recursive: true });
	// Prune stale registrations so a half-removed worktree does not block creation.
	await runGit(options.repositoryPath, ["worktree", "prune"]);
	const addResult = await runGit(options.repositoryPath, [
		"worktree",
		"add",
		"--detach",
		options.isolatedPath,
		baseCommit,
	]);
	if (addResult.ok) {
		return { ok: true };
	}

	// Fall back to a directory copy plus a fresh local Git repo. This keeps the
	// task runnable (e.g. when the source repository is in a state that refuses
	// new worktrees) without ever writing into the source workspace.
	try {
		await rm(options.isolatedPath, { recursive: true, force: true });
		await copyWorkspaceTree({
			sourceRoot: options.repositoryPath,
			targetRoot: options.isolatedPath,
		});
		const initResult = await initializeIsolatedGitRepository({
			sourceRepository: options.repositoryPath,
			isolatedRepository: options.isolatedPath,
		});
		if (!initResult.ok) {
			await rm(options.isolatedPath, { recursive: true, force: true }).catch(() => {});
			return {
				ok: false,
				error: `Could not create an isolated workspace. ${addResult.error ?? ""} ${initResult.reason}`.trim(),
			};
		}
		return { ok: true };
	} catch (error) {
		await rm(options.isolatedPath, { recursive: true, force: true }).catch(() => {});
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: `Could not create an isolated workspace. ${addResult.error ?? message}`.trim(),
		};
	}
}

async function createDirectoryCopyIsolation(options: {
	sourceRoot: string;
	isolatedPath: string;
	workspaceType: RuntimeWorkspaceType;
}): Promise<void> {
	await copyWorkspaceTree({
		sourceRoot: options.sourceRoot,
		targetRoot: options.isolatedPath,
	});

	// The copy intentionally omits `.git` directories. Re-create local Git
	// metadata for every source repository that had it, so agents working in a
	// multi-repository (or `google-repo`) workspace still get version control
	// without the isolated workspace being able to touch the source repositories.
	if (options.workspaceType !== "none") {
		const sourceRepositories = await findGitRepositoryDirectories(options.sourceRoot);
		for (const sourceRepository of sourceRepositories) {
			const relativePath = relative(options.sourceRoot, sourceRepository);
			const isolatedRepository = join(options.isolatedPath, relativePath);
			if (!(await pathExists(isolatedRepository))) {
				continue;
			}
			await initializeIsolatedGitRepository({
				sourceRepository,
				isolatedRepository,
			});
		}
	}
}

/**
 * Find directories inside `root` that are Git repository roots.
 *
 * Used to mirror Git metadata into an isolated copy. Stops descending once a
 * repository root is found, since a repository owns everything beneath it.
 */
async function findGitRepositoryDirectories(root: string): Promise<string[]> {
	const repositories: string[] = [];
	const stack: string[] = [root];
	let visited = 0;
	while (stack.length > 0) {
		if (visited > MAX_ISOLATED_REPOSITORY_SCAN) {
			break;
		}
		const current = stack.pop();
		if (!current) {
			break;
		}
		visited += 1;
		if (current !== root && (await isGitRepositoryRoot(current))) {
			repositories.push(current);
			continue;
		}
		const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.isSymbolicLink()) {
				continue;
			}
			if (entry.name.startsWith(".") || isSkippedDirectory(entry.name)) {
				continue;
			}
			stack.push(join(current, entry.name));
		}
	}
	return repositories;
}

async function isGitRepositoryRoot(path: string): Promise<boolean> {
	try {
		const gitEntryStat = await lstat(join(path, ".git"));
		return gitEntryStat.isDirectory() || gitEntryStat.isFile();
	} catch {
		return false;
	}
}

async function buildInstance(options: {
	taskId: string;
	sourceRoot: string;
	isolatedPath: string;
	mode: RuntimeTaskExecutionMode;
	workspaceType: RuntimeWorkspaceType | null;
}): Promise<RuntimeTaskWorkspaceInstance> {
	const exists = await pathExists(options.isolatedPath);
	const size = exists ? await getDirectorySize(options.isolatedPath) : null;
	const createdStat = exists ? await stat(options.isolatedPath).catch(() => null) : null;
	return {
		taskId: options.taskId,
		mode: options.mode,
		sourceRoot: options.sourceRoot,
		workingDirectory: options.isolatedPath,
		isolatedPath: options.isolatedPath,
		exists,
		fileCount: size?.fileCount ?? null,
		sizeBytes: size?.sizeBytes ?? null,
		createdAt: createdStat?.birthtimeMs ?? createdStat?.mtimeMs ?? null,
		unavailableReason: null,
	};
}

/** Describe the working directory a task will actually use, without creating it. */
export async function describeTaskWorkspaceInstance(options: {
	taskId: string;
	sourceRoot: string;
	mode: RuntimeTaskExecutionMode;
	workspaceId: string;
}): Promise<RuntimeTaskWorkspaceInstance> {
	const sourceRoot = resolve(options.sourceRoot);
	if (options.mode === "direct") {
		return {
			taskId: options.taskId,
			mode: "direct",
			sourceRoot,
			workingDirectory: sourceRoot,
			isolatedPath: null,
			exists: true,
			fileCount: null,
			sizeBytes: null,
			createdAt: null,
			unavailableReason: null,
		};
	}
	const isolatedPath = getIsolatedWorkspacePath(options.taskId, sourceRoot);
	const exists = await pathExists(isolatedPath);
	const size = exists ? await getDirectorySize(isolatedPath) : null;
	return {
		taskId: options.taskId,
		mode: "isolated",
		sourceRoot,
		workingDirectory: isolatedPath,
		isolatedPath,
		exists,
		fileCount: size?.fileCount ?? null,
		sizeBytes: size?.sizeBytes ?? null,
		createdAt: null,
		unavailableReason: null,
	};
}

/**
 * Remove an isolated workspace for a task.
 *
 * Refuses to delete when the isolated directory contains unmerged file changes
 * unless `force` is set, so cleanup cannot silently discard agent work.
 */
export async function cleanupIsolatedWorkspace(options: {
	taskId: string;
	sourceRoot: string;
	force?: boolean;
}): Promise<{ ok: boolean; removed: boolean; refusedReason?: string; error?: string }> {
	const sourceRoot = resolve(options.sourceRoot);
	const isolatedPath = getIsolatedWorkspacePath(options.taskId, sourceRoot);
	try {
		return await lockedFileSystem.withLock(getIsolatedWorkspaceLockRequest(options.taskId, sourceRoot), async () => {
			if (!(await pathExists(isolatedPath))) {
				return { ok: true, removed: false };
			}
			if (!options.force) {
				const hasChanges = await isolatedWorkspaceHasChanges(isolatedPath);
				if (hasChanges) {
					return {
						ok: false,
						removed: false,
						refusedReason:
							"This isolated workspace has changes that have not been applied to the source project. Apply or discard them, or clean up with force.",
					};
				}
			}
			const registeredWorktree = await isRegisteredGitWorktree(isolatedPath);
			if (registeredWorktree) {
				await runGit(registeredWorktree.repositoryPath, ["worktree", "remove", "--force", isolatedPath]);
				await runGit(registeredWorktree.repositoryPath, ["worktree", "prune"]);
			}
			await rm(isolatedPath, { recursive: true, force: true });
			await rm(dirname(isolatedPath), { recursive: true, force: true }).catch(() => {});
			return { ok: true, removed: true };
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, removed: false, error: message };
	}
}

async function isRegisteredGitWorktree(isolatedPath: string): Promise<{ repositoryPath: string } | null> {
	// A worktree created by `git worktree add` has a `.git` *file* pointing at the
	// owning repository. Reading it lets us deregister cleanly instead of leaving
	// a stale entry behind in the source repository.
	const gitEntry = join(isolatedPath, ".git");
	let content: string;
	try {
		content = await readFile(gitEntry, "utf8");
	} catch {
		return null;
	}
	const match = /^gitdir:\s*(.+)$/m.exec(content);
	if (!match?.[1]) {
		return null;
	}
	const gitDir = match[1].trim();
	const commonDir = join(gitDir, "..", "..");
	return {
		repositoryPath: resolve(commonDir),
	};
}

async function isolatedWorkspaceHasChanges(isolatedPath: string): Promise<boolean> {
	const gitEntry = join(isolatedPath, ".git");
	if (await pathExists(gitEntry)) {
		const status = await runGit(isolatedPath, ["status", "--porcelain"]);
		if (status.ok && status.stdout.trim().length > 0) {
			return true;
		}
		const untracked = await runGit(isolatedPath, ["ls-files", "--others", "--exclude-standard"]);
		if (untracked.ok && untracked.stdout.trim().length > 0) {
			return true;
		}
		// An isolated worktree with only a detached HEAD and no changes is safe.
		return false;
	}
	// Non-Git isolation: treat any non-empty tree containing files newer than the
	// directory creation as "has changes". Being conservative here errs toward
	// refusing deletion rather than losing work.
	const size = await getDirectorySize(isolatedPath);
	return (size?.fileCount ?? 0) > 0;
}

/** Return the working directory for a task, creating the isolated copy if needed. */
export async function resolveTaskWorkingDirectory(options: {
	taskId: string;
	sourceRoot: string;
	workspaceId: string;
	baseRef: string;
	mode: RuntimeTaskExecutionMode;
}): Promise<IsolatedWorkspaceResult> {
	if (options.mode === "direct") {
		return {
			ok: true,
			instance: await describeTaskWorkspaceInstance({
				taskId: options.taskId,
				sourceRoot: options.sourceRoot,
				mode: "direct",
				workspaceId: options.workspaceId,
			}),
		};
	}
	return await createOrReuseIsolatedWorkspace({
		taskId: options.taskId,
		sourceRoot: options.sourceRoot,
		workspaceId: options.workspaceId,
		baseRef: options.baseRef,
	});
}

/** Root directory that holds every isolated workspace for a source project. */
export function getIsolatedWorkspacesRootForSource(sourceRoot: string): string {
	void sourceRoot;
	return getIsolatedWorkspacesRootPath();
}

/** Re-exported for callers that need to keep isolated dirs inside Kanban's home. */
export function isPathInsideKanbanHome(path: string): boolean {
	return (
		isPathWithinRoot(getRuntimeHomePath(), path) ||
		isPathWithinRoot(getTaskWorktreesHomePath(), path) ||
		isPathWithinRoot(getIsolatedWorkspacesRootPath(), path)
	);
}

export { getIsolatedWorkspacePath };
