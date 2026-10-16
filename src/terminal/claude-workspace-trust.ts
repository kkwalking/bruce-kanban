import type { RuntimeAgentId } from "../core/api-contract";
import { getIsolatedWorkspacesRootPath, getTaskWorktreesHomePath } from "../state/runtime-paths";

export const WORKSPACE_TRUST_CONFIRM_DELAY_MS = 100;

function normalizeTerminalText(input: string): string {
	return input.toLowerCase().replace(/\s+/gu, " ");
}

function stripAnsiAndControl(input: string): string {
	let output = "";
	let mode: "text" | "escape" | "csi" | "osc" | "osc_escape" = "text";
	for (const char of input) {
		if (mode === "text") {
			if (char === "\u001b") {
				mode = "escape";
				continue;
			}
			const code = char.charCodeAt(0);
			if ((code >= 32 && code !== 127) || char === "\n" || char === "\r" || char === "\t") {
				output += char;
			}
			continue;
		}
		if (mode === "escape") {
			if (char === "[") {
				mode = "csi";
				continue;
			}
			if (char === "]") {
				mode = "osc";
				continue;
			}
			mode = "text";
			continue;
		}
		if (mode === "csi") {
			const code = char.charCodeAt(0);
			if (code >= 64 && code <= 126) {
				mode = "text";
			}
			continue;
		}
		if (mode === "osc") {
			if (char === "\u0007") {
				mode = "text";
			} else if (char === "\u001b") {
				mode = "osc_escape";
			}
			continue;
		}
		if (mode === "osc_escape") {
			mode = char === "\\" ? "text" : "osc";
		}
	}
	return output;
}

export function hasClaudeWorkspaceTrustPrompt(text: string): boolean {
	const normalized = normalizeTerminalText(stripAnsiAndControl(text));
	return /yes,?\s*i\s*trust\s*this\s*folder/u.test(normalized) || /trust\s+this\s+folder/u.test(normalized);
}

function isPathInside(normalizedChild: string, root: string): boolean {
	const normalizedRoot = `${root.replace(/\\/gu, "/").replace(/\/+$/u, "")}/`;
	if (process.platform === "win32") {
		return normalizedChild.toLowerCase().startsWith(normalizedRoot.toLowerCase());
	}
	return normalizedChild.startsWith(normalizedRoot);
}

/**
 * Is this a directory Kanban created and owns for this task?
 *
 * Both isolation strategies count: Git worktrees under `~/.cline/worktrees/`
 * and directory copies under `~/.cline/kanban/isolated-workspaces/`. Missing the
 * latter meant Claude Code stopped at its "trust this folder?" prompt inside an
 * isolated copy, which looks like a hung task with no output (FR-04).
 */
function isKanbanManagedTaskWorkspace(path: string): boolean {
	const normalizedPath = `${path.replace(/\\/gu, "/").replace(/\/+$/u, "")}/`;
	return (
		isPathInside(normalizedPath, getTaskWorktreesHomePath()) ||
		isPathInside(normalizedPath, getIsolatedWorkspacesRootPath())
	);
}

export function shouldAutoConfirmClaudeWorkspaceTrust(agentId: RuntimeAgentId, cwd: string): boolean {
	return agentId === "claude" && isKanbanManagedTaskWorkspace(cwd);
}

/**
 * Key sequence that accepts Claude Code's workspace trust dialog.
 *
 * Claude renders the dialog with "No, exit" highlighted by default, so a bare
 * `\r` selects *cancel* and the session silently stalls at the prompt: the TUI
 * stays open, produces no further output, and the task appears to hang forever
 * with no error. Arrow-down moves the highlight to "Yes, I trust this folder",
 * and Enter accepts it.
 *
 * Verified against the real prompt: `\r` alone produced no further output,
 * while down+Enter (and `y`) advanced the session.
 */
export const CLAUDE_WORKSPACE_TRUST_ACCEPT_INPUT = "\u001b[B\r";

export function stopWorkspaceTrustTimers(state: { workspaceTrustConfirmTimer: NodeJS.Timeout | null }): void {
	if (state.workspaceTrustConfirmTimer) {
		clearTimeout(state.workspaceTrustConfirmTimer);
		state.workspaceTrustConfirmTimer = null;
	}
}
