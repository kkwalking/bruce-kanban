// Decides where a task's agent actually runs.
//
// This is the single place that implements the Direct vs. Isolated workspace
// model, so the rest of the backend never has to reason about which kind of
// project it is dealing with.
import type {
	RuntimeTaskExecutionMode,
	RuntimeTaskWorkspaceInstance,
	RuntimeWorkspaceType,
} from "../core/api-contract";
import { describeTaskWorkspaceInstance, resolveTaskWorkingDirectory } from "./isolated-workspace";
import { getTaskWorkspacePathInfo, resolveTaskCwd } from "./task-worktree";
import { hasRootGitRepository, loadWorkspaceDiscovery } from "./workspace-discovery";

export interface ResolveTaskExecutionDirectoryInput {
	workspaceId: string;
	workspacePath: string;
	taskId: string;
	baseRef: string;
	executionMode: RuntimeTaskExecutionMode;
}

export interface ResolvedTaskExecutionDirectory {
	workingDirectory: string;
	mode: RuntimeTaskExecutionMode;
	/**
	 * How the isolated directory was produced. `git-worktree` keeps the classic
	 * Kanban flow; `directory-copy` is the non-Git/multi-repository path.
	 */
	strategy: "project-root" | "git-worktree" | "directory-copy";
}

/**
 * Resolve where a task should run.
 *
 * - `direct` returns the project root unchanged. No Git required.
 * - `isolated` on a Git repository rooted at the project root reuses the
 *   existing worktree machinery, preserving the historical Kanban workflow.
 * - `isolated` on anything else (plain folder, multi-repository parent,
 *   `google-repo` checkout) creates a structural copy.
 *
 * A failure to prepare an isolated workspace throws rather than silently
 * degrading to Direct, so the agent never edits the user's real files by
 * accident.
 */
export type ResolveTaskExecutionDirectory = typeof resolveTaskExecutionDirectory;

export async function resolveTaskExecutionDirectory(
	input: ResolveTaskExecutionDirectoryInput,
): Promise<ResolvedTaskExecutionDirectory> {
	if (input.executionMode === "direct") {
		return {
			workingDirectory: input.workspacePath,
			mode: "direct",
			strategy: "project-root",
		};
	}

	const discovery = await loadWorkspaceDiscovery(input.workspaceId, input.workspacePath);
	if (hasRootGitRepository(discovery)) {
		const workingDirectory = await resolveExistingTaskCwdOrEnsure({
			cwd: input.workspacePath,
			taskId: input.taskId,
			baseRef: input.baseRef,
		});
		return {
			workingDirectory,
			mode: "isolated",
			strategy: "git-worktree",
		};
	}

	const isolated = await resolveTaskWorkingDirectory({
		taskId: input.taskId,
		sourceRoot: input.workspacePath,
		workspaceId: input.workspaceId,
		baseRef: input.baseRef,
		mode: "isolated",
	});
	if (!isolated.ok || !isolated.instance) {
		throw new Error(isolated.error ?? "Could not create an isolated workspace for this task.");
	}
	return {
		workingDirectory: isolated.instance.workingDirectory,
		mode: "isolated",
		strategy: "directory-copy",
	};
}

/**
 * Prefer an existing worktree; create one only when it is missing.
 *
 * Reusing the existing path is important: recreating a worktree would discard
 * whatever the agent already did in it.
 */
async function resolveExistingTaskCwdOrEnsure(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<string> {
	try {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: false,
		});
	} catch {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: true,
		});
	}
}

/**
 * The built-in execution mode for a workspace type.
 *
 * Git repositories default to isolated because the worktree flow is what the
 * existing review/commit tooling expects. Non-Git projects default to direct
 * because a directory copy is expensive and there is no repository to protect
 * the user's files from.
 */
export function getDefaultExecutionModeForWorkspaceType(workspaceType: RuntimeWorkspaceType): RuntimeTaskExecutionMode {
	return workspaceType === "git" ? "isolated" : "direct";
}

/**
 * Describe where a task's isolated workspace lives, without creating it.
 *
 * Git-rooted projects use the existing worktree location, so this must not
 * assume the generic directory-copy path. Getting this wrong would point the
 * review/apply UI at a directory that does not exist.
 */
export async function describeTaskIsolatedWorkspace(options: {
	workspaceId: string;
	workspacePath: string;
	taskId: string;
	baseRef: string;
}): Promise<RuntimeTaskWorkspaceInstance> {
	const discovery = await loadWorkspaceDiscovery(options.workspaceId, options.workspacePath);
	if (hasRootGitRepository(discovery)) {
		const pathInfo = await getTaskWorkspacePathInfo({
			cwd: options.workspacePath,
			taskId: options.taskId,
			baseRef: options.baseRef,
		});
		return {
			taskId: options.taskId,
			mode: "isolated",
			sourceRoot: options.workspacePath,
			workingDirectory: pathInfo.path,
			isolatedPath: pathInfo.path,
			exists: pathInfo.exists,
			fileCount: null,
			sizeBytes: null,
			createdAt: null,
			unavailableReason: null,
		};
	}
	return await describeTaskWorkspaceInstance({
		taskId: options.taskId,
		sourceRoot: options.workspacePath,
		mode: "isolated",
		workspaceId: options.workspaceId,
	});
}
