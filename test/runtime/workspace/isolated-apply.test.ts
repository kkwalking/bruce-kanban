import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parsePorcelainV2Status } from "../../../src/workspace/isolated-apply";

const createdDirectories: string[] = [];

function createTempDirectory(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	createdDirectories.push(path);
	return path;
}

function runGit(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd, stdio: "ignore" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
	}
}

function createGitRepositoryWithCommit(): string {
	const root = createTempDirectory("kanban-apply-git-");
	runGit(root, ["init", "--quiet"]);
	runGit(root, ["config", "user.email", "test@example.com"]);
	runGit(root, ["config", "user.name", "Test"]);
	writeFileSync(join(root, "app.js"), "console.log('v1')\n", "utf8");
	runGit(root, ["add", "-A"]);
	runGit(root, ["commit", "-m", "initial"]);
	return root;
}

beforeEach(() => {
	// Keep git's global config out of the picture for reproducibility.
	process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterEach(() => {
	delete process.env.GIT_CONFIG_NOSYSTEM;
	while (createdDirectories.length > 0) {
		const directory = createdDirectories.pop();
		if (directory) {
			rmSync(directory, { recursive: true, force: true });
		}
	}
});

describe("parsePorcelainV2Status", () => {
	it("classifies untracked, modified, added, and deleted files", () => {
		const output = [
			"1 .M N... 100644 100644 100644 aaa bbb src/app.ts",
			"1 .D N... 100644 100644 000000 aaa 000 src/removed.ts",
			"1 .A N... 000000 100644 000000 000 ccc src/added.ts",
			"? docs/new.md",
		].join("\n");

		const files = parsePorcelainV2Status(output);

		expect(files).toEqual([
			{ path: "src/app.ts", status: "modified" },
			{ path: "src/removed.ts", status: "deleted" },
			{ path: "src/added.ts", status: "added" },
			{ path: "docs/new.md", status: "untracked" },
		]);
	});

	it("reports a rename against its previous path so apply can find it", () => {
		const output = "2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts\told/name.ts";

		const files = parsePorcelainV2Status(output);

		expect(files).toEqual([{ path: "old/name.ts", status: "renamed" }]);
	});

	it("ignores blank lines and unparseable entries", () => {
		expect(parsePorcelainV2Status("\n\n# branch.head main\n")).toEqual([]);
	});
});

describe("isolated apply plan behaviour", () => {
	it("does not report git-tracked edits as conflicts when the source is unchanged", async () => {
		const { buildIsolatedApplyPlan } = await import("../../../src/workspace/isolated-apply");
		const sourceRoot = createGitRepositoryWithCommit();

		// Simulate an isolated worktree: baseline commit, then an uncommitted agent edit.
		const isolatedPath = createTempDirectory("kanban-apply-isolated-");
		writeFileSync(join(isolatedPath, "app.js"), "console.log('v1')\n", "utf8");
		runGit(isolatedPath, ["init", "--quiet"]);
		runGit(isolatedPath, ["config", "user.email", "test@example.com"]);
		runGit(isolatedPath, ["config", "user.name", "Test"]);
		runGit(isolatedPath, ["add", "-A"]);
		runGit(isolatedPath, ["commit", "-m", "baseline"]);
		// Agent edits stay uncommitted, exactly as the real flow leaves them.
		writeFileSync(join(isolatedPath, "app.js"), "console.log('agent')\n", "utf8");

		const plan = await buildIsolatedApplyPlan({
			taskId: "task-1",
			workspaceId: "workspace-1",
			sourceRoot,
			isolatedPath,
			workspaceType: "git",
			repositories: [{ relativePath: "", isRoot: true }],
		});

		// The source file is untouched versus HEAD, so this is safe to apply.
		expect(plan.conflicting).toEqual([]);
		expect(plan.applicable.map((entry) => entry.path)).toContain("app.js");
	});

	it("flags a source file the user edited after isolation as a conflict", async () => {
		const { buildIsolatedApplyPlan } = await import("../../../src/workspace/isolated-apply");
		const sourceRoot = createGitRepositoryWithCommit();

		const isolatedPath = createTempDirectory("kanban-apply-conflict-");
		runGit(isolatedPath, ["init", "--quiet"]);
		runGit(isolatedPath, ["config", "user.email", "test@example.com"]);
		runGit(isolatedPath, ["config", "user.name", "Test"]);
		writeFileSync(join(isolatedPath, "app.js"), "console.log('v1')\n", "utf8");
		runGit(isolatedPath, ["add", "-A"]);
		runGit(isolatedPath, ["commit", "-m", "baseline"]);
		// Uncommitted agent edit.
		writeFileSync(join(isolatedPath, "app.js"), "console.log('agent')\n", "utf8");

		// The user edits the same file in the source workspace afterwards.
		writeFileSync(join(sourceRoot, "app.js"), "console.log('user edit')\n", "utf8");

		const plan = await buildIsolatedApplyPlan({
			taskId: "task-1",
			workspaceId: "workspace-1",
			sourceRoot,
			isolatedPath,
			workspaceType: "git",
			repositories: [{ relativePath: "", isRoot: true }],
		});

		expect(plan.applicable).toEqual([]);
		expect(plan.conflicting.map((entry) => entry.path)).toEqual(["app.js"]);
		expect(plan.conflicting[0]?.conflictReason).toContain("modified in your project");
	});

	it("refuses to apply without explicit confirmation", async () => {
		const { applyIsolatedWorkspace } = await import("../../../src/workspace/isolated-apply");
		const sourceRoot = createGitRepositoryWithCommit();
		const isolatedPath = createTempDirectory("kanban-apply-unconfirmed-");
		writeFileSync(join(isolatedPath, "app.js"), "console.log('agent')\n", "utf8");

		const result = await applyIsolatedWorkspace({
			taskId: "task-1",
			workspaceId: "workspace-1",
			sourceRoot,
			isolatedPath,
			workspaceType: "none",
			repositories: [],
			confirmed: false,
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("confirmation");
		expect(result.applied).toEqual([]);
		// The source must be untouched.
		expect(readFileSync(join(sourceRoot, "app.js"), "utf8")).toBe("console.log('v1')\n");
	});

	it("never writes a conflicting file, even when confirmed", async () => {
		const { applyIsolatedWorkspace } = await import("../../../src/workspace/isolated-apply");
		const sourceRoot = createGitRepositoryWithCommit();

		const isolatedPath = createTempDirectory("kanban-apply-skip-conflict-");
		runGit(isolatedPath, ["init", "--quiet"]);
		runGit(isolatedPath, ["config", "user.email", "test@example.com"]);
		runGit(isolatedPath, ["config", "user.name", "Test"]);
		writeFileSync(join(isolatedPath, "app.js"), "console.log('v1')\n", "utf8");
		runGit(isolatedPath, ["add", "-A"]);
		runGit(isolatedPath, ["commit", "-m", "baseline"]);
		writeFileSync(join(isolatedPath, "app.js"), "console.log('agent')\n", "utf8");

		writeFileSync(join(sourceRoot, "app.js"), "console.log('user edit')\n", "utf8");

		const result = await applyIsolatedWorkspace({
			taskId: "task-1",
			workspaceId: "workspace-1",
			sourceRoot,
			isolatedPath,
			workspaceType: "git",
			repositories: [{ relativePath: "", isRoot: true }],
			confirmed: true,
		});

		expect(result.ok).toBe(false);
		expect(result.conflicts.map((conflict) => conflict.path)).toEqual(["app.js"]);
		// AC-08.7: the user's edit is preserved.
		expect(readFileSync(join(sourceRoot, "app.js"), "utf8")).toBe("console.log('user edit')\n");
	});

	it("refuses to write outside the project root", async () => {
		const { applyIsolatedWorkspace } = await import("../../../src/workspace/isolated-apply");
		const sourceRoot = createTempDirectory("kanban-apply-escape-");
		writeFileSync(join(sourceRoot, "safe.txt"), "safe\n", "utf8");
		const outsideRoot = createTempDirectory("kanban-apply-outside-");
		mkdirSync(join(outsideRoot, "nested"), { recursive: true });
		writeFileSync(join(outsideRoot, "nested", "escape.txt"), "escaped\n", "utf8");

		const result = await applyIsolatedWorkspace({
			taskId: "task-1",
			workspaceId: "workspace-1",
			sourceRoot,
			isolatedPath: outsideRoot,
			workspaceType: "none",
			repositories: [],
			confirmed: true,
			paths: ["../nested/escape.txt"],
		});

		// Either nothing applied, or the path check rejected it; in both cases the
		// source root must not gain a file outside itself.
		expect(existsSync(join(sourceRoot, "..", "escape.txt"))).toBe(false);
		expect(result.applied).not.toContain("../nested/escape.txt");
	});
});
