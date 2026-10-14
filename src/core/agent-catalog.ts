import type {
	RuntimeAgentCapabilities,
	RuntimeAgentId,
	RuntimeAgentPermissionMode,
	RuntimeTaskPermissionPolicy,
} from "./api-contract";

/**
 * Catalog-side permission mode.
 *
 * Same shape as {@link RuntimeAgentPermissionMode} plus `planModeOnly`, which is
 * a launch-time constraint the browser never needs to know about.
 */
export interface RuntimeAgentCatalogPermissionMode extends RuntimeAgentPermissionMode {
	/** When true this mode is only valid together with plan-mode startup. */
	planModeOnly?: boolean;
}

/**
 * Capability declaration for one agent backend.
 *
 * These flags exist so the UI never promises behavior a backend cannot deliver
 * (for example session resume or structured hook events). A missing capability
 * degrades gracefully rather than being faked.
 */
export interface RuntimeAgentCatalogEntry {
	id: RuntimeAgentId;
	label: string;
	binary: string;
	baseArgs: string[];
	/**
	 * Flags applied when the user enables autonomous/auto-approve mode.
	 *
	 * Deliberately separate from permission modes: autonomy answers "how much
	 * should the agent do unattended", permissions answer "what is it allowed to
	 * touch". Neither implies the other.
	 *
	 * Empty for backends whose autonomy *is* a permission mode (Claude Code), so
	 * that enabling autonomy cannot silently raise permissions. Those backends
	 * express autonomy only through an explicitly chosen permission mode.
	 */
	autonomousArgs: string[];
	installUrl: string;
	capabilities: RuntimeAgentCapabilities;
	permissionModes: RuntimeAgentCatalogPermissionMode[];
	/** Permission mode id used when the user has not chosen one. `null` keeps CLI defaults. */
	defaultPermissionModeId: string | null;
	/** Flag that selects a model, e.g. `--model`. Null when the CLI has no such flag. */
	modelFlag: string | null;
	/** Whether extra user-configured args are appended for this backend. */
	supportsUserArgs: boolean;
}

const DEFAULT_CAPABILITIES: RuntimeAgentCapabilities = {
	interactiveTui: true,
	hookEvents: false,
	sessionResume: false,
	permissionPrompts: false,
	modelSelection: false,
	nativeChat: false,
};

/** Claude Code permission modes, matching the CLI's own vocabulary. */
const CLAUDE_PERMISSION_MODES: RuntimeAgentCatalogPermissionMode[] = [
	{
		id: "default",
		label: "Default",
		description: "Use Claude Code's own default permission behavior. Also accepts a bare `claude` CLI default.",
		args: [],
		env: {},
		risky: false,
	},
	{
		id: "plan",
		label: "Plan",
		description: "Plan mode: investigate and propose changes without editing files.",
		args: ["--permission-mode", "plan"],
		env: {},
		risky: false,
	},
	{
		id: "acceptEdits",
		label: "Accept edits",
		description: "Automatically accept file edits while still prompting for other actions.",
		args: ["--permission-mode", "acceptEdits"],
		env: {},
		risky: false,
	},
	{
		id: "auto",
		label: "Auto",
		description: "Autonomous mode. Claude proceeds without asking for most permissions.",
		args: ["--permission-mode", "auto"],
		// Auto mode is gated behind this env var on Bedrock/Vertex/Foundry.
		env: { CLAUDE_CODE_ENABLE_AUTO_MODE: "1" },
		risky: true,
	},
	{
		id: "bypassPermissions",
		label: "Bypass permissions",
		description: "Skip all permission checks. Only use in trusted, disposable workspaces.",
		args: ["--dangerously-skip-permissions"],
		env: {},
		risky: true,
	},
];

/**
 * Fallback permission modes for CLIs whose permission surface is either
 * binary (trust all tools vs. ask) or absent.
 */
function createBinaryPermissionModes(options: {
	autonomousArgs: string[];
	autonomousLabel: string;
	autonomousDescription: string;
}): RuntimeAgentCatalogPermissionMode[] {
	const modes: RuntimeAgentCatalogPermissionMode[] = [
		{
			id: "default",
			label: "Default",
			description: "Use the CLI's own default permission behavior.",
			args: [],
			env: {},
			risky: false,
		},
	];
	if (options.autonomousArgs.length > 0) {
		modes.push({
			id: "autonomous",
			label: options.autonomousLabel,
			description: options.autonomousDescription,
			args: [...options.autonomousArgs],
			env: {},
			risky: true,
		});
	}
	return modes;
}

export const RUNTIME_AGENT_CATALOG: RuntimeAgentCatalogEntry[] = [
	{
		id: "claude",
		label: "Claude Code",
		binary: "claude",
		baseArgs: [],
		// Claude Code expresses autonomy *as* a permission mode, so there is no
		// separate autonomy flag to apply. Auto mode is reachable only by
		// explicitly selecting the "auto" permission mode.
		autonomousArgs: [],
		installUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
		capabilities: {
			...DEFAULT_CAPABILITIES,
			hookEvents: true,
			sessionResume: true,
			permissionPrompts: true,
			modelSelection: true,
		},
		permissionModes: CLAUDE_PERMISSION_MODES,
		// Deliberately "default", not "auto": Kanban must never silently raise
		// permissions on the user's behalf.
		defaultPermissionModeId: "default",
		modelFlag: "--model",
		supportsUserArgs: true,
	},
	{
		id: "codex",
		label: "OpenAI Codex",
		binary: "codex",
		baseArgs: [],
		autonomousArgs: ["--dangerously-bypass-approvals-and-sandbox"],
		installUrl: "https://github.com/openai/codex",
		capabilities: {
			...DEFAULT_CAPABILITIES,
			hookEvents: true,
			sessionResume: true,
			permissionPrompts: true,
			modelSelection: true,
		},
		permissionModes: createBinaryPermissionModes({
			autonomousArgs: ["--dangerously-bypass-approvals-and-sandbox"],
			autonomousLabel: "Bypass approvals",
			autonomousDescription: "Skip approval prompts and sandbox restrictions.",
		}),
		defaultPermissionModeId: "default",
		modelFlag: "--model",
		supportsUserArgs: true,
	},
	{
		id: "pi",
		label: "Pi",
		binary: "pi",
		baseArgs: [],
		autonomousArgs: ["--approve"],
		installUrl: "https://github.com/badlogic/pi-mono",
		capabilities: {
			...DEFAULT_CAPABILITIES,
			sessionResume: true,
			modelSelection: true,
		},
		permissionModes: [
			{
				id: "default",
				label: "Default",
				description: "Use Pi's own approval behavior for project-local files.",
				args: [],
				env: {},
				risky: false,
			},
			{
				id: "approve",
				label: "Trust project files",
				description: "Trust project-local files (extensions, skills, prompts) for this run.",
				args: ["--approve"],
				env: {},
				risky: true,
			},
			{
				id: "no-approve",
				label: "Ignore project files",
				description: "Ignore project-local configuration files for this run.",
				args: ["--no-approve"],
				env: {},
				risky: false,
			},
		],
		defaultPermissionModeId: "default",
		modelFlag: "--model",
		supportsUserArgs: true,
	},
	{
		id: "opencode",
		label: "OpenCode",
		binary: "opencode",
		baseArgs: [],
		autonomousArgs: ["--auto"],
		installUrl: "https://github.com/sst/opencode",
		capabilities: {
			...DEFAULT_CAPABILITIES,
			hookEvents: true,
			sessionResume: true,
			permissionPrompts: true,
			modelSelection: true,
		},
		permissionModes: createBinaryPermissionModes({
			autonomousArgs: ["--auto"],
			autonomousLabel: "Auto-approve",
			autonomousDescription: "Auto-approve permissions that are not explicitly denied.",
		}),
		defaultPermissionModeId: "default",
		modelFlag: "--model",
		supportsUserArgs: true,
	},
	{
		id: "cline",
		label: "Cline",
		binary: "cline",
		baseArgs: [],
		autonomousArgs: ["--auto-approve-all"],
		installUrl: "https://github.com/cline/cline",
		capabilities: {
			...DEFAULT_CAPABILITIES,
			nativeChat: true,
			hookEvents: true,
			sessionResume: true,
			permissionPrompts: true,
			modelSelection: true,
		},
		permissionModes: [
			{
				id: "default",
				label: "Default",
				description: "Ask for approval before acting.",
				args: [],
				env: {},
				risky: false,
			},
			{
				id: "autonomous",
				label: "Auto-approve all",
				description: "Automatically approve all tool calls.",
				args: ["--auto-approve-all"],
				env: {},
				risky: true,
			},
		],
		defaultPermissionModeId: "default",
		modelFlag: null,
		supportsUserArgs: true,
	},
	{
		id: "droid",
		label: "Factory Droid",
		binary: "droid",
		baseArgs: [],
		autonomousArgs: ["--auto", "high"],
		installUrl: "https://docs.factory.ai/cli/getting-started/quickstart",
		capabilities: {
			...DEFAULT_CAPABILITIES,
			hookEvents: true,
			sessionResume: true,
			permissionPrompts: true,
		},
		permissionModes: createBinaryPermissionModes({
			autonomousArgs: ["--auto", "high"],
			autonomousLabel: "Auto (high)",
			autonomousDescription: "Run autonomously with high autonomy.",
		}),
		defaultPermissionModeId: "default",
		modelFlag: null,
		supportsUserArgs: true,
	},
	{
		id: "kiro",
		label: "Kiro",
		binary: "kiro-cli",
		baseArgs: ["chat"],
		autonomousArgs: ["--trust-all-tools"],
		installUrl: "https://kiro.dev",
		capabilities: {
			...DEFAULT_CAPABILITIES,
			hookEvents: true,
			sessionResume: true,
			permissionPrompts: true,
		},
		permissionModes: createBinaryPermissionModes({
			autonomousArgs: ["--trust-all-tools"],
			autonomousLabel: "Trust all tools",
			autonomousDescription: "Trust every tool without prompting.",
		}),
		defaultPermissionModeId: "default",
		modelFlag: null,
		supportsUserArgs: true,
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		binary: "gemini",
		baseArgs: [],
		autonomousArgs: ["--yolo"],
		installUrl: "https://github.com/google-gemini/gemini-cli",
		capabilities: {
			...DEFAULT_CAPABILITIES,
			hookEvents: true,
			sessionResume: true,
			permissionPrompts: true,
			modelSelection: true,
		},
		permissionModes: createBinaryPermissionModes({
			autonomousArgs: ["--yolo"],
			autonomousLabel: "YOLO",
			autonomousDescription: "Auto-approve all tool calls.",
		}),
		defaultPermissionModeId: "default",
		modelFlag: "--model",
		supportsUserArgs: true,
	},
];

/**
 * Agents Kanban can launch today.
 *
 * `cline` runs through the native SDK chat runtime; `claude`, `codex`, `pi`,
 * and `opencode` are the CLI backends the spec requires. The remaining entries
 * stay in the catalog for metadata but are not offered until launch support is
 * verified again.
 */
export const RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS: readonly RuntimeAgentId[] = [
	"cline",
	"claude",
	"codex",
	"pi",
	"opencode",
];

const RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET = new Set<RuntimeAgentId>(RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS);

export function isRuntimeAgentLaunchSupported(agentId: RuntimeAgentId): boolean {
	return RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET.has(agentId);
}

export function getRuntimeLaunchSupportedAgentCatalog(): RuntimeAgentCatalogEntry[] {
	return RUNTIME_AGENT_CATALOG.filter((entry) => isRuntimeAgentLaunchSupported(entry.id));
}

export function getRuntimeAgentCatalogEntry(agentId: RuntimeAgentId): RuntimeAgentCatalogEntry | null {
	return RUNTIME_AGENT_CATALOG.find((entry) => entry.id === agentId) ?? null;
}

export function getRuntimeAgentCapabilities(agentId: RuntimeAgentId): RuntimeAgentCapabilities {
	return getRuntimeAgentCatalogEntry(agentId)?.capabilities ?? DEFAULT_CAPABILITIES;
}

export function getRuntimeAgentPermissionModes(agentId: RuntimeAgentId): RuntimeAgentCatalogPermissionMode[] {
	return getRuntimeAgentCatalogEntry(agentId)?.permissionModes ?? [];
}

export function findRuntimeAgentPermissionMode(
	agentId: RuntimeAgentId,
	modeId: string | null | undefined,
): RuntimeAgentCatalogPermissionMode | null {
	if (modeId == null || modeId.trim().length === 0) {
		return null;
	}
	const normalized = modeId.trim();
	return getRuntimeAgentPermissionModes(agentId).find((mode) => mode.id === normalized) ?? null;
}

export function getRuntimeAgentDefaultPermissionModeId(agentId: RuntimeAgentId): string | null {
	return getRuntimeAgentCatalogEntry(agentId)?.defaultPermissionModeId ?? null;
}

/**
 * Resolve the args/env a permission policy contributes for an agent.
 *
 * Unknown mode ids are ignored rather than injected as raw CLI args, which keeps
 * a stale or hand-edited config from turning into an arbitrary command injection.
 */
export function resolvePermissionModeContribution(
	agentId: RuntimeAgentId,
	policy: RuntimeTaskPermissionPolicy | null | undefined,
): { args: string[]; env: Record<string, string>; modeId: string | null; unknownModeId: string | null } {
	const requestedModeId = policy?.mode?.trim() || null;
	if (!requestedModeId) {
		return { args: [], env: {}, modeId: null, unknownModeId: null };
	}
	const mode = findRuntimeAgentPermissionMode(agentId, requestedModeId);
	if (!mode) {
		return { args: [], env: {}, modeId: null, unknownModeId: requestedModeId };
	}
	return {
		args: [...mode.args],
		env: { ...mode.env },
		modeId: mode.id,
		unknownModeId: null,
	};
}
