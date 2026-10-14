// Detects what kind of workspace a project root is.
//
// This module exists so Kanban can treat "Git repository" as an optional
// capability instead of a precondition. Project creation must never fail
// because discovery failed, so every entry point here is total: it returns a
// conservative `none` result instead of throwing.
//
// Discovery never changes the project root. It only reports what lives under
// the root that the user explicitly selected.
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { RuntimeWorkspaceType } from "../core/api-contract";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath } from "../state/runtime-paths";
import { runGit } from "./git-utils";

/** Bounded scan so a huge parent directory cannot stall project creation. */
const MAX_REPOSITORY_SCAN_ENTRIES = 512;
const MAX_REPOSITORY_SCAN_DEPTH = 2;
/** Directories that never contain a project sub-repository we care about. */
const REPOSITORY_SCAN_SKIP_DIRECTORIES = new Set([
	".git",
	".repo",
	".svn",
	".hg",
	"node_modules",
	".next",
	".turbo",
	"dist",
	"build",
	"coverage",
	"target",
	"vendor",
	"__pycache__",
	".venv",
	"venv",
]);
const DISCOVERY_CACHE_FILENAME = "discovery.json";

export interface DiscoveredRepository {
	/** Path relative to the project root, using POSIX separators. Empty string for the root itself. */
	relativePath: string;
	/** Absolute path to the repository work tree root. */
	workTreePath: string;
	/** Value of `git rev-parse --absolute-git-dir`, when resolvable. */
	gitDirPath: string | null;
	/** True when this repository is the project root itself. */
	isRoot: boolean;
}

export interface WorkspaceDiscoveryResult {
	workspaceType: RuntimeWorkspaceType;
	/** Absolute, resolved project root. Always the user-selected directory. */
	rootPath: string;
	repositories: DiscoveredRepository[];
	/** Sub-project paths from a Google `repo` manifest, when present. */
	repoManifestProjects: string[];
	/** Path to the manifest used for discovery, when present. */
	repoManifestPath: string | null;
	/** Non-null when discovery degraded to a best-effort result. */
	warning: string | null;
	discoveredAt: number;
}

export interface RuntimeWorkspaceDiscoverySnapshot {
	workspaceType: RuntimeWorkspaceType;
	repositories: Array<{
		relativePath: string;
		workTreePath: string;
		isRoot: boolean;
	}>;
	repoManifestProjects: string[];
	repoManifestPath: string | null;
	warning: string | null;
	discoveredAt: number;
}

/** Records a user override so a wrong detection can be corrected or disabled. */
export interface WorkspaceDiscoveryOverride {
	workspaceType: RuntimeWorkspaceType;
	gitIntegrationEnabled: boolean;
	updatedAt: number;
}

interface WorkspaceDiscoveryFile {
	version: number;
	discoveredAt: number;
	workspaceType: RuntimeWorkspaceType;
	rootPath: string;
	repositories: DiscoveredRepository[];
	repoManifestProjects: string[];
	repoManifestPath: string | null;
	warning: string | null;
	override?: WorkspaceDiscoveryOverride;
}

const DISCOVERY_FILE_VERSION = 1;

function toPosixRelativePath(relativePath: string): string {
	return relativePath
		.replaceAll("\\", "/")
		.replace(/^\.\/+/, "")
		.replace(/\/+$/, "");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Detect whether `path` is a Git work tree root.
 *
 * Handles the three shapes Git metadata can take:
 * - `<dir>/.git` as a directory (normal clone)
 * - `<dir>/.git` as a file (worktree / submodule pointer)
 * - `<dir>` itself being a bare or separate-git-dir repository
 */
export async function isGitWorkTreeRoot(path: string): Promise<boolean> {
	const gitEntry = join(path, ".git");
	if (await pathExists(gitEntry)) {
		return true;
	}
	// `--is-inside-work-tree` covers separate-git-dir layouts where `.git` is absent.
	const result = await runGit(path, ["rev-parse", "--is-inside-work-tree"]);
	if (!result.ok || result.stdout.trim() !== "true") {
		return false;
	}
	const toplevel = await runGit(path, ["rev-parse", "--show-toplevel"]);
	if (!toplevel.ok || !toplevel.stdout) {
		return false;
	}
	return resolve(toplevel.stdout) === resolve(path);
}

async function resolveGitDirPath(workTreePath: string): Promise<string | null> {
	const result = await runGit(workTreePath, ["rev-parse", "--absolute-git-dir"]);
	if (!result.ok || !result.stdout) {
		return null;
	}
	return resolve(result.stdout);
}

/**
 * Resolve the full Git root that contains `cwd`, if any.
 *
 * Unlike `isGitWorkTreeRoot`, this walks upward, which is what we want when the
 * user picks a subdirectory of a repository as a project root.
 */
export async function resolveContainingGitRoot(cwd: string): Promise<string | null> {
	const result = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!result.ok || !result.stdout) {
		return null;
	}
	return resolve(result.stdout);
}

async function collectRepositories(
	rootPath: string,
): Promise<{ repositories: DiscoveredRepository[]; truncated: boolean }> {
	const repositories: DiscoveredRepository[] = [];
	let visited = 0;
	let truncated = false;

	const addRepository = async (absolutePath: string, relativePath: string): Promise<boolean> => {
		if (repositories.some((repository) => repository.workTreePath === absolutePath)) {
			return false;
		}
		repositories.push({
			relativePath: toPosixRelativePath(relativePath),
			workTreePath: absolutePath,
			gitDirPath: await resolveGitDirPath(absolutePath),
			isRoot: relativePath === "",
		});
		return true;
	};

	if (await isGitWorkTreeRoot(rootPath)) {
		await addRepository(rootPath, "");
		// A repository root owns its own nested metadata; stop scanning so we do
		// not report submodule checkouts or vendored repositories as separate
		// repositories of this project.
		return { repositories, truncated: false };
	}

	const scan = async (currentPath: string, relativePath: string, depth: number): Promise<void> => {
		if (depth > MAX_REPOSITORY_SCAN_DEPTH || truncated) {
			return;
		}
		let entries: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>;
		try {
			entries = await readdir(currentPath, { withFileTypes: true });
		} catch {
			return;
		}
		const candidateDirectories: Array<{ name: string; absolutePath: string; relativeChildPath: string }> = [];
		for (const entry of entries) {
			if (visited >= MAX_REPOSITORY_SCAN_ENTRIES) {
				truncated = true;
				return;
			}
			if (entry.isSymbolicLink() || !entry.isDirectory()) {
				continue;
			}
			if (REPOSITORY_SCAN_SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) {
				continue;
			}
			visited += 1;
			candidateDirectories.push({
				name: entry.name,
				absolutePath: join(currentPath, entry.name),
				relativeChildPath: relativePath ? `${relativePath}/${entry.name}` : entry.name,
			});
		}

		for (const candidate of candidateDirectories) {
			if (await isGitWorkTreeRoot(candidate.absolutePath)) {
				await addRepository(candidate.absolutePath, candidate.relativeChildPath);
				// Do not descend into a repository we already claimed.
				continue;
			}
			await scan(candidate.absolutePath, candidate.relativeChildPath, depth + 1);
		}
	};

	await scan(rootPath, "", 1);
	repositories.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
	return { repositories, truncated };
}

/**
 * Parse `<project path="..."/>` entries from a Google `repo` manifest.
 *
 * Deliberately a narrow line scan rather than a YAML parse: manifests are large
 * and we only need the attribute we care about. Whatever a real manifest looks
 * like, failing to parse simply means we fall back to filesystem discovery.
 */
export function parseRepoManifestProjectPaths(manifestContent: string): string[] {
	const projectPaths: string[] = [];
	const seen = new Set<string>();
	const projectTagPattern = /<project\b[^>]*>/g;
	const pathAttributePattern = /\bpath\s*=\s*"([^"]*)"|\bpath\s*=\s*'([^']*)'/;
	for (const tag of manifestContent.match(projectTagPattern) ?? []) {
		const match = pathAttributePattern.exec(tag);
		const rawPath = (match?.[1] ?? match?.[2] ?? "").trim();
		if (!rawPath) {
			continue;
		}
		const normalized = toPosixRelativePath(rawPath);
		if (!normalized || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		projectPaths.push(normalized);
	}
	return projectPaths;
}

interface RepoManifestResolution {
	manifestPath: string;
	projects: string[];
}

async function readRepoManifest(rootPath: string): Promise<RepoManifestResolution | null> {
	const manifestPath = join(rootPath, ".repo", "manifests", "default.xml");
	try {
		const content = await readFile(manifestPath, "utf8");
		return {
			manifestPath,
			projects: parseRepoManifestProjectPaths(content),
		};
	} catch {
		return null;
	}
}

/**
 * Locate the `.git` directory for a repository that lives inside a
 * `google-repo` checkout, so callers can inspect its HEAD.
 */
async function resolveRepoProjectGitDir(rootPath: string, projectPath: string): Promise<string | null> {
	const projectGitPath = join(rootPath, projectPath, ".git");
	const projectGitStat = await stat(projectGitPath).catch(() => null);
	if (!projectGitStat) {
		return null;
	}
	if (projectGitStat.isDirectory()) {
		return projectGitPath;
	}
	try {
		const content = await readFile(projectGitPath, "utf8");
		const match = /^gitdir:\s*(.+)$/m.exec(content);
		if (!match?.[1]) {
			return null;
		}
		const gitDir = match[1].trim();
		return resolve(rootPath, projectPath, gitDir);
	} catch {
		return null;
	}
}

export interface DiscoverWorkspaceOptions {
	/** Skip the on-disk cache and rescan. */
	force?: boolean;
}

function getWorkspaceDiscoveryPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), DISCOVERY_CACHE_FILENAME);
}

export interface WorkspaceDiscoveryOverrideState {
	overridden: boolean;
	gitIntegrationEnabled: boolean;
}

/** Read whether the user has overridden detection for this workspace. */
export async function loadWorkspaceDiscoveryOverrideState(
	workspaceId: string,
): Promise<WorkspaceDiscoveryOverrideState | null> {
	const file = await readDiscoveryFile(workspaceId);
	if (!file) {
		return null;
	}
	return {
		overridden: file.override !== undefined,
		gitIntegrationEnabled: file.override?.gitIntegrationEnabled ?? true,
	};
}

/** Remove any user override so the next load re-detects from the filesystem. */
export async function clearWorkspaceDiscoveryOverride(workspaceId: string): Promise<void> {
	const file = await readDiscoveryFile(workspaceId);
	if (!file?.override) {
		return;
	}
	const { override: _override, ...rest } = file;
	await writeDiscoveryFile(workspaceId, rest as WorkspaceDiscoveryFile);
}

function getWorkspaceDiscoveryLockRequest(workspaceId: string): LockRequest {
	return {
		path: getWorkspaceDiscoveryPath(workspaceId),
		type: "file",
	};
}

async function readDiscoveryFile(workspaceId: string): Promise<WorkspaceDiscoveryFile | null> {
	try {
		const raw = await readFile(getWorkspaceDiscoveryPath(workspaceId), "utf8");
		const parsed = JSON.parse(raw) as WorkspaceDiscoveryFile;
		if (parsed.version !== DISCOVERY_FILE_VERSION) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

async function writeDiscoveryFile(workspaceId: string, payload: WorkspaceDiscoveryFile): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getWorkspaceDiscoveryPath(workspaceId), payload, {
		lock: null,
	});
}

/**
 * Run discovery for a project root.
 *
 * Never throws: a failure to inspect the filesystem degrades to `none` with a
 * warning so that project creation, board operations, and task execution keep
 * working.
 */
export async function discoverWorkspaceType(rootPath: string): Promise<WorkspaceDiscoveryResult> {
	const resolvedRoot = resolve(rootPath);
	const discoveredAt = Date.now();

	try {
		const manifest = await readRepoManifest(resolvedRoot);
		if (manifest) {
			const repositories: DiscoveredRepository[] = [];
			for (const projectPath of manifest.projects) {
				const workTreePath = join(resolvedRoot, projectPath);
				if (!(await isDirectory(workTreePath))) {
					continue;
				}
				repositories.push({
					relativePath: projectPath,
					workTreePath,
					gitDirPath: await resolveRepoProjectGitDir(resolvedRoot, projectPath),
					isRoot: false,
				});
			}
			return {
				workspaceType: "google-repo",
				rootPath: resolvedRoot,
				repositories,
				repoManifestProjects: manifest.projects,
				repoManifestPath: manifest.manifestPath,
				warning: null,
				discoveredAt,
			};
		}

		const { repositories, truncated } = await collectRepositories(resolvedRoot);
		const rootRepository = repositories.find((repository) => repository.isRoot);
		if (rootRepository) {
			return {
				workspaceType: "git",
				rootPath: resolvedRoot,
				repositories: [rootRepository],
				repoManifestProjects: [],
				repoManifestPath: null,
				warning: null,
				discoveredAt,
			};
		}
		if (repositories.length === 1) {
			return {
				workspaceType: "git",
				rootPath: resolvedRoot,
				repositories,
				repoManifestProjects: [],
				repoManifestPath: null,
				warning: null,
				discoveredAt,
			};
		}
		if (repositories.length > 1) {
			return {
				workspaceType: "multi-git",
				rootPath: resolvedRoot,
				repositories,
				repoManifestProjects: [],
				repoManifestPath: null,
				warning: truncated
					? "Repository discovery stopped early because this folder contains many entries. Refreshing discovery after narrowing the project root can find more repositories."
					: null,
				discoveredAt,
			};
		}
		return {
			workspaceType: "none",
			rootPath: resolvedRoot,
			repositories: [],
			repoManifestProjects: [],
			repoManifestPath: null,
			warning: null,
			discoveredAt,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			workspaceType: "none",
			rootPath: resolvedRoot,
			repositories: [],
			repoManifestProjects: [],
			repoManifestPath: null,
			warning: `Workspace detection failed, so Git features are disabled for this project. ${message}`,
			discoveredAt,
		};
	}
}

/**
 * Load discovery for a workspace, using the cached result unless `force` is set.
 *
 * The cache keeps project creation cheap on large trees and lets Project
 * Settings show the last known result without rescanning.
 */
export async function loadWorkspaceDiscovery(
	workspaceId: string,
	rootPath: string,
	options: DiscoverWorkspaceOptions = {},
): Promise<WorkspaceDiscoveryResult> {
	try {
		const cached = options.force ? null : await readDiscoveryFile(workspaceId);
		if (cached && resolve(cached.rootPath) === resolve(rootPath)) {
			return {
				workspaceType: cached.override?.workspaceType ?? cached.workspaceType,
				rootPath: cached.rootPath,
				repositories: cached.override?.gitIntegrationEnabled === false ? [] : cached.repositories,
				repoManifestProjects: cached.repoManifestProjects,
				repoManifestPath: cached.repoManifestPath,
				warning: cached.warning,
				discoveredAt: cached.discoveredAt,
			};
		}
		const result = await discoverWorkspaceType(rootPath);
		await saveWorkspaceDiscovery(
			workspaceId,
			result,
			options.force ? await readDiscoveryOverride(workspaceId) : undefined,
		);
		return result;
	} catch {
		// Cache I/O must never block workspace loading.
		return await discoverWorkspaceType(rootPath);
	}
}

async function readDiscoveryOverride(workspaceId: string): Promise<WorkspaceDiscoveryOverride | undefined> {
	const file = await readDiscoveryFile(workspaceId);
	return file?.override;
}

export async function saveWorkspaceDiscovery(
	workspaceId: string,
	result: WorkspaceDiscoveryResult,
	override?: WorkspaceDiscoveryOverride,
): Promise<void> {
	try {
		await lockedFileSystem.withLock(getWorkspaceDiscoveryLockRequest(workspaceId), async () => {
			const existing = await readDiscoveryFile(workspaceId);
			const payload: WorkspaceDiscoveryFile = {
				version: DISCOVERY_FILE_VERSION,
				discoveredAt: result.discoveredAt,
				workspaceType: result.workspaceType,
				rootPath: result.rootPath,
				repositories: result.repositories,
				repoManifestProjects: result.repoManifestProjects,
				repoManifestPath: result.repoManifestPath,
				warning: result.warning,
				...((override ?? existing?.override) ? { override: override ?? existing?.override } : {}),
			};
			await writeDiscoveryFile(workspaceId, payload);
		});
	} catch {
		// Best effort: discovery results are a cache, not a source of truth.
	}
}

/**
 * Persist a user-selected override for the detected workspace type.
 *
 * This is the escape hatch for "detection was wrong" without forcing the user
 * to reorganize their folders.
 */
export async function setWorkspaceDiscoveryOverride(
	workspaceId: string,
	rootPath: string,
	override: WorkspaceDiscoveryOverride,
): Promise<WorkspaceDiscoveryResult> {
	const current = await loadWorkspaceDiscovery(workspaceId, rootPath);
	await saveWorkspaceDiscovery(workspaceId, current, override);
	return await loadWorkspaceDiscovery(workspaceId, rootPath, { force: false });
}

export async function removeWorkspaceDiscovery(workspaceId: string): Promise<void> {
	try {
		await lockedFileSystem.removePath(getWorkspaceDiscoveryPath(workspaceId), {
			lock: getWorkspaceDiscoveryLockRequest(workspaceId),
			force: true,
		});
	} catch {
		// Best effort cleanup.
	}
}

export function toWorkspaceDiscoverySnapshot(result: WorkspaceDiscoveryResult): RuntimeWorkspaceDiscoverySnapshot {
	return {
		workspaceType: result.workspaceType,
		repositories: result.repositories.map((repository) => ({
			relativePath: repository.relativePath,
			workTreePath: repository.workTreePath,
			isRoot: repository.isRoot,
		})),
		repoManifestProjects: result.repoManifestProjects,
		repoManifestPath: result.repoManifestPath,
		warning: result.warning,
		discoveredAt: result.discoveredAt,
	};
}

/**
 * Whether the project root itself is a Git repository.
 *
 * Only then is the existing task-worktree machinery applicable, because it
 * creates worktrees from the repository at the project root. A project that
 * merely *contains* a repository needs the generic isolation path instead.
 */
export function hasRootGitRepository(result: WorkspaceDiscoveryResult): boolean {
	return result.workspaceType === "git" && result.repositories.some((repository) => repository.isRoot);
}

/** True when the workspace should expose Git-backed features at all. */
export function hasGitCapability(result: WorkspaceDiscoveryResult): boolean {
	return result.workspaceType === "git";
}
