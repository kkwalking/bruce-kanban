// Regression tests for the non-Git project *preflight* path.
//
// A prior fix made an empty `baseRef` acceptable, which unblocked task creation
// and session startup. But the UI runs a separate preflight before moving a card
// to In Progress (`workspace.ensureWorktree`), and that path still assumed Git
// unconditionally. For any project whose root is not a repository it surfaced as:
//
//   Failed to run Git Command:
//   git rev-parse --git-common-dir failed
//   fatal: not a git repository (or any of the parent directories): .git
//
// The unit tests here pin the decision logic so the preflight, session startup,
// workspace info, and cleanup all agree on where a task runs.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { describeTaskWorkspace, resolveTaskExecutionDirectory } from "../../../src/workspace/task-execution-directory";
import { hasRootGitRepository, type WorkspaceDiscoveryResult } from "../../../src/workspace/workspace-discovery";

const created: string[] = [];
const originalHome = process.env.HOME;
let tempHome: string | null = null;

function tempDir(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	created.push(path);
	return path;
}

function discovery(workspaceType: WorkspaceDiscoveryResult["workspaceType"]): WorkspaceDiscoveryResult {
	return {
		workspaceType,
		rootPath: "/tmp/project",
		repositories:
			workspaceType === "git"
				? [{ relativePath: "", workTreePath: "/tmp/project", gitDirPath: "/tmp/project/.git", isRoot: true }]
				: [],
		repoManifestProjects: [],
		repoManifestPath: null,
		warning: null,
		discoveredAt: Date.now(),
	};
}

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	tempHome = null;
	while (created.length > 0) {
		const dir = created.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("hasRootGitRepository", () => {
	it("is true only for a repository rooted at the project root", () => {
		expect(hasRootGitRepository(discovery("git"))).toBe(true);
		// A multi-repo parent contains repositories, but its own root is not one.
		expect(hasRootGitRepository(discovery("multi-git"))).toBe(false);
		expect(hasRootGitRepository(discovery("google-repo"))).toBe(false);
		expect(hasRootGitRepository(discovery("none"))).toBe(false);
	});
});

describe("non-git preflight does not require the worktree path", () => {
	it("resolves Direct execution to the project root without touching Git", async () => {
		const sourceRoot = tempDir("kanban-preflight-direct-");
		mkdirSync(join(sourceRoot, "docs"), { recursive: true });

		const resolved = await resolveTaskExecutionDirectory({
			workspaceId: "workspace-1",
			workspacePath: sourceRoot,
			taskId: "task-1",
			baseRef: "",
			executionMode: "direct",
		});

		expect(resolved.mode).toBe("direct");
		expect(resolved.strategy).toBe("project-root");
		expect(resolved.workingDirectory).toBe(sourceRoot);
	});

	it("describes an isolated workspace for a plain folder without Git", async () => {
		tempHome = tempDir("kanban-preflight-home-");
		process.env.HOME = tempHome;
		const sourceRoot = tempDir("kanban-preflight-isolated-");
		mkdirSync(join(sourceRoot, "src"), { recursive: true });

		const instance = await describeTaskWorkspace({
			workspaceId: "workspace-1",
			workspacePath: sourceRoot,
			taskId: "task-1",
			baseRef: "",
			executionMode: "isolated",
		});

		expect(instance.mode).toBe("isolated");
		// The isolated path must be a real location, not a worktree guess.
		expect(instance.isolatedPath).toBeTruthy();
		expect(instance.isolatedPath).not.toContain("/.cline/worktrees/");
		// Describing must not create anything.
		expect(instance.exists).toBe(false);
		expect(instance.workingDirectory).toBe(instance.isolatedPath);
	});
});
