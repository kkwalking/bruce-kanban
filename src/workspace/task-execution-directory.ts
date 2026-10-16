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

export interface DescribeTaskExecutionDirectoryInput extends ResolveTaskExecutionDirectoryInput {
	/**
	 * When true, create the directory if it does not exist yet.
	 *
	 * Reads (`getTaskContext`, metadata polling) pass false so a status lookup
	 * never materializes a workspace, while the preflight and session startup pass
	 * true. Direct never creates anything either way.
	 */
	ensure?: boolean;
}

export interface ResolvedTaskExecutionDirectory {
	workingDirectory: string;
	mode: RuntimeTaskExecutionMode;
	/**
	 * How the isolated directory was produced. `git-worktree` keeps the classic
	 * Kanban flow; `directory-copy` is the non-Git/multi-repository path.
	 */
	strategy: "project-root" | "git-worktree" | "directory-copy";
	/**
	 * Whether `workingDirectory` is on disk right now. False only for an isolated
	 * strategy that has not been prepared yet, which is how a status lookup
	 * distinguishes "not created yet" from "ready".
	 */
	exists: boolean;
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

/**
 * Resolve a task directory without creating it.
 *
 * Reports the path the task *would* use plus whether it exists, so status
 * surfaces can describe a workspace instead of silently instantiating one.
 */
export async function describeTaskExecutionDirectory(
	input: DescribeTaskExecutionDirectoryInput,
): Promise<ResolvedTaskExecutionDirectory> {
	if (input.executionMode === "direct") {
		return {
			workingDirectory: input.workspacePath,
			mode: "direct",
			strategy: "project-root",
			exists: true,
		};
	}

	const ensure = input.ensure ?? false;
	const discovery = await loadWorkspaceDiscovery(input.workspaceId, input.workspacePath);
	if (hasRootGitRepository(discovery)) {
		if (ensure) {
			const worktreePath = await resolveTaskCwd({
				cwd: input.workspacePath,
				taskId: input.taskId,
				baseRef: input.baseRef,
				ensure: true,
			});
			return {
				workingDirectory: worktreePath,
				mode: "isolated",
				strategy: "git-worktree",
				exists: true,
			};
		}
		// Reporting must not create a worktree, and must not throw when it is
		// missing: "not created yet" is a valid answer for a status lookup.
		const pathInfo = await getTaskWorkspacePathInfo({
			cwd: input.workspacePath,
			taskId: input.taskId,
			baseRef: input.baseRef,
		});
		return {
			workingDirectory: pathInfo.path,
			mode: "isolated",
			strategy: "git-worktree",
			exists: pathInfo.exists,
		};
	}

	const instance = await resolveTaskWorkingDirectory({
		taskId: input.taskId,
		sourceRoot: input.workspacePath,
		workspaceId: input.workspaceId,
		baseRef: input.baseRef,
		mode: "isolated",
		ensure,
	});
	if (!instance.ok || !instance.instance) {
		throw new Error(instance.error ?? "Could not resolve an isolated workspace for this task.");
	}
	return {
		workingDirectory: instance.instance.workingDirectory,
		mode: "isolated",
		strategy: "directory-copy",
		exists: instance.instance.exists,
	};
}

export async function resolveTaskExecutionDirectory(
	input: ResolveTaskExecutionDirectoryInput,
): Promise<ResolvedTaskExecutionDirectory> {
	if (input.executionMode === "direct") {
		return {
			workingDirectory: input.workspacePath,
			mode: "direct",
			strategy: "project-root",
			exists: true,
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
			exists: true,
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
		exists: isolated.instance.exists,
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

export interface EffectiveTaskExecutionModeInput {
	/** Explicit mode from the request, e.g. a retry that pins the mode it started with. */
	requestedMode?: RuntimeTaskExecutionMode | null;
	/** The task card's own setting. Undefined for cards created before the field existed. */
	taskMode?: RuntimeTaskExecutionMode | null;
	/** Project-level default from runtime config, when the caller can load it. */
	projectDefaultMode?: RuntimeTaskExecutionMode | null;
	/**
	 * Workspace type, used as the last fallback. Cards created before execution
	 * mode existed have no stored value, and guessing wrong would point review and
	 * status surfaces at a directory the task never used.
	 */
	workspaceType?: RuntimeWorkspaceType | null;
}

/**
 * Resolve which mode a task actually runs in.
 *
 * This is the single precedence rule for the whole runtime. Every surface that
 * reports or prepares a task directory must use it, otherwise the preflight,
 * session startup, review, and status polling can disagree about where a task
 * lives. Precedence, highest first: request, card, project default, workspace
 * type default.
 */
export function resolveEffectiveExecutionMode(input: EffectiveTaskExecutionModeInput): RuntimeTaskExecutionMode {
	if (input.requestedMode) {
		return input.requestedMode;
	}
	if (input.taskMode) {
		return input.taskMode;
	}
	if (input.projectDefaultMode) {
		return input.projectDefaultMode;
	}
	return input.workspaceType ? getDefaultExecutionModeForWorkspaceType(input.workspaceType) : "isolated";
}

/**
 * Describe a task's workspace without creating it.
 *
 * Honors the task's execution mode, so a Direct task in a Git project reports the
 * project root rather than a Git worktree that its agent never used. This is the
 * read-only counterpart to `resolveTaskExecutionDirectory` and must stay aligned
 * with it: callers use this for review, apply planning, and metadata reporting.
 */
export async function describeTaskWorkspace(
	input: DescribeTaskExecutionDirectoryInput,
): Promise<RuntimeTaskWorkspaceInstance> {
	const resolved = await describeTaskExecutionDirectory({ ...input, ensure: input.ensure ?? false });
	return await toWorkspaceInstance(input, resolved);
}

/**
 * Project a resolved strategy onto the API contract's workspace instance.
 *
 * `isolatedPath` stays null for Direct so review/apply surfaces cannot mistake
 * the project root for an isolated copy they are allowed to write back to.
 */
async function toWorkspaceInstance(
	input: DescribeTaskExecutionDirectoryInput,
	resolved: ResolvedTaskExecutionDirectory,
): Promise<RuntimeTaskWorkspaceInstance> {
	if (resolved.strategy === "project-root") {
		return {
			taskId: input.taskId,
			mode: "direct",
			sourceRoot: input.workspacePath,
			workingDirectory: resolved.workingDirectory,
			isolatedPath: null,
			exists: true,
			fileCount: null,
			sizeBytes: null,
			createdAt: null,
			unavailableReason: null,
		};
	}
	if (resolved.strategy === "git-worktree") {
		return {
			taskId: input.taskId,
			mode: "isolated",
			sourceRoot: input.workspacePath,
			workingDirectory: resolved.workingDirectory,
			isolatedPath: resolved.workingDirectory,
			exists: resolved.exists,
			fileCount: null,
			sizeBytes: null,
			createdAt: null,
			unavailableReason: null,
		};
	}
	return await describeTaskWorkspaceInstance({
		taskId: input.taskId,
		sourceRoot: input.workspacePath,
		mode: "isolated",
		workspaceId: input.workspaceId,
	});
}
