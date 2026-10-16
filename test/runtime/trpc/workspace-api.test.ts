import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary, RuntimeWorkspaceChangesResponse } from "../../../src/core/api-contract";

const workspaceTaskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
}));

const discoveryMocks = vi.hoisted(() => ({
	loadWorkspaceDiscovery: vi.fn(),
}));

const isolatedWorkspaceMocks = vi.hoisted(() => ({
	cleanupIsolatedWorkspace: vi.fn(),
	describeTaskWorkspaceInstance: vi.fn(),
	resolveTaskWorkingDirectory: vi.fn(),
}));

vi.mock("../../../src/workspace/isolated-workspace.js", () => ({
	cleanupIsolatedWorkspace: isolatedWorkspaceMocks.cleanupIsolatedWorkspace,
	describeTaskWorkspaceInstance: isolatedWorkspaceMocks.describeTaskWorkspaceInstance,
	resolveTaskWorkingDirectory: isolatedWorkspaceMocks.resolveTaskWorkingDirectory,
}));

const workspaceChangesMocks = vi.hoisted(() => ({
	createEmptyWorkspaceChangesResponse: vi.fn(),
	getWorkspaceChanges: vi.fn(),
	getWorkspaceChangesBetweenRefs: vi.fn(),
	getWorkspaceChangesFromRef: vi.fn(),
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	deleteTaskWorktree: vi.fn(),
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
	getTaskWorkspaceInfo: vi.fn(),
	resolveTaskCwd: workspaceTaskWorktreeMocks.resolveTaskCwd,
}));

/*
	Review routing now consults workspace discovery so non-Git projects do not
	crash the diff pipeline. These tests cover the Git path, so discovery reports
	a Git repository rooted at the project root.
*/
vi.mock("../../../src/workspace/workspace-discovery.js", () => ({
	hasRootGitRepository: (result: { workspaceType: string }) => result.workspaceType === "git",
	loadWorkspaceDiscovery: discoveryMocks.loadWorkspaceDiscovery,
}));

vi.mock("../../../src/workspace/get-workspace-changes.js", () => ({
	createEmptyWorkspaceChangesResponse: workspaceChangesMocks.createEmptyWorkspaceChangesResponse,
	getWorkspaceChanges: workspaceChangesMocks.getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs: workspaceChangesMocks.getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef: workspaceChangesMocks.getWorkspaceChangesFromRef,
}));

import { createWorkspaceApi } from "../../../src/trpc/workspace-api";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function createChangesResponse(): RuntimeWorkspaceChangesResponse {
	return {
		repoRoot: "/tmp/worktree",
		generatedAt: Date.now(),
		files: [],
	};
}

describe("createWorkspaceApi loadChanges", () => {
	beforeEach(() => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockReset();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockReset();
		workspaceChangesMocks.getWorkspaceChanges.mockReset();
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockReset();
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockReset();

		discoveryMocks.loadWorkspaceDiscovery.mockReset();
		discoveryMocks.loadWorkspaceDiscovery.mockResolvedValue({
			workspaceType: "git",
			rootPath: "/tmp/repo",
			repositories: [{ relativePath: "", workTreePath: "/tmp/repo", gitDirPath: "/tmp/repo/.git", isRoot: true }],
			repoManifestProjects: [],
			repoManifestPath: null,
			warning: null,
			discoveredAt: Date.now(),
		});
		isolatedWorkspaceMocks.cleanupIsolatedWorkspace.mockReset();
		isolatedWorkspaceMocks.describeTaskWorkspaceInstance.mockReset();

		workspaceTaskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree");
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChanges.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockResolvedValue(createChangesResponse());
	});

	it("shows the completed turn diff while awaiting review", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "1111111",
						createdAt: 1,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => ({ getSummary: vi.fn(() => null) }) as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "1111111",
			toRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).not.toHaveBeenCalled();
	});

	it("tracks the current turn from the latest checkpoint while running", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "running",
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "1111111",
						createdAt: 1,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => ({ getSummary: vi.fn(() => null) }) as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).not.toHaveBeenCalled();
	});

	it("uses native cline session checkpoints when terminal summaries are unavailable", async () => {
		const terminalManager = {
			getSummary: vi.fn(() => null),
		};
		const clineTaskSessionService = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					latestTurnCheckpoint: {
						turn: 3,
						ref: "refs/kanban/checkpoints/task-1/turn/3",
						commit: "3333333",
						createdAt: 3,
					},
					previousTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(clineTaskSessionService.getSummary).toHaveBeenCalledWith("task-1");
		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "2222222",
			toRef: "3333333",
		});
	});

	it("prefers the newer live cline summary over a stale terminal summary", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					agentId: "claude",
					updatedAt: 10,
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "terminal-2",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "terminal-1",
						createdAt: 1,
					},
				}),
			),
		};
		const clineTaskSessionService = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					agentId: "cline",
					updatedAt: 20,
					latestTurnCheckpoint: {
						turn: 3,
						ref: "refs/kanban/checkpoints/task-1/turn/3",
						commit: "cline-3",
						createdAt: 3,
					},
					previousTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "cline-2",
						createdAt: 2,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "cline-2",
			toRef: "cline-3",
		});
	});

	it("returns an empty diff when the task worktree does not exist yet", async () => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockRejectedValue(
			new Error('Task worktree not found for task "task-1".'),
		);

		const emptyResponse = createChangesResponse();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(emptyResponse);

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(),
			getScopedClineTaskSessionService: vi.fn(),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		const response = await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "working_copy",
			},
		);

		expect(response).toBe(emptyResponse);
		expect(workspaceChangesMocks.createEmptyWorkspaceChangesResponse).toHaveBeenCalledWith("/tmp/repo");
		expect(workspaceChangesMocks.getWorkspaceChanges).not.toHaveBeenCalled();
	});

	/*
	Regression: `ensureWorktree` is the UI's preflight before moving a card to
	In Progress. It used to always create a Git worktree, so every non-Git project
	failed with `git rev-parse --git-common-dir failed` when dragging a card.
*/
	describe("createWorkspaceApi ensureWorktree", () => {
		beforeEach(() => {
			discoveryMocks.loadWorkspaceDiscovery.mockReset();
			isolatedWorkspaceMocks.cleanupIsolatedWorkspace.mockReset();
		});

		function createApi() {
			return createWorkspaceApi({
				ensureTerminalManagerForWorkspace: vi.fn(async () => ({}) as never),
				getScopedClineTaskSessionService: vi.fn(async () => ({ getSummary: vi.fn(() => null) }) as never),
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				buildWorkspaceStateSnapshot: vi.fn(),
			});
		}

		it("returns the project root for a Direct task in a non-Git project", async () => {
			discoveryMocks.loadWorkspaceDiscovery.mockResolvedValue({
				workspaceType: "none",
				rootPath: "/tmp/plain",
				repositories: [],
				repoManifestProjects: [],
				repoManifestPath: null,
				warning: null,
				discoveredAt: Date.now(),
			});

			const api = createApi();
			const response = await api.ensureWorktree(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/plain" },
				{ taskId: "task-1", baseRef: "", executionMode: "direct" },
			);

			expect(response.ok).toBe(true);
			if (response.ok) {
				expect(response.path).toBe("/tmp/plain");
			}
			// The Git worktree path must not be consulted at all.
			expect(workspaceTaskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
		});

		it("prepares an isolated workspace for a non-Git project without Git", async () => {
			discoveryMocks.loadWorkspaceDiscovery.mockResolvedValue({
				workspaceType: "google-repo",
				rootPath: "/tmp/android",
				repositories: [],
				repoManifestProjects: ["frameworks/base"],
				repoManifestPath: "/tmp/android/.repo/manifests/default.xml",
				warning: null,
				discoveredAt: Date.now(),
			});
			isolatedWorkspaceMocks.resolveTaskWorkingDirectory.mockResolvedValue({
				ok: true,
				instance: {
					taskId: "task-1",
					mode: "isolated",
					sourceRoot: "/tmp/android",
					workingDirectory: "/tmp/isolated/workspace",
					isolatedPath: "/tmp/isolated/workspace",
					exists: true,
					fileCount: 1,
					sizeBytes: 1,
					createdAt: 1,
					unavailableReason: null,
				},
			});

			const api = createApi();
			const response = await api.ensureWorktree(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/android" },
				{ taskId: "task-1", baseRef: "", executionMode: "isolated" },
			);

			expect(response.ok).toBe(true);
			if (response.ok) {
				expect(response.path).toBe("/tmp/isolated/workspace");
			}
			expect(workspaceTaskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
		});

		it("surfaces an isolation failure instead of silently falling back", async () => {
			discoveryMocks.loadWorkspaceDiscovery.mockResolvedValue({
				workspaceType: "none",
				rootPath: "/tmp/plain",
				repositories: [],
				repoManifestProjects: [],
				repoManifestPath: null,
				warning: null,
				discoveredAt: Date.now(),
			});
			isolatedWorkspaceMocks.resolveTaskWorkingDirectory.mockResolvedValue({
				ok: false,
				instance: null,
				error: "Not enough space",
			});

			const api = createApi();
			const response = await api.ensureWorktree(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/plain" },
				{ taskId: "task-1", baseRef: "", executionMode: "isolated" },
			);

			expect(response.ok).toBe(false);
			if (!response.ok) {
				expect(response.error).toContain("Not enough space");
			}
		});
	});
});
