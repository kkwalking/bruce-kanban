import { TRPCError } from "@trpc/server";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type {
	RuntimeBoardCard,
	RuntimeGitCheckoutResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitSummaryResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
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
import { cleanupIsolatedWorkspace, describeTaskWorkspaceInstance } from "../workspace/isolated-workspace";
import { getWorkspaceRepositoryChanges } from "../workspace/repository-changes";
import { searchWorkspaceFiles } from "../workspace/search-workspace-files";
import { describeTaskIsolatedWorkspace, resolveTaskExecutionDirectory } from "../workspace/task-execution-directory";
import {
	deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist,
	getTaskWorkspaceInfo,
	resolveTaskCwd,
} from "../workspace/task-worktree";
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

function isMissingTaskWorktreeError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return error.message.startsWith("Task worktree not found for task ");
}

export function createWorkspaceApi(deps: CreateWorkspaceApiDependencies): RuntimeTrpcContext["workspaceApi"] {
	return {
		loadGitSummary: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input);
				let summaryCwd = workspaceScope.workspacePath;
				if (taskScope) {
					summaryCwd = await resolveTaskCwd({
						cwd: workspaceScope.workspacePath,
						taskId: taskScope.taskId,
						baseRef: taskScope.baseRef,
						ensure: false,
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
					discardCwd = await resolveTaskCwd({
						cwd: workspaceScope.workspacePath,
						taskId: taskScope.taskId,
						baseRef: taskScope.baseRef,
						ensure: false,
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
			const discovery = await loadWorkspaceDiscovery(workspaceScope.workspaceId, workspaceScope.workspacePath);

			/*
				Review must not depend on the project root being a Git repository
				(FR-08 / AC-08.8). For non-Git projects the single-repository diff
				pipeline has no baseline, so route through the snapshot comparer
				instead, where changes are detected from isolated copies.
			*/
			if (!hasRootGitRepository(discovery)) {
				if (taskCard?.executionMode !== "isolated") {
					// Direct mode: the agent edited the project root in place. There is no
					// trustworthy baseline to diff against, so report no files rather than
					// misattributing the user's own edits to the agent.
					return { repoRoot: workspaceScope.workspacePath, generatedAt: Date.now(), files: [] };
				}
				const instance = await describeTaskIsolatedWorkspace({
					workspaceId: workspaceScope.workspaceId,
					workspacePath: workspaceScope.workspacePath,
					taskId: normalizedInput.taskId,
					baseRef: normalizedInput.baseRef,
				});
				if (!instance.exists || !instance.isolatedPath) {
					return { repoRoot: workspaceScope.workspacePath, generatedAt: Date.now(), files: [] };
				}
				const repositoryChanges = await getWorkspaceRepositoryChanges({
					workspaceId: workspaceScope.workspaceId,
					workspacePath: workspaceScope.workspacePath,
					taskId: normalizedInput.taskId,
					baseRef: normalizedInput.baseRef,
					mode: normalizedInput.mode,
					changesRoot: instance.isolatedPath,
					executionMode: "isolated",
				});
				const files = repositoryChanges.repositories.flatMap((repository) => repository.files);
				files.sort((left, right) => left.path.localeCompare(right.path));
				return {
					repoRoot: instance.isolatedPath,
					generatedAt: repositoryChanges.generatedAt,
					files,
				};
			}

			let taskCwd: string;
			try {
				taskCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: normalizedInput.taskId,
					baseRef: normalizedInput.baseRef,
					ensure: false,
				});
			} catch (error) {
				if (!isMissingTaskWorktreeError(error)) {
					throw error;
				}
				return await createEmptyWorkspaceChangesResponse(workspaceScope.workspacePath);
			}
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
			const discovery = await loadWorkspaceDiscovery(workspaceScope.workspaceId, workspaceScope.workspacePath);

			/*
				This procedure is the UI's preflight before moving a card to In Progress.
				It used to always create a Git worktree, which failed for every project
				whose root is not a repository (plain folders, multi-repository parents,
				google-repo checkouts) and surfaced as a raw
				`git rev-parse --git-common-dir failed` error on drag. Route through the
				execution-directory resolver instead so the preflight matches what
				session startup will actually do.
			*/
			if (!hasRootGitRepository(discovery)) {
				const mode = body.executionMode ?? taskCard?.executionMode ?? "direct";
				if (mode === "direct") {
					// Direct mode runs in the project root; there is nothing to prepare.
					return {
						ok: true,
						path: workspaceScope.workspacePath,
						baseRef: body.baseRef,
						baseCommit: "",
					} satisfies RuntimeWorktreeEnsureResponse;
				}
				try {
					const resolved = await resolveTaskExecutionDirectory({
						workspaceId: workspaceScope.workspaceId,
						workspacePath: workspaceScope.workspacePath,
						taskId: body.taskId,
						baseRef: body.baseRef,
						executionMode: "isolated",
					});
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
			}

			return await ensureTaskWorktreeIfDoesntExist({
				cwd: workspaceScope.workspacePath,
				taskId: body.taskId,
				baseRef: body.baseRef,
			});
		},
		deleteWorktree: async (workspaceScope, input) => {
			const body = parseWorktreeDeleteRequest(input);
			const discovery = await loadWorkspaceDiscovery(workspaceScope.workspaceId, workspaceScope.workspacePath);
			/*
				Non-Git projects have no worktree. Their cleanup target is the isolated
				copy, and running the Git path here would both fail and leave the copy on
				disk. Direct-mode tasks have nothing to clean up at all.
			*/
			if (!hasRootGitRepository(discovery)) {
				const instance = await describeTaskIsolatedWorkspace({
					workspaceId: workspaceScope.workspaceId,
					workspacePath: workspaceScope.workspacePath,
					taskId: body.taskId,
					baseRef: "",
				});
				if (!instance.exists || !instance.isolatedPath) {
					return { ok: true, removed: false } satisfies RuntimeWorktreeDeleteResponse;
				}
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
			return await deleteTaskWorktree({
				repoPath: workspaceScope.workspacePath,
				taskId: body.taskId,
			});
		},
		loadTaskContext: async (workspaceScope, input) => {
			const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
			const discovery = await loadWorkspaceDiscovery(workspaceScope.workspaceId, workspaceScope.workspacePath);
			// For a non-Git project the task does not run in a worktree, so reporting
			// the worktree path would show a directory that never exists.
			if (!hasRootGitRepository(discovery)) {
				const instance = await describeTaskIsolatedWorkspace({
					workspaceId: workspaceScope.workspaceId,
					workspacePath: workspaceScope.workspacePath,
					taskId: normalizedInput.taskId,
					baseRef: normalizedInput.baseRef,
				});
				return {
					taskId: instance.taskId,
					path: instance.workingDirectory,
					exists: instance.exists,
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
			const mode = body.executionMode ?? taskCard?.executionMode ?? "direct";
			if (mode === "isolated") {
				return {
					ok: true,
					instance: await describeTaskIsolatedWorkspace({
						workspaceId: workspaceScope.workspaceId,
						workspacePath: workspaceScope.workspacePath,
						taskId: body.taskId,
						baseRef: body.baseRef,
					}),
				};
			}
			return {
				ok: true,
				instance: await describeTaskWorkspaceInstance({
					taskId: body.taskId,
					sourceRoot: workspaceScope.workspacePath,
					mode: "direct",
					workspaceId: workspaceScope.workspaceId,
				}),
			};
		},
		createTaskWorkspaceInstance: async (workspaceScope, input) => {
			const body = parseTaskWorkspaceInstanceRequest(input);
			const taskCard = await findTaskCard(workspaceScope.workspaceId, body.taskId);
			const mode = body.executionMode ?? taskCard?.executionMode ?? "direct";
			if (mode === "direct") {
				return {
					ok: true,
					instance: await describeTaskWorkspaceInstance({
						taskId: body.taskId,
						sourceRoot: workspaceScope.workspacePath,
						mode: "direct",
						workspaceId: workspaceScope.workspaceId,
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
			const instance = await describeTaskIsolatedWorkspace({
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				taskId: input.taskId,
				baseRef: taskCard?.baseRef ?? "",
			});
			if (!instance.exists || !instance.isolatedPath) {
				return {
					ok: false,
					plan: null,
					error: "This task has no isolated workspace to apply from.",
				};
			}
			if (taskCard?.executionMode === "direct") {
				// Direct-mode edits are already in the project root; there is nothing
				// to apply and offering an apply would be misleading.
				return {
					ok: false,
					plan: null,
					error: "This task runs in Direct mode, so its changes are already in your project.",
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
			const instance = await describeTaskIsolatedWorkspace({
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				taskId: body.taskId,
				baseRef: taskCard?.baseRef ?? "",
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
			const executionMode = taskCard?.executionMode ?? "direct";
			if (executionMode === "isolated") {
				const instance = await describeTaskIsolatedWorkspace({
					workspaceId: workspaceScope.workspaceId,
					workspacePath: workspaceScope.workspacePath,
					taskId: body.taskId,
					baseRef: body.baseRef,
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
				logCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
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
				refsCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
				});
			}
			return await getGitRefs(refsCwd);
		},
		loadCommitDiff: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null);
			let diffCwd = workspaceScope.workspacePath;
			if (taskScope) {
				diffCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
				});
			}
			return await getCommitDiff({
				cwd: diffCwd,
				commitHash: input.commitHash,
			});
		},
	};
}
