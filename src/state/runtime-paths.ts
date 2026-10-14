// Canonical locations for Kanban-owned state on disk.
//
// Kept in its own module so low-level helpers (workspace discovery, isolated
// workspaces, task worktrees) can resolve paths without importing the
// workspace-state module, which would create an import cycle.
import { homedir } from "node:os";
import { join } from "node:path";

export const RUNTIME_HOME_PARENT_DIR = ".cline";
export const RUNTIME_HOME_DIR = "kanban";
export const RUNTIME_WORKTREES_DIR = "worktrees";
export const WORKSPACES_DIR = "workspaces";
export const ISOLATED_WORKSPACES_DIR = "isolated-workspaces";

export const BOARD_FILENAME = "board.json";
export const SESSIONS_FILENAME = "sessions.json";
export const META_FILENAME = "meta.json";
export const INDEX_FILENAME = "index.json";

export function getRuntimeHomePath(): string {
	return join(homedir(), RUNTIME_HOME_PARENT_DIR, RUNTIME_HOME_DIR);
}

export function getTaskWorktreesHomePath(): string {
	return join(homedir(), RUNTIME_HOME_PARENT_DIR, RUNTIME_WORKTREES_DIR);
}

export function getWorkspacesRootPath(): string {
	return join(getRuntimeHomePath(), WORKSPACES_DIR);
}

/** Root directory holding isolated workspace instances (all projects). */
export function getIsolatedWorkspacesRootPath(): string {
	return join(getRuntimeHomePath(), ISOLATED_WORKSPACES_DIR);
}

export function getWorkspaceIndexPath(): string {
	return join(getWorkspacesRootPath(), INDEX_FILENAME);
}

export function getWorkspaceDirectoryPath(workspaceId: string): string {
	return join(getWorkspacesRootPath(), workspaceId);
}

export function getWorkspaceBoardPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), BOARD_FILENAME);
}

export function getWorkspaceSessionsPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), SESSIONS_FILENAME);
}

export function getWorkspaceMetaPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), META_FILENAME);
}
