import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	hasClaudeWorkspaceTrustPrompt,
	shouldAutoConfirmClaudeWorkspaceTrust,
} from "../../../src/terminal/claude-workspace-trust";

const originalHome = process.env.HOME;
let tempHome: string | null = null;

function setupTempHome(): string {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-claude-trust-"));
	process.env.HOME = tempHome;
	return tempHome;
}

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = null;
	}
});

describe("hasClaudeWorkspaceTrustPrompt", () => {
	it("detects the trust prompt with and without ANSI styling", () => {
		expect(hasClaudeWorkspaceTrustPrompt("Do you trust this folder?")).toBe(true);
		expect(hasClaudeWorkspaceTrustPrompt("\u001b[1mYes, I trust this folder\u001b[0m")).toBe(true);
		expect(hasClaudeWorkspaceTrustPrompt("Compiling project files")).toBe(false);
	});
});

describe("shouldAutoConfirmClaudeWorkspaceTrust", () => {
	beforeEach(() => {
		setupTempHome();
	});

	it("trusts a Git task worktree", () => {
		const home = process.env.HOME ?? "";
		expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", join(home, ".cline", "worktrees", "task-1", "repo"))).toBe(
			true,
		);
	});

	/*
		Regression: isolated workspaces live under a different root than Git
		worktrees. Auto-trust previously only covered `~/.cline/worktrees/`, so a
		Claude task in an isolated copy stopped at its trust prompt and appeared to
		hang with no output.
	*/
	it("trusts an isolated workspace directory copy", () => {
		const home = process.env.HOME ?? "";
		expect(
			shouldAutoConfirmClaudeWorkspaceTrust(
				"claude",
				join(home, ".cline", "kanban", "isolated-workspaces", "task-1-abc123", "workspace"),
			),
		).toBe(true);
	});

	it("does not auto-trust an arbitrary user directory", () => {
		expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", "/tmp/some/user/project")).toBe(false);
	});

	it("does not auto-trust a path that merely shares a prefix", () => {
		const home = process.env.HOME ?? "";
		// `worktrees-evil` must not be treated as being inside `worktrees`.
		expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", join(home, ".cline", "worktrees-evil", "task"))).toBe(
			false,
		);
	});

	it("only applies to Claude Code", () => {
		const home = process.env.HOME ?? "";
		const isolated = join(home, ".cline", "kanban", "isolated-workspaces", "task-1", "workspace");
		expect(shouldAutoConfirmClaudeWorkspaceTrust("codex", isolated)).toBe(false);
		expect(shouldAutoConfirmClaudeWorkspaceTrust("pi", isolated)).toBe(false);
	});
});
