import { TRPCError } from "@trpc/server";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type {
	RuntimeBoardCard,
	RuntimeGitCheckoutResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitSummaryResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeTaskExecutionMode,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceChangesMode,
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceFileSearchResponse,
	RuntimeWorkspaceStateResponse,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureResponse,
} from "../core/api-contract";
import {
	parseGitCheckoutRequest,
	parseIsolatedApplyRequest,
	parseIsolatedWorkspaceCleanupRequest,
	parseTaskWorkspaceInstanceRequest,
	parseWorkspaceChangesInput,
	parseWorkspaceDiscoveryRefreshRequest,
	parseWorktreeDeleteRequest,
	parseWorktreeEnsureRequest,
} from "../core/api-validation";
import { loadWorkspaceBoardById, saveWorkspaceState, WorkspaceStateConflictError } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import {
	createEmptyWorkspaceChangesResponse,
	getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef,
} from "../workspace/get-workspace-changes";
import { getCommitDiff, getGitLog, getGitRefs } from "../workspace/git-history";
import { discardGitChanges, getGitSyncSummary, runGitCheckoutAction, runGitSyncAction } from "../workspace/git-sync";
import { applyIsolatedWorkspace, buildIsolatedApplyPlan } from "../workspace/isolated-apply";
import { cleanupIsolatedWorkspace } from "../workspace/isolated-workspace";
import { getWorkspaceRepositoryChanges } from "../workspace/repository-changes";
import { searchWorkspaceFiles } from "../workspace/search-workspace-files";
import {
	describeTaskExecutionDirectory,
	describeTaskWorkspace,
	resolveEffectiveExecutionMode,
	resolveTaskExecutionDirectory,
} from "../workspace/task-execution-directory";
import { deleteTaskWorktree, ensureTaskWorktreeIfDoesntExist, getTaskWorkspaceInfo } from "../workspace/task-worktree";
import {
	clearWorkspaceDiscoveryOverride,
	hasRootGitRepository,
	loadWorkspaceDiscovery,
	loadWorkspaceDiscoveryOverrideState,
	setWorkspaceDiscoveryOverride,
	toWorkspaceDiscoverySnapshot,
} from "../workspace/workspace-discovery";
import type { RuntimeTrpcContext } from "./app-router";

export interface CreateWorkspaceApiDependencies {
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	getScopedClineTaskSessionService: (scope: {
		workspaceId: string;
		workspacePath: string;
	}) => Promise<ClineTaskSessionService>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void> | void;
	buildWorkspaceStateSnapshot: (workspaceId: string, workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
}

/**
 * Look up a task card so workspace procedures can read its execution mode.
 *
 * Returns null when the task is unknown; callers then fall back to the project
 * default rather than failing.
 */
async function findTaskCard(workspaceId: string, taskId: string): Promise<RuntimeBoardCard | null> {
	try {
		const board = await loadWorkspaceBoardById(workspaceId);
		for (const column of board.columns) {
			const card = column.cards.find((candidate) => candidate.id === taskId);
			if (card) {
				return card;
			}
		}
	} catch {
		return null;
	}
	return null;
}

function normalizeOptionalTaskWorkspaceScopeInput(
	input: { taskId: string; baseRef: string } | null,
): { taskId: string; baseRef: string } | null {
	if (!input) {
		return null;
	}
	const taskId = input.taskId.trim();
	if (!taskId) {
		throw new Error("baseRef query parameter requires taskId.");
	}
	// baseRef may be empty for non-Git projects.
	return {
		taskId,
		baseRef: input.baseRef.trim(),
	};
}

function normalizeRequiredTaskWorkspaceScopeInput(input: {
	taskId: string;
	baseRef: string;
	mode?: RuntimeWorkspaceChangesMode;
}): {
	taskId: string;
	baseRef: string;
	mode: RuntimeWorkspaceChangesMode;
} {
	const taskId = input.taskId.trim();
	if (!taskId) {
		throw new Error("Missing taskId query parameter.");
	}
	// baseRef may be empty for non-Git projects, which have no Git baseline.
	const mode: RuntimeWorkspaceChangesMode = input.mode ?? "working_copy";
	return {
		taskId,
		baseRef: input.baseRef.trim(),
		mode,
	};
}

function isActiveTaskSessionState(summary: RuntimeTaskSessionSummary | null): boolean {
	return summary?.state === "running" || summary?.state === "awaiting_review";
}

function selectLastTurnSummary(
	terminalSummary: RuntimeTaskSessionSummary | null,
	clineSummary: RuntimeTaskSessionSummary | null,
): RuntimeTaskSessionSummary | null {
	if (!terminalSummary) {
		return clineSummary;
	}
	if (!clineSummary) {
		return terminalSummary;
	}
	const terminalIsActive = isActiveTaskSessionState(terminalSummary);
	const clineIsActive = isActiveTaskSessionState(clineSummary);
	if (terminalIsActive !== clineIsActive) {
		return clineIsActive ? clineSummary : terminalSummary;
	}
	if (terminalSummary.updatedAt !== clineSummary.updatedAt) {
		return terminalSummary.updatedAt > clineSummary.updatedAt ? terminalSummary : clineSummary;
	}
	if (clineSummary.agentId === "cline" && terminalSummary.agentId !== "cline") {
		return clineSummary;
	}
	return terminalSummary;
}

function createEmptyGitSummaryErrorResponse(error: unknown): RuntimeGitSummaryResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		error: message,
	};
}

function createEmptyGitSyncErrorResponse(action: RuntimeGitSyncAction, error: unknown): RuntimeGitSyncResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		action,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function createEmptyGitCheckoutErrorResponse(error: unknown): RuntimeGitCheckoutResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		branch: "",
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function createEmptyGitDiscardErrorResponse(error: unknown): RuntimeGitDiscardResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

export function createWorkspaceApi(deps: CreateWorkspaceApiDependencies): RuntimeTrpcContext["workspaceApi"] {
	/**
	 * Resolve which mode a task runs in.
	 *
	 * Discovery is only consulted when neither the request nor the card names a
	 * mode (cards created before execution mode existed). Those legacy cards must
	 * keep the historical behavior for their workspace type rather than defaulting
	 * to Direct, which would make review and status report the project root for a
	 * task that actually ran in a worktree.
	 */
	const resolveTaskMode = async (options: {
		workspaceId: string;
		workspacePath: string;
		taskCard: RuntimeBoardCard | null;
		requestedMode?: RuntimeTaskExecutionMode | null;
		projectDefaultMode?: RuntimeTaskExecutionMode | null;
	}): Promise<RuntimeTaskExecutionMode> => {
		if (options.requestedMode || options.taskCard?.executionMode) {
			return resolveEffectiveExecutionMode({
				requestedMode: options.requestedMode,
				taskMode: options.taskCard?.executionMode,
				projectDefaultMode: options.projectDefaultMode,
			});
		}
		const discovery = await loadWorkspaceDiscovery(options.workspaceId, options.workspacePath).catch(() => null);
		return resolveEffectiveExecutionMode({
			projectDefaultMode: options.projectDefaultMode,
			workspaceType: discovery?.workspaceType ?? null,
		});
	};

	/**
	 * Resolve the directory a task-scoped Git operation should run in.
	 *
	 * These procedures used `resolveTaskCwd`, which always means "the Git
	 * worktree". For a Direct task that is the wrong directory, and when the
	 * worktree was never created it throws even though the task ran fine in the
	 * project root. Routing through the shared describe step keeps Git history and
	 * summary views pointed at the same directory the agent used.
	 *
	 * The "not created yet" error is preserved for isolated tasks so existing
	 * callers that treat a missing worktree as "no data yet" keep working.
	 */
	const resolveTaskScopedDirectory = async (options: {
		workspaceId: string;
		workspacePath: string;
		taskId: string;
		baseRef: string;
	}): Promise<string> => {
		const taskCard = await findTaskCard(options.workspaceId, options.taskId);
		const executionMode = await resolveTaskMode({
			workspaceId: options.workspaceId,
			workspacePath: options.workspacePath,
			taskCard,
		});
		const resolved = await describeTaskExecutionDirectory({
			workspaceId: options.workspaceId,
			workspacePath: options.workspacePath,
			taskId: options.taskId,
			baseRef: options.baseRef,
			executionMode,
		});
		if (resolved.strategy !== "project-root" && !resolved.exists) {
			throw new Error(`Task worktree not found for task "${options.taskId}".`);
		}
		return resolved.workingDirectory;
	};

	return {
		loadGitSummary: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input);
				let summaryCwd = workspaceScope.workspacePath;
				if (taskScope) {
					summaryCwd = await resolveTaskScopedDirectory({
						workspaceId: workspaceScope.workspaceId,
						workspacePath: workspaceScope.workspacePath,
						taskId: taskScope.taskId,
						baseRef: taskScope.baseRef,
					});
				}
				const summary = await getGitSyncSummary(summaryCwd);
				return {
					ok: true,
					summary,
				} satisfies RuntimeGitSummaryResponse;
			} catch (error) {
				return createEmptyGitSummaryErrorResponse(error);
			}
		},
		runGitSyncAction: async (workspaceScope, input) => {
			try {
				return await runGitSyncAction({
					cwd: workspaceScope.workspacePath,
					action: input.action,
				});
			} catch (error) {
				return createEmptyGitSyncErrorResponse(input.action, error);
			}
		},
		checkoutGitBranch: async (workspaceScope, input) => {
			try {
				const body = parseGitCheckoutRequest(input);
				const response = await runGitCheckoutAction({
					cwd: workspaceScope.workspacePath,
					branch: body.branch,
				});
				if (response.ok) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
				}
				return response;
			} catch (error) {
				return createEmptyGitCheckoutErrorResponse(error);
			}
		},
		discardGitChanges: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input);
				let discardCwd = workspaceScope.workspacePath;
				if (taskScope) {
					discardCwd = await resolveTaskScopedDirectory({
						workspaceId: workspaceScope.workspaceId,
						workspacePath: workspaceScope.workspacePath,
						taskId: taskScope.taskId,
						baseRef: taskScope.baseRef,
					});
				}
				const response = await discardGitChanges({
					cwd: discardCwd,
				});
				if (response.ok) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
				}
				return response;
			} catch (error) {
				return createEmptyGitDiscardErrorResponse(error);
			}
		},
		loadChanges: async (workspaceScope, input) => {
			const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
			const taskCard = await findTaskCard(workspaceScope.workspaceId, normalizedInput.taskId);
			const executionMode = await resolveTaskMode({
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				taskCard,
			});

			/*
				Review must follow the mode the task actually ran in, not the project
				type (FR-08 / AC-08.8). A Direct task in a Git project edited the project
				root, so diffing a worktree it never used would show nothing (or someone
				else's work). Direct deliberately reports no files there: the root has no
				trustworthy baseline, and attributing the user's own uncommitted edits to
				the agent would be worse than showing nothing.
			*/
			if (executionMode === "direct") {
				return {
					repoRoot: workspaceScope.workspacePath,
					generatedAt: Date.now(),
					files: [],
				};
			}

			const instance = await describeTaskWorkspace({
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				taskId: normalizedInput.taskId,
				baseRef: normalizedInput.baseRef,
				executionMode,
			});
			if (!instance.exists || !instance.isolatedPath) {
				return await createEmptyWorkspaceChangesResponse(workspaceScope.workspacePath);
			}

			/*
				Git-rooted isolated tasks keep the single-repository Git pipeline so diff
				review is byte-for-byte what it always was. Everything else aggregates
				across repositories, falling back to snapshot comparison for non-Git
				projects.
			*/
			const discovery = await loadWorkspaceDiscovery(workspaceScope.workspaceId, workspaceScope.workspacePath);
			if (!hasRootGitRepository(discovery)) {
				const repositoryChanges = await getWorkspaceRepositoryChanges({
					workspaceId: workspaceScope.workspaceId,
					workspacePath: workspaceScope.workspacePath,
					taskId: normalizedInput.taskId,
					baseRef: normalizedInput.baseRef,
					mode: normalizedInput.mode,
					changesRoot: instance.isolatedPath,
					executionMode,
				});
				const files = repositoryChanges.repositories.flatMap((repository) => repository.files);
				files.sort((left, right) => left.path.localeCompare(right.path));
				return {
					repoRoot: instance.isolatedPath,
					generatedAt: repositoryChanges.generatedAt,
					files,
				};
			}

			const taskCwd = instance.isolatedPath;
			if (normalizedInput.mode === "last_turn") {
				const terminalManager = await deps.ensureTerminalManagerForWorkspace(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = selectLastTurnSummary(
					terminalManager.getSummary(normalizedInput.taskId),
					clineTaskSessionService.getSummary(normalizedInput.taskId),
				);
				const fromCheckpoint = summary?.previousTurnCheckpoint;
				const toCheckpoint = summary?.latestTurnCheckpoint;
				if (!toCheckpoint) {
					return await createEmptyWorkspaceChangesResponse(taskCwd);
				}
				if (summary?.state === "running" || !fromCheckpoint) {
					return await getWorkspaceChangesFromRef({
						cwd: taskCwd,
						fromRef: toCheckpoint.commit,
					});
				}
				return await getWorkspaceChangesBetweenRefs({
					cwd: taskCwd,
					fromRef: fromCheckpoint.commit,
					toRef: toCheckpoint.commit,
				});
			}
			return await getWorkspaceChanges(taskCwd);
		},
		ensureWorktree: async (workspaceScope, input) => {
			const body = parseWorktreeEnsureRequest(input);
			const taskCard = await findTaskCard(workspaceScope.workspaceId, body.taskId);
			const executionMode = await resolveTaskMode({
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				taskCard,
				requestedMode: body.executionMode,
			});

			/*
				This procedure is the UI's preflight before moving a card to In Progress.
				It used to always create a Git worktree, which failed for every project
				whose root is not a repository (plain folders, multi-repository parents,
				google-repo checkouts) and surfaced as a raw
				`git rev-parse --git-common-dir failed` error on drag.

				It must also honor a Direct task inside a Git project. Consulting only
				"is the root a repository" made a Direct task prepare a worktree its agent
				never used, and reported that unused path to the review UI.
			*/
			try {
				// Describe first (read-only), then prepare only the strategy that applies.
				const resolved = await describeTaskExecutionDirectory({
					workspaceId: workspaceScope.workspaceId,
					workspacePath: workspaceScope.workspacePath,
					taskId: body.taskId,
					baseRef: body.baseRef,
					executionMode,
				});
				if (resolved.strategy === "git-worktree") {
					// The Git path owns the submodule setup, ignored-path symlinks, locking,
					// and the warning plus base commit the UI surfaces.
					return await ensureTaskWorktreeIfDoesntExist({
						cwd: workspaceScope.workspacePath,
						taskId: body.taskId,
						baseRef: body.baseRef,
					});
				}
				if (resolved.strategy === "directory-copy") {
					const created = await resolveTaskExecutionDirectory({
						workspaceId: workspaceScope.workspaceId,
						workspacePath: workspaceScope.workspacePath,
						taskId: body.taskId,
						baseRef: body.baseRef,
						executionMode,
					});
					return {
						ok: true,
						path: created.workingDirectory,
						baseRef: body.baseRef,
						baseCommit: "",
					} satisfies RuntimeWorktreeEnsureResponse;
				}
				// Direct runs in the project root; there is nothing to prepare.
				return {
					ok: true,
					path: resolved.workingDirectory,
					baseRef: body.baseRef,
					baseCommit: "",
				} satisfies RuntimeWorktreeEnsureResponse;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					path: null,
					baseRef: body.baseRef,
					baseCommit: null,
					error: message,
				} satisfies RuntimeWorktreeEnsureResponse;
			}
		},
		deleteWorktree: async (workspaceScope, input) => {
			const body = parseWorktreeDeleteRequest(input);
			const taskCard = await findTaskCard(workspaceScope.workspaceId, body.taskId);
			const executionMode = await resolveTaskMode({
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				taskCard,
			});
			/*
				Cleanup must follow the strategy the task actually used, not the project
				type. Unmanaged (non-Git) isolation owns its directory and refuses to
				delete unapplied changes unless forced.

				A Direct task must never create an isolated workspace, but it may still have
				one on disk: execution mode is editable between runs, and builds before this
				fix created a worktree for every Direct task in a Git project. So a Direct
				task deletes a leftover Git worktree rather than skipping cleanup, which
				would strand that directory with no UI entry point left to remove it. The
				Git path captures a patch first, and no-ops when the worktree is absent, so
				this is safe for a task that never had one.
			*/
			const resolved = await describeTaskExecutionDirectory({
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				taskId: body.taskId,
				baseRef: taskCard?.baseRef ?? "",
				executionMode,
			});
			if (resolved.strategy === "directory-copy") {
				const cleaned = await cleanupIsolatedWorkspace({
					taskId: body.taskId,
					sourceRoot: workspaceScope.workspacePath,
					// Clearing a card is an explicit user action, so remove the copy even
					// if it still holds unapplied changes.
					force: true,
				});
				return {
					ok: cleaned.ok,
					removed: cleaned.removed,
					...(cleaned.error ? { error: cleaned.error } : {}),
				} satisfies RuntimeWorktreeDeleteResponse;
			}
			if (resolved.strategy === "project-root") {
				// Nothing was created for Direct, and the project root is never touched.
				// Only a Git project can hold the leftover worktree described above.
				const discovery = await loadWorkspaceDiscovery(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				).catch(() => null);
				if (!discovery || !hasRootGitRepository(discovery)) {
					return { ok: true, removed: false } satisfies RuntimeWorktreeDeleteResponse;
				}
			}
			return await deleteTaskWorktree({
				repoPath: workspaceScope.workspacePath,
				taskId: body.taskId,
			});
		},
		loadTaskContext: async (workspaceScope, input) => {
			const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
			const taskCard = await findTaskCard(workspaceScope.workspaceId, normalizedInput.taskId);
			const executionMode = await resolveTaskMode({
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				taskCard,
			});
			/*
				Report the directory the agent actually used. A Direct task in a Git
				project must not be reported with a worktree path: that directory may not
				exist, and showing it made cards advertise a workspace nobody used.
			*/
			const resolved = await describeTaskExecutionDirectory({
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				taskId: normalizedInput.taskId,
				baseRef: normalizedInput.baseRef,
				executionMode,
			});
			if (resolved.strategy !== "git-worktree") {
				return {
					taskId: normalizedInput.taskId,
					path: resolved.workingDirectory,
					exists: resolved.exists,
					baseRef: normalizedInput.baseRef,
					branch: null,
					isDetached: false,
					headCommit: null,
				};
			}
			return await getTaskWorkspaceInfo({
				cwd: workspaceScope.workspacePath,
				taskId: normalizedInput.taskId,
				baseRef: normalizedInput.baseRef,
			});
		},
		searchFiles: async (workspaceScope, input) => {
			const query = input.query.trim();
			const limit = input.limit;
			const files = await searchWorkspaceFiles(workspaceScope.workspacePath, query, limit);
			return {
				query,
				files,
			} satisfies RuntimeWorkspaceFileSearchResponse;
		},
		loadState: async (workspaceScope) => {
			return await deps.buildWorkspaceStateSnapshot(workspaceScope.workspaceId, workspaceScope.workspacePath);
		},
		notifyStateUpdated: async (workspaceScope) => {
			void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
			return {
				ok: true,
			};
		},
		saveState: async (workspaceScope, input) => {
			try {
				const terminalManager = await deps.ensureTerminalManagerForWorkspace(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				for (const summary of terminalManager.listSummaries()) {
					input.sessions[summary.taskId] = summary;
				}
				const response = await saveWorkspaceState(workspaceScope.workspacePath, input);
				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
				void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
				return response;
			} catch (error) {
				if (error instanceof WorkspaceStateConflictError) {
					throw new TRPCError({
						code: "CONFLICT",
						message: error.message,
						cause: {
							currentRevision: error.currentRevision,
						},
					});
				}
				throw error;
			}
		},
		loadWorkspaceChanges: async (workspaceScope) => {
			// The home-level working-copy diff has no meaning without Git. Returning
			// an empty result keeps the Git history panel usable instead of throwing
			// for plain folders, multi-repository parents, and google-repo roots.
			try {
				return await getWorkspaceChanges(workspaceScope.workspacePath);
			} catch {
				return {
					repoRoot: workspaceScope.workspacePath,
					generatedAt: Date.now(),
					files: [],
				} satisfies RuntimeWorkspaceChangesResponse;
			}
		},
		loadWorkspaceDiscovery: async (workspaceScope) => {
			const discovery = await loadWorkspaceDiscovery(workspaceScope.workspaceId, workspaceScope.workspacePath);
			const override = await loadWorkspaceDiscoveryOverrideState(workspaceScope.workspaceId);
			return {
				...toWorkspaceDiscoverySnapshot(discovery),
				overridden: override?.overridden ?? false,
				gitIntegrationEnabled: override?.gitIntegrationEnabled ?? true,
			};
		},
		refreshWorkspaceDiscovery: async (workspaceScope, input) => {
			const body = parseWorkspaceDiscoveryRefreshRequest(input);
			if (body.resetOverride) {
				await clearWorkspaceDiscoveryOverride(workspaceScope.workspaceId);
			}
			const needsOverride = body.workspaceType !== undefined || body.gitIntegrationEnabled !== undefined;
			const discovery = needsOverride
				? await setWorkspaceDiscoveryOverride(workspaceScope.workspaceId, workspaceScope.workspacePath, {
						workspaceType:
							body.workspaceType ??
							(await loadWorkspaceDiscovery(workspaceScope.workspaceId, workspaceScope.workspacePath))
								.workspaceType,
						gitIntegrationEnabled: body.gitIntegrationEnabled ?? true,
						updatedAt: Date.now(),
					})
				: await loadWorkspaceDiscovery(workspaceScope.workspaceId, workspaceScope.workspacePath, {
						force: true,
					});
			void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
			const override = await loadWorkspaceDiscoveryOverrideState(workspaceScope.workspaceId);
			return {
				...toWorkspaceDiscoverySnapshot(discovery),
				overridden: override?.overridden ?? false,
				gitIntegrationEnabled: override?.gitIntegrationEnabled ?? true,
			};
		},
		getTaskWorkspaceInstance: async (workspaceScope, input) => {
			const body = parseTaskWorkspaceInstanceRequest(input);
			const taskCard = await findTaskCard(workspaceScope.workspaceId, body.taskId);
			const mode = await resolveTaskMode({
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				taskCard,
				requestedMode: body.executionMode,
			});
			return {
				ok: true,
				instance: await describeTaskWorkspace({
					workspaceId: workspaceScope.workspaceId,
					workspacePath: workspaceScope.workspacePath,
					taskId: body.taskId,
					baseRef: body.baseRef,
					executionMode: mode,
				}),
			};
		},
		createTaskWorkspaceInstance: async (workspaceScope, input) => {
			const body = parseTaskWorkspaceInstanceRequest(input);
			const taskCard = await findTaskCard(workspaceScope.workspaceId, body.taskId);
			const mode = await resolveTaskMode({
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				taskCard,
				requestedMode: body.executionMode,
			});
			if (mode === "direct") {
				return {
					ok: true,
					instance: await describeTaskWorkspace({
						workspaceId: workspaceScope.workspaceId,
						workspacePath: workspaceScope.workspacePath,
						taskId: body.taskId,
						baseRef: body.baseRef,
						executionMode: mode,
					}),
				};
			}
			// Route through the execution-directory resolver so a Git repository gets
			// a worktree (the historical flow) while other projects get a copy.
			try {
				const resolved = await resolveTaskExecutionDirectory({
					workspaceId: workspaceScope.workspaceId,
					workspacePath: workspaceScope.workspacePath,
					taskId: body.taskId,
					baseRef: body.baseRef,
					executionMode: mode,
				});
				return {
					ok: true,
					instance: {
						taskId: body.taskId,
						mode,
						sourceRoot: workspaceScope.workspacePath,
						workingDirectory: resolved.workingDirectory,
						isolatedPath: resolved.workingDirectory,
						exists: true,
						fileCount: null,
						sizeBytes: null,
						createdAt: null,
						unavailableReason: null,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, instance: null, error: message };
			}
		},
		getIsolatedApplyPlan: async (workspaceScope, input) => {
			const taskCard = await findTaskCard(workspaceScope.workspaceId, input.taskId);
			const executionMode = await resolveTaskMode({
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				taskCard,
			});
			if (executionMode === "direct") {
				// Direct-mode edits are already in the project root; there is nothing
				// to apply and offering an apply would be misleading.
				return {
					ok: false,
					plan: null,
					error: "This task runs in Direct mode, so its changes are already in your project.",
				};
			}
			const instance = await describeTaskWorkspace({
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				taskId: input.taskId,
				baseRef: taskCard?.baseRef ?? "",
				executionMode,
			});
			if (!instance.exists || !instance.isolatedPath) {
				return {
					ok: false,
					plan: null,
					error: "This task has no isolated workspace to apply from.",
				};
			}
			const discovery = await loadWorkspaceDiscovery(workspaceScope.workspaceId, workspaceScope.workspacePath);
			const plan = await buildIsolatedApplyPlan({
				taskId: input.taskId,
				workspaceId: workspaceScope.workspaceId,
				sourceRoot: workspaceScope.workspacePath,
				isolatedPath: instance.isolatedPath,
				workspaceType: discovery.workspaceType,
				repositories: discovery.repositories.map((repository) => ({
					relativePath: repository.relativePath,
					isRoot: repository.isRoot,
				})),
			});
			return { ok: true, plan };
		},
		applyIsolatedWorkspace: async (workspaceScope, input) => {
			const body = parseIsolatedApplyRequest(input);
			const taskCard = await findTaskCard(workspaceScope.workspaceId, body.taskId);
			const instance = await describeTaskWorkspace({
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				taskId: body.taskId,
				baseRef: taskCard?.baseRef ?? "",
				executionMode: await resolveTaskMode({
					workspaceId: workspaceScope.workspaceId,
					workspacePath: workspaceScope.workspacePath,
					taskCard,
				}),
			});
			if (!instance.exists || !instance.isolatedPath) {
				return {
					ok: false,
					applied: [],
					skipped: [],
					conflicts: [],
					error: "This task has no isolated workspace to apply from.",
				};
			}
			const discovery = await loadWorkspaceDiscovery(workspaceScope.workspaceId, workspaceScope.workspacePath);
			const result = await applyIsolatedWorkspace({
				taskId: body.taskId,
				workspaceId: workspaceScope.workspaceId,
				sourceRoot: workspaceScope.workspacePath,
				isolatedPath: instance.isolatedPath,
				workspaceType: discovery.workspaceType,
				repositories: discovery.repositories.map((repository) => ({
					relativePath: repository.relativePath,
					isRoot: repository.isRoot,
				})),
				confirmed: body.confirmed,
				paths: body.paths,
			});
			if (result.applied.length > 0) {
				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			}
			// AC-08.12: report partial application explicitly rather than implying
			// parity between "some files landed" and "the task is applied".
			const partial = result.applied.length > 0 && result.skipped.length > 0;
			return {
				...result,
				...(partial || result.conflicts.length > 0 ? { partial: true } : {}),
			};
		},
		cleanupIsolatedWorkspace: async (workspaceScope, input) => {
			const body = parseIsolatedWorkspaceCleanupRequest(input);
			const result = await cleanupIsolatedWorkspace({
				taskId: body.taskId,
				sourceRoot: workspaceScope.workspacePath,
				force: body.force,
			});
			return {
				ok: result.ok,
				removed: result.removed,
				...(result.refusedReason ? { refusedReason: result.refusedReason } : {}),
				...(result.error ? { error: result.error } : {}),
			};
		},
		loadRepositoryChanges: async (workspaceScope, input) => {
			const body = parseWorkspaceChangesInput(input);
			const taskCard = await findTaskCard(workspaceScope.workspaceId, body.taskId);
			const executionMode = await resolveTaskMode({
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				taskCard,
			});
			if (executionMode === "isolated") {
				const instance = await describeTaskWorkspace({
					workspaceId: workspaceScope.workspaceId,
					workspacePath: workspaceScope.workspacePath,
					taskId: body.taskId,
					baseRef: body.baseRef,
					executionMode,
				});
				if (instance.exists && instance.isolatedPath) {
					return await getWorkspaceRepositoryChanges({
						workspaceId: workspaceScope.workspaceId,
						workspacePath: workspaceScope.workspacePath,
						taskId: body.taskId,
						baseRef: body.baseRef,
						mode: body.mode ?? "working_copy",
						changesRoot: instance.isolatedPath,
						executionMode,
					});
				}
			}
			return await getWorkspaceRepositoryChanges({
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				taskId: body.taskId,
				baseRef: body.baseRef,
				mode: body.mode ?? "working_copy",
				executionMode,
			});
		},
		loadGitLog: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null);
			let logCwd = workspaceScope.workspacePath;
			if (taskScope) {
				logCwd = await resolveTaskScopedDirectory({
					workspaceId: workspaceScope.workspaceId,
					workspacePath: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
				});
			}
			return await getGitLog({
				cwd: logCwd,
				ref: input.ref ?? null,
				refs: input.refs ?? null,
				maxCount: input.maxCount,
				skip: input.skip,
			});
		},
		loadGitRefs: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input ?? null);
			let refsCwd = workspaceScope.workspacePath;
			if (taskScope) {
				refsCwd = await resolveTaskScopedDirectory({
					workspaceId: workspaceScope.workspaceId,
					workspacePath: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
				});
			}
			return await getGitRefs(refsCwd);
		},
		loadCommitDiff: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null);
			let diffCwd = workspaceScope.workspacePath;
			if (taskScope) {
				diffCwd = await resolveTaskScopedDirectory({
					workspaceId: workspaceScope.workspaceId,
					workspacePath: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
				});
			}
			return await getCommitDiff({
				cwd: diffCwd,
				commitHash: input.commitHash,
			});
		},
	};
}
