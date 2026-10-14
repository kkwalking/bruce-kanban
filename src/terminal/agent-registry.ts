import type { RuntimeConfigState } from "../config/runtime-config";
import {
	getRuntimeAgentCatalogEntry,
	getRuntimeLaunchSupportedAgentCatalog,
	isRuntimeAgentLaunchSupported,
	RUNTIME_AGENT_CATALOG,
} from "../core/agent-catalog";
import type {
	RuntimeAgentDefinition,
	RuntimeAgentId,
	RuntimeClineProviderSettings,
	RuntimeConfigResponse,
} from "../core/api-contract";
import { isBinaryAvailableOnPath } from "./command-discovery";

export interface ResolvedAgentCommand {
	agentId: RuntimeAgentId;
	label: string;
	command: string;
	binary: string;
	args: string[];
}

function getDefaultArgs(agentId: RuntimeAgentId): string[] {
	const entry = RUNTIME_AGENT_CATALOG.find((candidate) => candidate.id === agentId);
	if (!entry) {
		return [];
	}
	return [...entry.baseArgs];
}

function quoteForDisplay(part: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(part)) {
		return part;
	}
	return JSON.stringify(part);
}

function joinCommand(binary: string, args: string[]): string {
	if (args.length === 0) {
		return binary;
	}
	return [binary, ...args.map(quoteForDisplay)].join(" ");
}

function parseBooleanEnvValue(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isRuntimeDebugModeEnabled(): boolean {
	const debugModeValue = process.env.KANBAN_DEBUG_MODE ?? process.env.DEBUG_MODE ?? process.env.debug_mode;
	return parseBooleanEnvValue(debugModeValue);
}

export function detectInstalledCommands(): string[] {
	const candidates = [...RUNTIME_AGENT_CATALOG.map((entry) => entry.binary), "npx"];
	const detected: string[] = [];

	for (const candidate of candidates) {
		if (isBinaryAvailableOnPath(candidate)) {
			detected.push(candidate);
		}
	}

	return detected;
}

function getCuratedDefinitions(runtimeConfig: RuntimeConfigState, detected: string[]): RuntimeAgentDefinition[] {
	const detectedSet = new Set(detected);
	return getRuntimeLaunchSupportedAgentCatalog().map((entry) => {
		const defaultArgs = getDefaultArgs(entry.id);
		const command = joinCommand(entry.binary, defaultArgs);
		const isInstalled = entry.id === "cline" ? true : detectedSet.has(entry.binary);
		return {
			id: entry.id,
			label: entry.label,
			binary: entry.binary,
			command,
			defaultArgs,
			installed: isInstalled,
			configured: runtimeConfig.selectedAgentId === entry.id,
			installUrl: entry.installUrl,
			capabilities: entry.capabilities,
			permissionModes: entry.permissionModes.map((mode) => ({
				id: mode.id,
				label: mode.label,
				description: mode.description,
				args: [...mode.args],
				env: { ...mode.env },
				risky: mode.risky,
			})),
			defaultPermissionModeId: entry.defaultPermissionModeId,
		};
	});
}

export function resolveAgentCommand(runtimeConfig: RuntimeConfigState): ResolvedAgentCommand | null {
	const selected = getRuntimeLaunchSupportedAgentCatalog().find((entry) => entry.id === runtimeConfig.selectedAgentId);
	if (!selected) {
		return null;
	}
	const defaultArgs = getDefaultArgs(selected.id);
	const command = joinCommand(selected.binary, defaultArgs);
	if (isBinaryAvailableOnPath(selected.binary)) {
		return {
			agentId: selected.id,
			label: selected.label,
			command,
			binary: selected.binary,
			args: defaultArgs,
		};
	}
	return null;
}

/**
 * Resolve which agent a task should run, in precedence order:
 *
 * 1. an explicit per-task agent override,
 * 2. the workspace-level default,
 * 3. the first installed supported agent.
 *
 * Returning a fallback instead of `null` keeps one missing CLI from blocking
 * task startup for every other agent.
 */
export function resolveLaunchableAgentId(options: {
	runtimeConfig: RuntimeConfigState;
	preferredAgentId?: RuntimeAgentId | null;
	detectedCommands?: string[];
}): RuntimeAgentId | null {
	const detected = new Set(options.detectedCommands ?? detectInstalledCommands());
	const isLaunchable = (agentId: RuntimeAgentId): boolean => {
		if (!isRuntimeAgentLaunchSupported(agentId)) {
			return false;
		}
		if (agentId === "cline") {
			return true;
		}
		const binary = getRuntimeAgentCatalogEntry(agentId)?.binary ?? agentId;
		return detected.has(binary);
	};

	const preferred = options.preferredAgentId;
	if (preferred && isLaunchable(preferred)) {
		return preferred;
	}
	if (isLaunchable(options.runtimeConfig.selectedAgentId)) {
		return options.runtimeConfig.selectedAgentId;
	}
	for (const entry of getRuntimeLaunchSupportedAgentCatalog()) {
		if (isLaunchable(entry.id)) {
			return entry.id;
		}
	}
	return null;
}

export function buildRuntimeConfigResponse(
	runtimeConfig: RuntimeConfigState,
	clineProviderSettings: RuntimeClineProviderSettings,
): RuntimeConfigResponse {
	const detectedCommands = detectInstalledCommands();
	const agents = getCuratedDefinitions(runtimeConfig, detectedCommands);
	const resolved = resolveAgentCommand(runtimeConfig);
	const effectiveCommand = resolved ? joinCommand(resolved.binary, resolved.args) : null;

	return {
		selectedAgentId: runtimeConfig.selectedAgentId,
		selectedShortcutLabel: runtimeConfig.selectedShortcutLabel,
		agentAutonomousModeEnabled: runtimeConfig.agentAutonomousModeEnabled,
		debugModeEnabled: isRuntimeDebugModeEnabled(),
		effectiveCommand,
		globalConfigPath: runtimeConfig.globalConfigPath,
		projectConfigPath: runtimeConfig.projectConfigPath,
		readyForReviewNotificationsEnabled: runtimeConfig.readyForReviewNotificationsEnabled,
		detectedCommands,
		agents,
		shortcuts: runtimeConfig.shortcuts,
		clineProviderSettings,
		commitPromptTemplate: runtimeConfig.commitPromptTemplate,
		openPrPromptTemplate: runtimeConfig.openPrPromptTemplate,
		commitPromptTemplateDefault: runtimeConfig.commitPromptTemplateDefault,
		openPrPromptTemplateDefault: runtimeConfig.openPrPromptTemplateDefault,
		projectDefaults: {
			executionMode: runtimeConfig.projectDefaultExecutionMode,
			permissionModeId: runtimeConfig.projectDefaultPermissionModeId,
		},
	};
}
