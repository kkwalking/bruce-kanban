import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	discoverWorkspaceType,
	hasRootGitRepository,
	parseRepoManifestProjectPaths,
} from "../../../src/workspace/workspace-discovery";

const createdDirectories: string[] = [];

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

function writeGitConfigIdentity(path: string): void {
	spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: path, stdio: "ignore" });
	spawnSync("git", ["config", "user.name", "Test"], { cwd: path, stdio: "ignore" });
}

afterEach(() => {
	while (createdDirectories.length > 0) {
		const directory = createdDirectories.pop();
		if (directory) {
			rmSync(directory, { recursive: true, force: true });
		}
	}
});

describe("parseRepoManifestProjectPaths", () => {
	it("extracts project paths and ignores duplicates and unnamed remotes", () => {
		const manifest = [
			'<?xml version="1.0"?>',
			"<manifest>",
			'  <remote name="aosp" fetch=".." />',
			'  <project path="frameworks/base" name="platform/frameworks/base" />',
			"  <project path='system/core' />",
			'  <project name="no/path" />',
			'  <project path="frameworks/base" name="dup" />',
			"</manifest>",
		].join("\n");

		expect(parseRepoManifestProjectPaths(manifest)).toEqual(["frameworks/base", "system/core"]);
	});

	it("returns nothing for a manifest without projects", () => {
		expect(parseRepoManifestProjectPaths("<manifest></manifest>")).toEqual([]);
	});
});

describe("discoverWorkspaceType", () => {
	it("reports a plain folder as `none` without throwing", async () => {
		const root = createTempDirectory("kanban-discovery-none-");
		writeFileSync(join(root, "main.py"), "print('hi')\n", "utf8");

		const result = await discoverWorkspaceType(root);

		expect(result.workspaceType).toBe("none");
		expect(result.rootPath).toBe(root);
		expect(result.repositories).toEqual([]);
		expect(result.warning).toBeNull();
		expect(hasRootGitRepository(result)).toBe(false);
	});

	it("reports a single repository at the root as `git`", async () => {
		const root = createTempDirectory("kanban-discovery-git-");
		initGitRepository(root);
		writeGitConfigIdentity(root);
		writeFileSync(join(root, "README.md"), "# repo\n", "utf8");

		const result = await discoverWorkspaceType(root);

		expect(result.workspaceType).toBe("git");
		expect(result.repositories).toHaveLength(1);
		expect(result.repositories[0]?.isRoot).toBe(true);
		expect(hasRootGitRepository(result)).toBe(true);
	});

	it("reports a parent of several repositories as multi-git, not as separate projects", async () => {
		const root = createTempDirectory("kanban-discovery-multi-");
		for (const name of ["repo-one", "repo-two"]) {
			const repositoryPath = join(root, name);
			mkdirSync(repositoryPath, { recursive: true });
			initGitRepository(repositoryPath);
		}

		const result = await discoverWorkspaceType(root);

		expect(result.workspaceType).toBe("multi-git");
		expect(result.repositories.map((repository) => repository.relativePath)).toEqual(["repo-one", "repo-two"]);
		// The project root keeps its own identity.
		expect(result.rootPath).toBe(root);
	});

	it("recognizes a google repo workspace from its manifest", async () => {
		const root = createTempDirectory("kanban-discovery-repo-");
		mkdirSync(join(root, ".repo", "manifests"), { recursive: true });
		mkdirSync(join(root, "frameworks", "base"), { recursive: true });
		initGitRepository(join(root, "frameworks", "base"));
		writeFileSync(
			join(root, ".repo", "manifests", "default.xml"),
			'<manifest>\n  <project path="frameworks/base" />\n  <project path="missing/does-not-exist" />\n</manifest>\n',
			"utf8",
		);

		const result = await discoverWorkspaceType(root);

		expect(result.workspaceType).toBe("google-repo");
		expect(result.repoManifestPath).toContain("default.xml");
		// Only existing project directories become repositories.
		expect(result.repositories.map((repository) => repository.relativePath)).toEqual(["frameworks/base"]);
	});

	it("detects a git worktree via a `.git` file rather than a directory", async () => {
		const repositoryRoot = createTempDirectory("kanban-discovery-worktree-src-");
		initGitRepository(repositoryRoot);
		writeGitConfigIdentity(repositoryRoot);
		writeFileSync(join(repositoryRoot, "file.txt"), "content\n", "utf8");
		spawnSync("git", ["add", "-A"], { cwd: repositoryRoot, stdio: "ignore" });
		spawnSync("git", ["commit", "-m", "initial"], { cwd: repositoryRoot, stdio: "ignore" });

		const worktreePath = join(createTempDirectory("kanban-discovery-worktree-parent-"), "worktree");
		const addResult = spawnSync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
			cwd: repositoryRoot,
			stdio: "ignore",
		});
		if (addResult.status !== 0) {
			return;
		}

		const result = await discoverWorkspaceType(worktreePath);

		expect(result.workspaceType).toBe("git");
		expect(hasRootGitRepository(result)).toBe(true);
	});

	it("does not modify the folder it inspects", async () => {
		const root = createTempDirectory("kanban-discovery-no-mutation-");
		writeFileSync(join(root, "main.py"), "print('hi')\n", "utf8");

		await discoverWorkspaceType(root);

		// No `.git` directory should have been created by discovery.
		const result = await discoverWorkspaceType(root);
		expect(result.workspaceType).toBe("none");
		expect(result.repositories).toEqual([]);
	});
});
