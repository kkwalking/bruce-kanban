// Coordinates the runtime-side TRPC handlers used by the browser.
// This is the main backend entrypoint for sessions, settings, git, and
// workspace actions, but detailed Cline, terminal, and config behavior
// should stay in focused services instead of accumulating here.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { createClineMcpRuntimeService } from "../cline-sdk/cline-mcp-runtime-service";
import { createClineMcpSettingsService } from "../cline-sdk/cline-mcp-settings-service";
import { createClineProviderService } from "../cline-sdk/cline-provider-service";
import { isClineClearSlashCommand } from "../cline-sdk/cline-slash-commands";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../config/runtime-config";
import { updateGlobalRuntimeConfig, updateRuntimeConfig } from "../config/runtime-config";
import { findRuntimeAgentPermissionMode, getRuntimeAgentDefaultPermissionModeId } from "../core/agent-catalog";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeCommandRunResponse,
	RuntimeRunUpdateResponse,
	RuntimeTaskExecutionMode,
	RuntimeTaskPermissionPolicy,
	RuntimeTaskSessionSummary,
	RuntimeUpdateStatusResponse,
} from "../core/api-contract";
import {
	parseClineAccountSwitchRequest,
	parseClineAddProviderRequest,
	parseClineDeviceAuthCompleteRequest,
	parseClineMcpOAuthRequest,
	parseClineMcpSettingsSaveRequest,
	parseClineOauthLoginRequest,
	parseClineProviderModelsRequest,
	parseClineProviderSettingsSaveRequest,
	parseClineUpdateProviderRequest,
	parseCommandRunRequest,
	parseRuntimeConfigSaveRequest,
	parseShellSessionStartRequest,
	parseTaskChatAbortRequest,
	parseTaskChatCancelRequest,
	parseTaskChatMessagesRequest,
	parseTaskChatReloadRequest,
	parseTaskChatSendRequest,
	parseTaskSessionInputRequest,
	parseTaskSessionStartRequest,
	parseTaskSessionStopRequest,
} from "../core/api-validation";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { resolveTaskTitle } from "../core/task-title.js";
import { openInBrowser } from "../server/browser";
import { loadWorkspaceBoardById } from "../state/workspace-state";
import { buildRuntimeConfigResponse, resolveAgentCommand } from "../terminal/agent-registry";
import type { TerminalSessionManager } from "../terminal/session-manager";
import {
	type ResolveTaskExecutionDirectory,
	resolveEffectiveExecutionMode,
	resolveTaskExecutionDirectory,
} from "../workspace/task-execution-directory";
import { resolveTaskCwd } from "../workspace/task-worktree";
import { captureTaskTurnCheckpoint } from "../workspace/turn-checkpoints";
import { loadWorkspaceDiscovery } from "../workspace/workspace-discovery";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";

export interface CreateRuntimeApiDependencies {
	getActiveWorkspaceId: () => string | null;
	getActiveRuntimeConfig?: () => RuntimeConfigState;
	loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
	setActiveRuntimeConfig: (config: RuntimeConfigState) => void;
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	getScopedClineTaskSessionService: (scope: RuntimeTrpcWorkspaceScope) => Promise<ClineTaskSessionService>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	/**
	 * Indirection over where a task runs, so tests can stub workspace resolution
	 * without touching the filesystem or Git.
	 */
	resolveTaskExecutionDirectory?: ResolveTaskExecutionDirectory;
	broadcastClineMcpAuthStatusesUpdated?: (
		statuses: Awaited<ReturnType<ReturnType<typeof createClineMcpRuntimeService>["getAuthStatuses"]>>,
	) => void;
	broadcastTaskChatCleared?: (workspaceId: string, taskId: string) => void;
	bumpClineSessionContextVersion?: () => void;
	prepareForStateReset?: () => Promise<void>;
	getUpdateStatus: () => RuntimeUpdateStatusResponse;
	runUpdateNow: () => Promise<RuntimeRunUpdateResponse>;
}

/**
 * Resolve the working directory a task's agent should run in.
 *
 * Delegates the Direct-vs-Isolated decision to `resolveTaskExecutionDirectory`,
 * with home-agent sessions always running in the project root because the
 * sidebar agent is not a task and has no workspace of its own.
 */
async function resolveTaskExecutionWorkingDirectory(
	options: {
		workspaceScope: RuntimeTrpcWorkspaceScope;
		taskId: string;
		baseRef: string;
		executionMode: RuntimeTaskExecutionMode;
		isHomeAgentSession: boolean;
	},
	resolveDirectory: ResolveTaskExecutionDirectory,
): Promise<string> {
	if (options.isHomeAgentSession) {
		return options.workspaceScope.workspacePath;
	}
	const resolved = await resolveDirectory({
		workspaceId: options.workspaceScope.workspaceId,
		workspacePath: options.workspaceScope.workspacePath,
		taskId: options.taskId,
		baseRef: options.baseRef,
		executionMode: options.executionMode,
	});
	return resolved.workingDirectory;
}

/**
 * Thrown when a Direct-mode task cannot start because another Direct task is
 * already writing to the same project root.
 */
export class DirectWorkspaceBusyError extends Error {
	readonly runningTaskIds: string[];

	constructor(runningTaskIds: string[]) {
		super(
			`Another task is already working directly in this project: ${runningTaskIds.join(", ")}. ` +
				"Direct mode allows one writer at a time. Wait for it to finish, stop it, or use Isolated mode for parallel work.",
		);
		this.name = "DirectWorkspaceBusyError";
		this.runningTaskIds = runningTaskIds;
	}
}

/**
 * Guard Direct-mode concurrency (FR-03 / AC-03.6, NFR-02).
 *
 * Direct mode edits the user's real files, so two agents running at once can
 * clobber each other with no isolation to fall back on. Kanban therefore allows
 * a single Direct writer per project. Isolated workspaces are unaffected.
 *
 * `requestedTaskId` is excluded so restarting or resuming a task that is itself
 * the active writer does not trip the guard.
 */
export function findConflictingDirectTaskIds(options: {
	summaries: RuntimeTaskSessionSummary[];
	requestedTaskId: string;
}): string[] {
	return options.summaries
		.filter((summary) => {
			if (summary.taskId === options.requestedTaskId) {
				return false;
			}
			if (summary.executionMode !== "direct") {
				return false;
			}
			return summary.state === "running" || summary.state === "awaiting_review";
		})
		.map((summary) => summary.taskId);
}

/** Look up a task card so session startup can honor its per-task settings. */
async function findWorkspaceTaskCard(workspaceId: string, taskId: string): Promise<RuntimeBoardCard | null> {
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

/**
 * Resolve the permission policy for a task launch.
 *
 * Precedence mirrors execution mode: request override, then the task card, then
 * the project default, then the agent catalog default. An unknown mode id is
 * dropped rather than forwarded so stale config cannot become a CLI injection.
 */
function resolveTaskPermissionPolicy(options: {
	agentId: RuntimeAgentId;
	requestPolicy: RuntimeTaskPermissionPolicy | undefined;
	taskCard: RuntimeBoardCard | null;
	projectDefaultPermissionModeId: string | null;
	autonomousModeEnabled: boolean;
}): { modeId: string | null; autonomousModeEnabled: boolean; extraArgs: string[] } {
	const requestedModeId =
		options.requestPolicy?.mode ??
		options.taskCard?.permissionPolicy?.mode ??
		options.projectDefaultPermissionModeId ??
		getRuntimeAgentDefaultPermissionModeId(options.agentId);

	const validMode = findRuntimeAgentPermissionMode(options.agentId, requestedModeId);
	const extraArgs = options.requestPolicy?.extraArgs ?? options.taskCard?.permissionPolicy?.extraArgs ?? [];

	return {
		modeId: validMode?.id ?? null,
		autonomousModeEnabled:
			options.requestPolicy?.autonomousModeEnabled ??
			options.taskCard?.permissionPolicy?.autonomousModeEnabled ??
			options.autonomousModeEnabled,
		extraArgs: [...extraArgs],
	};
}

async function _resolveExistingTaskCwdOrEnsure(options: {
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
 * Resolve the execution mode a task should run in.
 *
 * Delegates the precedence rule to `resolveEffectiveExecutionMode`, so session
 * startup, the preflight, shell sessions, and status reporting can never disagree
 * about where a task runs.
 */
function resolveTaskExecutionMode(options: {
	requestedMode?: RuntimeTaskExecutionMode | null;
	taskCard: RuntimeBoardCard | null;
	projectDefaultExecutionMode?: RuntimeTaskExecutionMode;
}): RuntimeTaskExecutionMode {
	return resolveEffectiveExecutionMode({
		requestedMode: options.requestedMode,
		taskMode: options.taskCard?.executionMode,
		projectDefaultMode: options.projectDefaultExecutionMode,
	});
}

/**
 * Resolve a task's execution mode for callers that only have its id.
 *
 * Project defaults are not consulted: reading the scoped runtime config would add
 * a round trip for no behavioral gain when the card already knows its mode. A
 * legacy card with no stored mode falls back to its workspace-type default, which
 * is the behavior it originally ran with.
 */
async function resolveTaskExecutionModeForTask(
	workspaceId: string,
	workspacePath: string,
	taskId: string,
): Promise<RuntimeTaskExecutionMode> {
	const taskCard = await findWorkspaceTaskCard(workspaceId, taskId);
	if (taskCard?.executionMode) {
		return resolveEffectiveExecutionMode({ taskMode: taskCard.executionMode });
	}
	const discovery = await loadWorkspaceDiscovery(workspaceId, workspacePath).catch(() => null);
	return resolveEffectiveExecutionMode({ workspaceType: discovery?.workspaceType ?? null });
}

export function createRuntimeApi(deps: CreateRuntimeApiDependencies): RuntimeTrpcContext["runtimeApi"] {
	const clineProviderService = createClineProviderService();
	const clineMcpSettingsService = createClineMcpSettingsService();
	const clineMcpRuntimeService = createClineMcpRuntimeService({
		onAuthStatusesChanged: (statuses) => {
			deps.broadcastClineMcpAuthStatusesUpdated?.(statuses);
		},
	});
	const debugResetTargetPaths = [
		join(homedir(), ".cline", "data"),
		join(homedir(), ".cline", "kanban"),
		join(homedir(), ".cline", "worktrees"),
	] as const;

	const buildConfigResponse = (runtimeConfig: RuntimeConfigState) =>
		buildRuntimeConfigResponse(runtimeConfig, clineProviderService.getProviderSettingsSummary());

	return {
		loadConfig: async (workspaceScope) => {
			const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
			if (!workspaceScope && !activeRuntimeConfig) {
				throw new Error("No active runtime config provider is available.");
			}
			let scopedRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
			} else if (activeRuntimeConfig) {
				scopedRuntimeConfig = activeRuntimeConfig;
			} else {
				throw new Error("No active runtime config provider is available.");
			}
			return buildConfigResponse(scopedRuntimeConfig);
		},
		saveConfig: async (workspaceScope, input) => {
			const parsed = parseRuntimeConfigSaveRequest(input);
			let nextRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				nextRuntimeConfig = await updateRuntimeConfig(workspaceScope.workspacePath, parsed);
			} else {
				const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
				if (!activeRuntimeConfig) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "No active runtime config is available.",
					});
				}
				nextRuntimeConfig = await updateGlobalRuntimeConfig(activeRuntimeConfig, parsed);
			}
			if (workspaceScope && workspaceScope.workspaceId === deps.getActiveWorkspaceId()) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			if (!workspaceScope) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			return buildConfigResponse(nextRuntimeConfig);
		},
		saveClineProviderSettings: async (_workspaceScope, input) => {
			const body = parseClineProviderSettingsSaveRequest(input);
			const response = clineProviderService.saveProviderSettings(body);
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		addClineProvider: async (_workspaceScope, input) => {
			const body = parseClineAddProviderRequest(input);
			const response = await clineProviderService.addCustomProvider(body);
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		updateClineProvider: async (_workspaceScope, input) => {
			const body = parseClineUpdateProviderRequest(input);
			const response = await clineProviderService.updateCustomProvider(body);
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		startTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStartRequest(input);
				if (body.resumeFromTrash) {
					deps.broadcastTaskChatCleared?.(workspaceScope.workspaceId, body.taskId);
				}
				const requestedClineTaskMode = body.mode ?? "act";
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);

				const taskCard = isHomeAgentSessionId(body.taskId)
					? null
					: await findWorkspaceTaskCard(workspaceScope.workspaceId, body.taskId);
				const executionMode = resolveTaskExecutionMode({
					requestedMode: body.executionMode,
					taskCard,
					projectDefaultExecutionMode: scopedRuntimeConfig.projectDefaultExecutionMode,
				});

				const taskCwd = await resolveTaskExecutionWorkingDirectory(
					{
						workspaceScope,
						taskId: body.taskId,
						baseRef: body.baseRef,
						executionMode,
						isHomeAgentSession: isHomeAgentSessionId(body.taskId),
					},
					deps.resolveTaskExecutionDirectory ?? resolveTaskExecutionDirectory,
				);
				const shouldCaptureTurnCheckpoint = !body.resumeFromTrash && !isHomeAgentSessionId(body.taskId);

				// Per-task config source-of-truth precedence:
				//
				// agentId resolution (which agent runtime to use):
				//   1. previousTerminalAgentId — persisted in the terminal session summary from
				//      the last run; ensures trash-restore resumes with the same agent runtime.
				//   2. body.agentId — the card's current per-task agent override.
				//   3. scopedRuntimeConfig.selectedAgentId — the workspace-level default.
				//
				// clineSettings (which LLM model and reasoning profile the Cline agent uses):
				//   Always taken from the card's current override object. There is no
				//   session-level persistence for these;
				//   if the user changes the model on the card, the next session launch
				//   (including trash-restore) uses the updated values.
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);

				// Direct mode has no isolation, so only one Direct writer may run per
				// project at a time (FR-03 / AC-03.6). Isolated tasks are unaffected.
				if (executionMode === "direct" && !isHomeAgentSessionId(body.taskId)) {
					const clineTaskSessionServiceForGuard = await deps.getScopedClineTaskSessionService(workspaceScope);
					const conflictingTaskIds = findConflictingDirectTaskIds({
						summaries: [...terminalManager.listSummaries(), ...clineTaskSessionServiceForGuard.listSummaries()],
						requestedTaskId: body.taskId,
					});
					if (conflictingTaskIds.length > 0) {
						return {
							ok: false,
							summary: null,
							error: new DirectWorkspaceBusyError(conflictingTaskIds).message,
						};
					}
				}

				const previousTerminalAgentId = body.resumeFromTrash
					? (terminalManager.getSummary(body.taskId)?.agentId ?? null)
					: null;
				const effectiveAgentId = previousTerminalAgentId ?? body.agentId ?? scopedRuntimeConfig.selectedAgentId;
				let useClinePath = effectiveAgentId === "cline";
				const shouldProbePersistedClineSession =
					body.resumeFromTrash && !useClinePath && previousTerminalAgentId === null;
				if (shouldProbePersistedClineSession) {
					// If the terminal summary already has a concrete non-Cline agentId,
					// skip Cline persisted-session probing. That probe can cold-start the
					// Cline session host and adds multi-second latency to Codex restores.
					const clineSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
					const persistedSession = await clineSessionService
						.rebindPersistedTaskSession(body.taskId)
						.catch(() => null);
					if (persistedSession) {
						useClinePath = true;
					}
				}

				if (useClinePath) {
					const hasTaskLevelClineSettingsOverride = body.clineSettings !== undefined;
					const clineLaunchConfig = await clineProviderService.resolveLaunchConfig({
						providerIdOverride: body.clineSettings?.providerId ?? undefined,
						modelIdOverride: body.clineSettings?.modelId ?? undefined,
						...(hasTaskLevelClineSettingsOverride
							? {
									reasoningEffortOverride: body.clineSettings?.reasoningEffort ?? null,
								}
							: {}),
					});
					const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
					const resolvedClineTitle = resolveTaskTitle(body.taskTitle?.trim(), body.prompt);
					const summary = await clineTaskSessionService.startTaskSession({
						taskId: body.taskId,
						cwd: taskCwd,
						prompt: body.prompt,
						taskTitle: resolvedClineTitle.length > 0 ? resolvedClineTitle : undefined,
						images: body.images,
						resumeFromTrash: body.resumeFromTrash,
						providerId: clineLaunchConfig.providerId,
						modelId: clineLaunchConfig.modelId,
						mode: requestedClineTaskMode,
						startInPlanMode: body.startInPlanMode,
						apiKey: clineLaunchConfig.apiKey,
						baseUrl: clineLaunchConfig.baseUrl,
						reasoningEffort: clineLaunchConfig.reasoningEffort,
					});

					let nextSummary = summary;
					if (shouldCaptureTurnCheckpoint) {
						try {
							const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
							const checkpoint = await captureTaskTurnCheckpoint({
								cwd: taskCwd,
								taskId: body.taskId,
								turn: nextTurn,
							});
							nextSummary = clineTaskSessionService.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
						} catch {
							// Best effort checkpointing only.
						}
					}

					return {
						ok: true,
						summary: nextSummary,
					};
				}

				const resolvedConfig =
					effectiveAgentId !== scopedRuntimeConfig.selectedAgentId
						? { ...scopedRuntimeConfig, selectedAgentId: effectiveAgentId }
						: scopedRuntimeConfig;
				const resolved = resolveAgentCommand(resolvedConfig);
				if (!resolved) {
					return {
						ok: false,
						summary: null,
						error: "No runnable agent command is configured. Open Settings, install a supported CLI, and select it.",
					};
				}
				const resolvedPermissionPolicy = resolveTaskPermissionPolicy({
					agentId: resolved.agentId,
					requestPolicy: body.permissionPolicy,
					taskCard,
					projectDefaultPermissionModeId: scopedRuntimeConfig.projectDefaultPermissionModeId,
					autonomousModeEnabled: scopedRuntimeConfig.agentAutonomousModeEnabled,
				});
				const summary = await terminalManager.startTaskSession({
					taskId: body.taskId,
					agentId: resolved.agentId,
					binary: resolved.binary,
					args: resolved.args,
					autonomousModeEnabled: resolvedPermissionPolicy.autonomousModeEnabled,
					permissionPolicy: {
						modeId: resolvedPermissionPolicy.modeId,
						autonomousModeEnabled: resolvedPermissionPolicy.autonomousModeEnabled,
						extraArgs: resolvedPermissionPolicy.extraArgs,
					},
					model: body.model ?? taskCard?.model,
					cwd: taskCwd,
					prompt: body.prompt,
					images: body.images,
					startInPlanMode: body.startInPlanMode,
					resumeFromTrash: body.resumeFromTrash,
					cols: body.cols,
					rows: body.rows,
					workspaceId: workspaceScope.workspaceId,
					executionMode,
					permissionModeId: resolvedPermissionPolicy.modeId,
				});

				let nextSummary = summary;
				if (shouldCaptureTurnCheckpoint) {
					try {
						const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
						const checkpoint = await captureTaskTurnCheckpoint({
							cwd: taskCwd,
							taskId: body.taskId,
							turn: nextTurn,
						});
						nextSummary = terminalManager.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
					} catch {
						// Best effort checkpointing only.
					}
				}
				return {
					ok: true,
					summary: nextSummary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		stopTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStopRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const clineSummary = await clineTaskSessionService.stopTaskSession(body.taskId);
				if (clineSummary) {
					return {
						ok: true,
						summary: clineSummary,
					};
				}
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.stopTaskSession(body.taskId);
				return {
					ok: Boolean(summary),
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		sendTaskSessionInput: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionInputRequest(input);
				const payloadText = body.appendNewline ? `${body.text}\n` : body.text;
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const clineSummary = await clineTaskSessionService.sendTaskSessionInput(body.taskId, payloadText);
				if (clineSummary) {
					return {
						ok: true,
						summary: clineSummary,
					};
				}
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.writeInput(body.taskId, Buffer.from(payloadText, "utf8"));
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task session is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		getTaskChatMessages: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatMessagesRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = clineTaskSessionService.getSummary(body.taskId);
				const messages = await clineTaskSessionService.loadTaskSessionMessages(body.taskId);
				if (!summary && messages.length === 0) {
					return {
						ok: false,
						messages: [],
						error: "Task chat session is not available.",
					};
				}
				return {
					ok: true,
					messages,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					messages: [],
					error: message,
				};
			}
		},
		getClineSlashCommands: async (workspaceScope) => {
			if (!workspaceScope) {
				return {
					commands: [],
				};
			}
			const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
			return {
				commands: await clineTaskSessionService.listSlashCommands(workspaceScope.workspacePath),
			};
		},
		reloadTaskChatSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatReloadRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				let summary = await clineTaskSessionService.reloadTaskSession(body.taskId);
				if (!summary && isHomeAgentSessionId(body.taskId)) {
					const clineLaunchConfig = await clineProviderService.resolveLaunchConfig();
					summary = await clineTaskSessionService.startTaskSession({
						taskId: body.taskId,
						cwd: workspaceScope.workspacePath,
						prompt: "",
						resumeFromPersistence: true,
						providerId: clineLaunchConfig.providerId,
						modelId: clineLaunchConfig.modelId,
						apiKey: clineLaunchConfig.apiKey,
						baseUrl: clineLaunchConfig.baseUrl,
						reasoningEffort: clineLaunchConfig.reasoningEffort,
					});
				}
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session is not available.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		abortTaskChatTurn: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatAbortRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = await clineTaskSessionService.abortTaskSession(body.taskId);
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		cancelTaskChatTurn: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatCancelRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = await clineTaskSessionService.cancelTaskTurn(body.taskId);
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session turn is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		getClineProviderCatalog: async (_workspaceScope) => {
			return await clineProviderService.getProviderCatalog();
		},
		getClineAccountProfile: async (_workspaceScope) => {
			return await clineProviderService.getClineAccountProfile();
		},
		getClineKanbanAccess: async (_workspaceScope) => {
			return await clineProviderService.getClineKanbanAccess();
		},
		getFeaturebaseToken: async (_workspaceScope) => {
			return await clineProviderService.getFeaturebaseToken();
		},
		getClineAccountBalance: async (_workspaceScope) => {
			return await clineProviderService.getClineAccountBalance();
		},
		getClineAccountOrganizations: async (_workspaceScope) => {
			return await clineProviderService.getClineAccountOrganizations();
		},
		switchClineAccount: async (_workspaceScope, input) => {
			const body = parseClineAccountSwitchRequest(input);
			return await clineProviderService.switchClineAccount(body.organizationId);
		},
		getClineProviderModels: async (_workspaceScope, input) => {
			const body = parseClineProviderModelsRequest(input);
			return await clineProviderService.getProviderModels(body.providerId);
		},
		getClineMcpAuthStatuses: async (_workspaceScope) => {
			const statuses = await clineMcpRuntimeService.getAuthStatuses();
			return {
				statuses,
			};
		},
		runClineMcpServerOAuth: async (_workspaceScope, input) => {
			const body = parseClineMcpOAuthRequest(input);
			const response = await clineMcpRuntimeService.authorizeServer({
				serverName: body.serverName,
				onAuthorizationUrl: (url: string) => {
					openInBrowser(url);
				},
			});
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		getClineMcpSettings: async (_workspaceScope) => {
			return clineMcpSettingsService.loadSettings();
		},
		saveClineMcpSettings: async (_workspaceScope, input) => {
			const body = parseClineMcpSettingsSaveRequest(input);
			const response = await clineMcpSettingsService.saveSettings(body);
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		runClineProviderOAuthLogin: async (_workspaceScope, input) => {
			const body = parseClineOauthLoginRequest(input);
			const response = await clineProviderService.runOauthLogin({
				providerId: body.provider,
				baseUrl: body.baseUrl,
			});
			if (response.ok) {
				deps.bumpClineSessionContextVersion?.();
			}
			return response;
		},
		startClineDeviceAuth: async () => {
			return await clineProviderService.startDeviceAuth();
		},
		completeClineDeviceAuth: async (_workspaceScope, input) => {
			const body = parseClineDeviceAuthCompleteRequest(input);
			const response = await clineProviderService.completeDeviceAuth({
				deviceCode: body.deviceCode,
				expiresInSeconds: body.expiresInSeconds,
				pollIntervalSeconds: body.pollIntervalSeconds,
				baseUrl: body.baseUrl,
			});
			if (response.ok) {
				deps.bumpClineSessionContextVersion?.();
			}
			return response;
		},
		sendTaskChatMessage: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatSendRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				if (isClineClearSlashCommand(body.text)) {
					const summary = await clineTaskSessionService.clearTaskSession(body.taskId);
					deps.broadcastTaskChatCleared?.(workspaceScope.workspaceId, body.taskId);
					return {
						ok: true,
						summary,
						message: null,
					};
				}
				const requestedMode = body.mode;
				let summary = await clineTaskSessionService.sendTaskSessionInput(
					body.taskId,
					body.text,
					requestedMode,
					body.images,
				);
				if (!summary) {
					if (!isHomeAgentSessionId(body.taskId)) {
						const reboundSummary = await clineTaskSessionService.rebindPersistedTaskSession(body.taskId);
						if (reboundSummary) {
							summary = await clineTaskSessionService.sendTaskSessionInput(
								body.taskId,
								body.text,
								requestedMode,
								body.images,
							);
						}
						if (!summary) {
							return {
								ok: false,
								summary: null,
								error: "Task chat session is not running.",
							};
						}
					} else {
						const clineLaunchConfig = await clineProviderService.resolveLaunchConfig();
						summary = await clineTaskSessionService.startTaskSession({
							taskId: body.taskId,
							cwd: workspaceScope.workspacePath,
							prompt: body.text,
							images: body.images,
							resumeFromPersistence: true,
							providerId: clineLaunchConfig.providerId,
							modelId: clineLaunchConfig.modelId,
							mode: requestedMode,
							apiKey: clineLaunchConfig.apiKey,
							baseUrl: clineLaunchConfig.baseUrl,
							reasoningEffort: clineLaunchConfig.reasoningEffort,
						});
					}
				}
				const latestMessage = clineTaskSessionService.listMessages(body.taskId).at(-1) ?? null;
				return {
					ok: true,
					summary,
					message: latestMessage,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		startShellSession: async (workspaceScope, input) => {
			try {
				const body = parseShellSessionStartRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const shell = deps.resolveInteractiveShellCommand();
				/*
					A task-scoped shell must open in the directory the agent used. Resolving a
					Git worktree unconditionally put a Direct task's shell next to files the
					agent never touched, and failed outright for non-Git projects.
				*/
				const shellCwd = body.workspaceTaskId
					? await resolveTaskExecutionWorkingDirectory(
							{
								workspaceScope,
								taskId: body.workspaceTaskId,
								baseRef: body.baseRef,
								executionMode: await resolveTaskExecutionModeForTask(
									workspaceScope.workspaceId,
									workspaceScope.workspacePath,
									body.workspaceTaskId,
								),
								isHomeAgentSession: false,
							},
							deps.resolveTaskExecutionDirectory ?? resolveTaskExecutionDirectory,
						)
					: workspaceScope.workspacePath;
				const summary = await terminalManager.startShellSession({
					taskId: body.taskId,
					cwd: shellCwd,
					cols: body.cols,
					rows: body.rows,
					binary: shell.binary,
					args: shell.args,
				});
				return {
					ok: true,
					summary,
					shellBinary: shell.binary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					shellBinary: null,
					error: message,
				};
			}
		},
		runCommand: async (workspaceScope, input) => {
			try {
				const body = parseCommandRunRequest(input);
				return await deps.runCommand(body.command, workspaceScope.workspacePath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message,
				});
			}
		},
		resetAllState: async (_workspaceScope) => {
			await deps.prepareForStateReset?.();
			await Promise.all(
				debugResetTargetPaths.map(async (path) => {
					await rm(path, { recursive: true, force: true });
				}),
			);
			return {
				ok: true,
				clearedPaths: [...debugResetTargetPaths],
			};
		},
		openFile: async (input) => {
			const filePath = input.filePath.trim();
			if (!filePath) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "File path cannot be empty.",
				});
			}
			openInBrowser(filePath);
			return { ok: true };
		},
		getUpdateStatus: async () => {
			return deps.getUpdateStatus();
		},
		runUpdateNow: async () => {
			return await deps.runUpdateNow();
		},
	};
}
