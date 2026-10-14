// Shared fixtures for web-ui tests.
//
// Added when the runtime contracts grew required fields (workspace type, agent
// capabilities, permission modes). Keeping one builder here avoids every test
// file re-declaring the full shape and drifting out of sync.
import type {
	RuntimeAgentDefinition,
	RuntimeBoardColumnId,
	RuntimeProjectSummary,
	RuntimeTaskExecutionMode,
	RuntimeWorkspaceStateResponse,
	RuntimeWorkspaceType,
} from "@/runtime/types";

export function createAgentCapabilities(
	overrides: Partial<RuntimeAgentDefinition["capabilities"]> = {},
): RuntimeAgentDefinition["capabilities"] {
	return {
		interactiveTui: true,
		hookEvents: false,
		sessionResume: false,
		permissionPrompts: false,
		modelSelection: false,
		nativeChat: false,
		...overrides,
	};
}

export function createAgentDefinition(
	overrides: Partial<RuntimeAgentDefinition> & Pick<RuntimeAgentDefinition, "id">,
): RuntimeAgentDefinition {
	return {
		label: overrides.id,
		binary: overrides.id,
		command: overrides.id,
		defaultArgs: [],
		installed: true,
		configured: false,
		installUrl: "",
		capabilities: createAgentCapabilities(),
		permissionModes: [],
		defaultPermissionModeId: null,
		...overrides,
	};
}

export function createProjectSummary(
	overrides: Partial<RuntimeProjectSummary> & Pick<RuntimeProjectSummary, "id">,
): RuntimeProjectSummary {
	return {
		name: overrides.id,
		path: `/tmp/${overrides.id}`,
		workspaceType: "git" as RuntimeWorkspaceType,
		taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
		...overrides,
	};
}

export function createEmptyTaskCounts(): Record<RuntimeBoardColumnId, number> {
	return { backlog: 0, in_progress: 0, review: 0, trash: 0 };
}

export function createWorkspaceState(
	overrides: Partial<RuntimeWorkspaceStateResponse> = {},
): RuntimeWorkspaceStateResponse {
	return {
		repoPath: "/tmp/project",
		statePath: "/tmp/state",
		git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
		workspaceType: "git" as RuntimeWorkspaceType,
		repositories: [{ relativePath: "", workTreePath: "/tmp/project", isRoot: true }],
		workspaceDetectionWarning: null,
		workspaceDiscoveredAt: null,
		board: { columns: [], dependencies: [] },
		sessions: {},
		revision: 0,
		...overrides,
	};
}

export function createPermissionPolicy(
	overrides: Partial<{ mode: string; autonomousModeEnabled: boolean; extraArgs: string[] }> = {},
): { mode?: string; autonomousModeEnabled?: boolean; extraArgs?: string[] } {
	return { ...overrides };
}

export function createExecutionMode(value: RuntimeTaskExecutionMode = "isolated"): RuntimeTaskExecutionMode {
	return value;
}
