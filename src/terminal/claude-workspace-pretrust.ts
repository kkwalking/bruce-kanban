// Pre-trusts Kanban-managed workspaces so Claude Code does not open its
// workspace trust dialog on every task.
//
// Why this exists (and why it replaces keystroke injection):
//
// Claude Code shows an interactive trust dialog when it starts in a directory it
// does not recognize. Kanban runs Claude in a fresh workspace per task, so every
// task hit that dialog.
//
// The previous approach watched the PTY output for the dialog and typed into it.
// That is inherently racy: the dialog renders with "No, exit" highlighted, so the
// accepting sequence is arrow-down + Enter, and it is only reliably accepted once
// the TUI has finished rendering. Sending it too early silently selects nothing,
// and sending a bare Enter selects *cancel* — the session then sits at the
// dialog forever with no output and no error, which looks exactly like a hung
// task. Measured behavior: arrow-down + Enter worked at a 400ms delay but not at
// 100ms, so the failure was intermittent and load-dependent.
//
// Writing the trust decision into Claude's own config ahead of launch removes the
// race completely: the dialog is never shown, so there is nothing to type into.
//
// Safety: only directories Kanban itself creates (Git worktrees under
// `~/.cline/worktrees/` and isolated copies under
// `~/.cline/kanban/isolated-workspaces/`) are pre-trusted. A user's own project
// directories are never touched, so this does not silently broaden trust for
// folders the user has not reviewed.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeAgentId } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getIsolatedWorkspacesRootPath, getTaskWorktreesHomePath } from "../state/runtime-paths";

export interface TrustedFolderResult {
	/** True when the decision was written (or was already present). */
	trusted: boolean;
	/** Set when the write was skipped or failed; the launch proceeds regardless. */
	reason?: string;
}

/** Path to Claude Code's user-level config, honoring its config-dir override. */
export function getClaudeUserConfigPath(): string {
	const override = process.env.CLAUDE_CONFIG_DIR?.trim();
	const base = override && override.length > 0 ? override : join(homedir(), ".claude");
	return join(base, "..", ".claude.json");
}

function isPathInside(normalizedChild: string, root: string): boolean {
	const normalizedRoot = `${root.replaceAll("\\", "/").replace(/\/+$/u, "")}/`;
	if (process.platform === "win32") {
		return normalizedChild.toLowerCase().startsWith(normalizedRoot.toLowerCase());
	}
	return normalizedChild.startsWith(normalizedRoot);
}

/**
 * Is this a directory Kanban created and owns for a task?
 *
 * Mirrors the check used for trust auto-confirmation so both paths agree on what
 * counts as a Kanban-managed workspace.
 */
export function isKanbanManagedWorkspacePath(path: string): boolean {
	const normalized = `${path.replaceAll("\\", "/").replace(/\/+$/u, "")}/`;
	return (
		isPathInside(normalized, getTaskWorktreesHomePath()) || isPathInside(normalized, getIsolatedWorkspacesRootPath())
	);
}

interface ClaudeUserConfig {
	projects?: Record<string, Record<string, unknown>>;
	[key: string]: unknown;
}

/**
 * Record Claude's trust decision for a Kanban-managed workspace.
 *
 * Best effort by design: if the config cannot be read or written, the task still
 * launches and falls back to the interactive dialog handling. Trusting a folder
 * must never be the reason a task fails to start.
 */
export async function preTrustClaudeWorkspace(options: {
	agentId: RuntimeAgentId;
	cwd: string;
}): Promise<TrustedFolderResult> {
	if (options.agentId !== "claude") {
		return { trusted: false, reason: "not-a-claude-session" };
	}
	if (!isKanbanManagedWorkspacePath(options.cwd)) {
		// Never broaden trust for directories the user owns.
		return { trusted: false, reason: "not-a-kanban-managed-workspace" };
	}

	const configPath = getClaudeUserConfigPath();
	try {
		const raw = await readFile(configPath, "utf8");
		const parsed = JSON.parse(raw) as ClaudeUserConfig;
		const projects = parsed.projects ?? {};
		const existing = projects[options.cwd] ?? {};
		if (existing.hasTrustDialogAccepted === true) {
			return { trusted: true };
		}
		projects[options.cwd] = {
			...existing,
			hasTrustDialogAccepted: true,
		};
		await lockedFileSystem.writeJsonFileAtomic(
			configPath,
			{
				...parsed,
				projects,
			},
			{ lock: null },
		);
		return { trusted: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { trusted: false, reason: message };
	}
}
