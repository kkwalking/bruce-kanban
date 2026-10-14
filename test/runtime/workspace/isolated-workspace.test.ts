import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	cleanupIsolatedWorkspace,
	createOrReuseIsolatedWorkspace,
	describeTaskWorkspaceInstance,
} from "../../../src/workspace/isolated-workspace";

const createdDirectories: string[] = [];
const originalHome = process.env.HOME;
let tempHome: string | null = null;

function createTempDirectory(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	createdDirectories.push(path);
	return path;
}

function initGitRepository(path: string): void {
	const result = spawnSync("git", ["init", "--quiet"], { cwd: path, stdio: "ignore" });
	if (result.status !== 0) {
		throw new Error(`Could not initialize git repository at ${path}`);
	}
}

beforeEach(() => {
	tempHome = createTempDirectory("kanban-isolated-home-");
	process.env.HOME = tempHome;
});

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	tempHome = null;
	while (createdDirectories.length > 0) {
		const directory = createdDirectories.pop();
		if (directory) {
			rmSync(directory, { recursive: true, force: true });
		}
	}
});

describe("isolated workspaces", () => {
	it("copies a plain non-git folder preserving relative structure", async () => {
		const sourceRoot = createTempDirectory("kanban-isolated-plain-");
		mkdirSync(join(sourceRoot, "docs"), { recursive: true });
		writeFileSync(join(sourceRoot, "main.py"), "print('source')\n", "utf8");
		writeFileSync(join(sourceRoot, "docs", "guide.md"), "# guide\n", "utf8");

		const result = await createOrReuseIsolatedWorkspace({
			taskId: "task-plain",
			sourceRoot,
			workspaceId: "workspace-1",
			baseRef: "main",
		});

		expect(result.ok).toBe(true);
		expect(result.instance).not.toBeNull();
		const isolatedPath = result.instance?.isolatedPath ?? "";
		expect(isolatedPath).not.toBe("");
		// Relative structure is preserved by construction.
		expect(existsSync(join(isolatedPath, "main.py"))).toBe(true);
		expect(existsSync(join(isolatedPath, "docs", "guide.md"))).toBe(true);
		expect(readFileSync(join(isolatedPath, "main.py"), "utf8")).toBe("print('source')\n");
	});

	it("writes inside the isolated copy never touch the source folder", async () => {
		const sourceRoot = createTempDirectory("kanban-isolated-noleak-src-");
		writeFileSync(join(sourceRoot, "main.py"), "original\n", "utf8");

		const result = await createOrReuseIsolatedWorkspace({
			taskId: "task-noleak",
			sourceRoot,
			workspaceId: "workspace-1",
			baseRef: "main",
		});
		const isolatedPath = result.instance?.isolatedPath ?? "";
		expect(isolatedPath).not.toBe("");

		writeFileSync(join(isolatedPath, "main.py"), "agent changed this\n", "utf8");
		writeFileSync(join(isolatedPath, "new-file.txt"), "new\n", "utf8");

		expect(readFileSync(join(sourceRoot, "main.py"), "utf8")).toBe("original\n");
		expect(existsSync(join(sourceRoot, "new-file.txt"))).toBe(false);
	});

	it("does not copy credential-shaped files into the isolated workspace", async () => {
		const sourceRoot = createTempDirectory("kanban-isolated-secrets-");
		mkdirSync(join(sourceRoot, "config"), { recursive: true });
		writeFileSync(join(sourceRoot, ".env"), "SECRET=abc\n", "utf8");
		writeFileSync(join(sourceRoot, "config", "credentials.json"), '{"token":"x"}\n', "utf8");
		writeFileSync(join(sourceRoot, "app.py"), "print('ok')\n", "utf8");

		const result = await createOrReuseIsolatedWorkspace({
			taskId: "task-secrets",
			sourceRoot,
			workspaceId: "workspace-1",
			baseRef: "main",
		});
		const isolatedPath = result.instance?.isolatedPath ?? "";

		expect(existsSync(join(isolatedPath, ".env"))).toBe(false);
		expect(existsSync(join(isolatedPath, "config", "credentials.json"))).toBe(false);
		expect(existsSync(join(isolatedPath, "app.py"))).toBe(true);
	});

	it("keeps two isolated workspaces for the same project fully independent", async () => {
		const sourceRoot = createTempDirectory("kanban-isolated-parallel-");
		writeFileSync(join(sourceRoot, "shared.txt"), "base\n", "utf8");

		const first = await createOrReuseIsolatedWorkspace({
			taskId: "task-a",
			sourceRoot,
			workspaceId: "workspace-1",
			baseRef: "main",
		});
		const second = await createOrReuseIsolatedWorkspace({
			taskId: "task-b",
			sourceRoot,
			workspaceId: "workspace-1",
			baseRef: "main",
		});
		const firstPath = first.instance?.isolatedPath ?? "";
		const secondPath = second.instance?.isolatedPath ?? "";

		expect(firstPath).not.toBe(secondPath);
		writeFileSync(join(firstPath, "shared.txt"), "first\n", "utf8");
		writeFileSync(join(secondPath, "shared.txt"), "second\n", "utf8");

		expect(readFileSync(join(firstPath, "shared.txt"), "utf8")).toBe("first\n");
		expect(readFileSync(join(secondPath, "shared.txt"), "utf8")).toBe("second\n");
		expect(readFileSync(join(sourceRoot, "shared.txt"), "utf8")).toBe("base\n");
	});

	it("preserves the multi-repository structure of a google-repo style root", async () => {
		const sourceRoot = createTempDirectory("kanban-isolated-multirepo-");
		mkdirSync(join(sourceRoot, "frameworks", "base"), { recursive: true });
		mkdirSync(join(sourceRoot, "packages", "apps", "Settings"), { recursive: true });
		mkdirSync(join(sourceRoot, "docs"), { recursive: true });
		writeFileSync(join(sourceRoot, "frameworks", "base", "Base.java"), "class Base {}\n", "utf8");
		writeFileSync(join(sourceRoot, "packages", "apps", "Settings", "Settings.java"), "class Settings {}\n", "utf8");
		writeFileSync(join(sourceRoot, "docs", "readme.md"), "# docs\n", "utf8");

		const result = await createOrReuseIsolatedWorkspace({
			taskId: "task-multirepo",
			sourceRoot,
			workspaceId: "workspace-1",
			baseRef: "main",
		});
		const isolatedPath = result.instance?.isolatedPath ?? "";

		expect(existsSync(join(isolatedPath, "frameworks", "base", "Base.java"))).toBe(true);
		expect(existsSync(join(isolatedPath, "packages", "apps", "Settings", "Settings.java"))).toBe(true);
		expect(existsSync(join(isolatedPath, "docs", "readme.md"))).toBe(true);
	});

	it("reuses an existing isolated workspace instead of recreating it", async () => {
		const sourceRoot = createTempDirectory("kanban-isolated-reuse-");
		writeFileSync(join(sourceRoot, "file.txt"), "base\n", "utf8");

		const first = await createOrReuseIsolatedWorkspace({
			taskId: "task-reuse",
			sourceRoot,
			workspaceId: "workspace-1",
			baseRef: "main",
		});
		const isolatedPath = first.instance?.isolatedPath ?? "";
		writeFileSync(join(isolatedPath, "file.txt"), "agent work\n", "utf8");

		const second = await createOrReuseIsolatedWorkspace({
			taskId: "task-reuse",
			sourceRoot,
			workspaceId: "workspace-1",
			baseRef: "main",
		});

		expect(second.reused).toBe(true);
		// Prior agent work must survive a re-resolve.
		expect(readFileSync(join(second.instance?.isolatedPath ?? "", "file.txt"), "utf8")).toBe("agent work\n");
	});

	it("refuses to clean up an isolated workspace with unsaved work unless forced", async () => {
		const sourceRoot = createTempDirectory("kanban-isolated-cleanup-");
		writeFileSync(join(sourceRoot, "file.txt"), "base\n", "utf8");

		const created = await createOrReuseIsolatedWorkspace({
			taskId: "task-cleanup",
			sourceRoot,
			workspaceId: "workspace-1",
			baseRef: "main",
		});
		const isolatedPath = created.instance?.isolatedPath ?? "";
		writeFileSync(join(isolatedPath, "summary.md"), "agent wrote this\n", "utf8");
		// Give the copy a distinct mtime so it is clearly not a fresh copy.
		spawnSync("sleep", ["0.01"], { stdio: "ignore" });

		const refused = await cleanupIsolatedWorkspace({ taskId: "task-cleanup", sourceRoot });
		expect(refused.ok).toBe(false);
		expect(refused.refusedReason).toBeTruthy();
		expect(existsSync(isolatedPath)).toBe(true);

		const forced = await cleanupIsolatedWorkspace({ taskId: "task-cleanup", sourceRoot, force: true });
		expect(forced.ok).toBe(true);
		expect(forced.removed).toBe(true);
		expect(existsSync(isolatedPath)).toBe(false);
		// The source workspace is never touched by cleanup.
		expect(readFileSync(join(sourceRoot, "file.txt"), "utf8")).toBe("base\n");
	});

	it("creates a git worktree for a repository rooted at the project root", async () => {
		const sourceRoot = createTempDirectory("kanban-isolated-git-");
		initGitRepository(sourceRoot);
		spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: sourceRoot, stdio: "ignore" });
		spawnSync("git", ["config", "user.name", "Test"], { cwd: sourceRoot, stdio: "ignore" });
		writeFileSync(join(sourceRoot, "app.js"), "console.log('hi')\n", "utf8");
		spawnSync("git", ["add", "-A"], { cwd: sourceRoot, stdio: "ignore" });
		spawnSync("git", ["commit", "-m", "initial"], { cwd: sourceRoot, stdio: "ignore" });

		const result = await createOrReuseIsolatedWorkspace({
			taskId: "task-git",
			sourceRoot,
			workspaceId: "workspace-1",
			baseRef: "main",
		});

		expect(result.ok).toBe(true);
		const isolatedPath = result.instance?.isolatedPath ?? "";
		expect(existsSync(join(isolatedPath, "app.js"))).toBe(true);
		// A worktree uses a `.git` file, not a directory.
		expect(existsSync(join(isolatedPath, ".git"))).toBe(true);
	});

	it("describes a direct task as running in the project root without creating anything", async () => {
		const sourceRoot = createTempDirectory("kanban-isolated-direct-");
		writeFileSync(join(sourceRoot, "file.txt"), "base\n", "utf8");

		const instance = await describeTaskWorkspaceInstance({
			taskId: "task-direct",
			sourceRoot,
			mode: "direct",
			workspaceId: "workspace-1",
		});

		expect(instance.mode).toBe("direct");
		expect(instance.workingDirectory).toBe(sourceRoot);
		expect(instance.isolatedPath).toBeNull();
		expect(instance.exists).toBe(true);
	});
});
