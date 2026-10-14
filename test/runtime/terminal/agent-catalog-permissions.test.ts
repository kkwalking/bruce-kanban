import { describe, expect, it } from "vitest";

import {
	findRuntimeAgentPermissionMode,
	getRuntimeAgentCapabilities,
	getRuntimeAgentCatalogEntry,
	getRuntimeAgentDefaultPermissionModeId,
	getRuntimeAgentPermissionModes,
	getRuntimeLaunchSupportedAgentCatalog,
	isRuntimeAgentLaunchSupported,
	resolvePermissionModeContribution,
} from "../../../src/core/agent-catalog";

describe("agent catalog permission model", () => {
	it("launches the four agents required by the spec plus Cline", () => {
		const launchable = getRuntimeLaunchSupportedAgentCatalog().map((entry) => entry.id);

		expect(launchable).toContain("claude");
		expect(launchable).toContain("codex");
		expect(launchable).toContain("pi");
		expect(launchable).toContain("opencode");
		expect(launchable).toContain("cline");
		expect(isRuntimeAgentLaunchSupported("pi")).toBe(true);
	});

	it("never defaults Claude to auto mode", () => {
		// FR-07: Kanban must not silently raise the user's permissions.
		expect(getRuntimeAgentDefaultPermissionModeId("claude")).toBe("default");
		const defaultMode = findRuntimeAgentPermissionMode("claude", "default");
		expect(defaultMode?.args).toEqual([]);
		expect(defaultMode?.env).toEqual({});
		expect(defaultMode?.risky).toBe(false);
	});

	it("exposes Claude permission modes with their flags and env", () => {
		const modes = getRuntimeAgentPermissionModes("claude");
		const byId = new Map(modes.map((mode) => [mode.id, mode]));

		expect(byId.get("plan")?.args).toEqual(["--permission-mode", "plan"]);
		expect(byId.get("acceptEdits")?.args).toEqual(["--permission-mode", "acceptEdits"]);
		expect(byId.get("auto")?.args).toEqual(["--permission-mode", "auto"]);
		expect(byId.get("auto")?.env.CLAUDE_CODE_ENABLE_AUTO_MODE).toBe("1");
		expect(byId.get("auto")?.risky).toBe(true);
		expect(byId.get("bypassPermissions")?.args).toEqual(["--dangerously-skip-permissions"]);
		expect(byId.get("bypassPermissions")?.risky).toBe(true);
	});

	it("does not apply separate autonomous flags for Claude", () => {
		// Claude expresses autonomy as a permission mode, so enabling autonomy
		// alone must not inject any flag.
		expect(getRuntimeAgentCatalogEntry("claude")?.autonomousArgs).toEqual([]);
	});

	it("declares capabilities per backend instead of assuming parity", () => {
		const claude = getRuntimeAgentCapabilities("claude");
		expect(claude.hookEvents).toBe(true);
		expect(claude.permissionPrompts).toBe(true);
		expect(claude.sessionResume).toBe(true);

		// Pi has no structured hook-event integration today; it must not claim one.
		const pi = getRuntimeAgentCapabilities("pi");
		expect(pi.hookEvents).toBe(false);
		expect(pi.interactiveTui).toBe(true);
		expect(pi.sessionResume).toBe(true);
	});

	it("resolves a known permission mode into args and env", () => {
		const contribution = resolvePermissionModeContribution("claude", { mode: "auto" });

		expect(contribution.modeId).toBe("auto");
		expect(contribution.args).toEqual(["--permission-mode", "auto"]);
		expect(contribution.env.CLAUDE_CODE_ENABLE_AUTO_MODE).toBe("1");
		expect(contribution.unknownModeId).toBeNull();
	});

	it("ignores an unknown or injected permission mode id", () => {
		// A stale or hand-edited config must not become an arbitrary CLI flag.
		const contribution = resolvePermissionModeContribution("claude", { mode: "--dangerously-skip-permissions" });

		expect(contribution.args).toEqual([]);
		expect(contribution.env).toEqual({});
		expect(contribution.modeId).toBeNull();
		expect(contribution.unknownModeId).toBe("--dangerously-skip-permissions");
	});

	it("treats a missing permission mode as the CLI default", () => {
		expect(resolvePermissionModeContribution("claude", undefined).modeId).toBeNull();
		expect(resolvePermissionModeContribution("claude", { mode: "  " }).modeId).toBeNull();
	});

	it("scopes permission modes per backend so one cannot leak into another", () => {
		// `auto` is a Claude mode, not a Codex mode.
		expect(findRuntimeAgentPermissionMode("claude", "auto")).not.toBeNull();
		expect(findRuntimeAgentPermissionMode("codex", "auto")).toBeNull();
		expect(resolvePermissionModeContribution("codex", { mode: "auto" }).modeId).toBeNull();
	});

	it("keeps audit-only agents out of the launch set", () => {
		expect(isRuntimeAgentLaunchSupported("droid")).toBe(false);
		expect(isRuntimeAgentLaunchSupported("kiro")).toBe(false);
		expect(isRuntimeAgentLaunchSupported("gemini")).toBe(false);
	});
});
