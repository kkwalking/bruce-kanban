// Tests for pre-trusting Kanban-managed workspaces with Claude Code.
//
// Context: Claude Code opens an interactive workspace trust dialog in any
// directory it does not recognize. Kanban runs each task in a fresh worktree or
// isolated copy, so every task hit that dialog.
//
// The previous mitigation watched PTY output and typed into the dialog. That was
// racy: the dialog highlights "No, exit" by default, so accepting it needs
// arrow-down + Enter, and sending it before the TUI finished rendering silently
// did nothing while a bare Enter selected *cancel*. The result was a task that
// hung forever with no output and no error. Writing the trust decision into
// Claude's config before launch removes the race entirely.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getClaudeUserConfigPath,
	isKanbanManagedWorkspacePath,
	preTrustClaudeWorkspace,
} from "../../../src/terminal/claude-workspace-pretrust";

const originalHome = process.env.HOME;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
let tempHome: string | null = null;

function setupTempHome(): string {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-pretrust-"));
	process.env.HOME = tempHome;
	return tempHome;
}

function readConfig(): Record<string, unknown> {
	return JSON.parse(readFileSync(getClaudeUserConfigPath(), "utf8")) as Record<string, unknown>;
}

function seedConfig(payload: unknown): void {
	writeFileSync(getClaudeUserConfigPath(), JSON.stringify(payload, null, 2), "utf8");
}

beforeEach(() => {
	setupTempHome();
});

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalConfigDir === undefined) {
		delete process.env.CLAUDE_CONFIG_DIR;
	} else {
		process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
	}
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = null;
	}
});

describe("isKanbanManagedWorkspacePath", () => {
	it("accepts Git worktrees and isolated workspaces", () => {
		const home = process.env.HOME ?? "";
		expect(isKanbanManagedWorkspacePath(join(home, ".cline", "worktrees", "t1", "repo"))).toBe(true);
		expect(
			isKanbanManagedWorkspacePath(join(home, ".cline", "kanban", "isolated-workspaces", "t1-abc", "workspace")),
		).toBe(true);
	});

	it("rejects user-owned directories", () => {
		expect(isKanbanManagedWorkspacePath("/Users/someone/code/my-project")).toBe(false);
		const home = process.env.HOME ?? "";
		// A sibling with a shared prefix must not be treated as inside.
		expect(isKanbanManagedWorkspacePath(join(home, ".cline", "worktrees-evil", "t1"))).toBe(false);
	});
});

describe("preTrustClaudeWorkspace", () => {
	it("records the trust decision for an isolated workspace", async () => {
		const home = process.env.HOME ?? "";
		seedConfig({ projects: {} });
		const cwd = join(home, ".cline", "kanban", "isolated-workspaces", "task-1-abc", "workspace");
		mkdirSync(cwd, { recursive: true });

		const result = await preTrustClaudeWorkspace({ agentId: "claude", cwd });

		expect(result.trusted).toBe(true);
		const config = readConfig() as { projects: Record<string, { hasTrustDialogAccepted?: boolean }> };
		expect(config.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
	});

	it("preserves unrelated config and existing project entries", async () => {
		const home = process.env.HOME ?? "";
		seedConfig({
			theme: "dark",
			projects: { "/Users/someone/code/other": { hasTrustDialogAccepted: false, custom: 1 } },
		});
		const cwd = join(home, ".cline", "worktrees", "task-2", "repo");

		await preTrustClaudeWorkspace({ agentId: "claude", cwd });

		const config = readConfig() as {
			theme?: string;
			projects: Record<string, { hasTrustDialogAccepted?: boolean; custom?: number }>;
		};
		// Unrelated keys survive the rewrite.
		expect(config.theme).toBe("dark");
		expect(config.projects["/Users/someone/code/other"]).toEqual({ hasTrustDialogAccepted: false, custom: 1 });
		expect(config.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
	});

	it("never trusts a user-owned directory", async () => {
		seedConfig({ projects: {} });

		const result = await preTrustClaudeWorkspace({ agentId: "claude", cwd: "/Users/someone/code/my-project" });

		expect(result.trusted).toBe(false);
		expect(result.reason).toBe("not-a-kanban-managed-workspace");
		const config = readConfig() as { projects: Record<string, unknown> };
		expect(config.projects["/Users/someone/code/my-project"]).toBeUndefined();
	});

	it("does nothing for non-Claude agents", async () => {
		seedConfig({ projects: {} });
		const home = process.env.HOME ?? "";
		const cwd = join(home, ".cline", "worktrees", "task-3", "repo");

		const result = await preTrustClaudeWorkspace({ agentId: "codex", cwd });

		expect(result.trusted).toBe(false);
		expect(result.reason).toBe("not-a-claude-session");
	});

	it("reports a missing config instead of throwing, so the task still launches", async () => {
		const home = process.env.HOME ?? "";
		// No config file written at all.
		const cwd = join(home, ".cline", "worktrees", "task-4", "repo");

		const result = await preTrustClaudeWorkspace({ agentId: "claude", cwd });

		expect(result.trusted).toBe(false);
		expect(result.reason).toBeTruthy();
	});

	it("is a no-op when the decision is already recorded", async () => {
		const home = process.env.HOME ?? "";
		const cwd = join(home, ".cline", "worktrees", "task-5", "repo");
		seedConfig({
			projects: { [cwd]: { hasTrustDialogAccepted: true, keepMe: "yes" } },
		});

		const result = await preTrustClaudeWorkspace({ agentId: "claude", cwd });

		expect(result.trusted).toBe(true);
		const config = readConfig() as { projects: Record<string, { keepMe?: string }> };
		expect(config.projects[cwd]?.keepMe).toBe("yes");
	});
});
