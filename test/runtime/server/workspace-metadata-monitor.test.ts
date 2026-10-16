/*
	Regression coverage for the reported bug: a task whose card said `direct`
	still advertised `~/.cline/worktrees/<task>/<label>` on its card, in the
	navbar, and in review.

	The cause was here, not in the resolver. This monitor described every Git
	project with `getTaskWorktreePathInfo`, which answers "where would a Git
	worktree live" — a question that ignores the task's execution mode. So a
	Direct task in a Git project was reported with a directory its agent never
	used, while the agent actually ran in the project root.

	These tests assert the reported path, since that is what the UI renders.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData } from "../../../src/core/api-contract";

const discoveryMocks = vi.hoisted(() => ({
	loadWorkspaceDiscovery: vi.fn(),
}));

const taskWorktreeMocks = vi.hoisted(() => ({
	getTaskWorkspacePathInfo: vi.fn(),
}));

const gitSyncMocks = vi.hoisted(() => ({
	getGitSyncSummary: vi.fn(),
	probeGitWorkspaceState: vi.fn(),
}));

vi.mock("../../../src/workspace/workspace-discovery.js", () => ({
	hasRootGitRepository: (result: { workspaceType: string; repositories: Array<{ isRoot: boolean }> }) =>
		result.workspaceType === "git" && result.repositories.some((repository) => repository.isRoot),
	loadWorkspaceDiscovery: discoveryMocks.loadWorkspaceDiscovery,
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	getTaskWorkspacePathInfo: taskWorktreeMocks.getTaskWorkspacePathInfo,
}));

vi.mock("../../../src/workspace/git-sync.js", () => ({
	getGitSyncSummary: gitSyncMocks.getGitSyncSummary,
	probeGitWorkspaceState: gitSyncMocks.probeGitWorkspaceState,
}));

import { createWorkspaceMetadataMonitor } from "../../../src/server/workspace-metadata-monitor";

const GIT_ROOT = "/tmp/repo";
const WORKTREE_PATH = "/tmp/kanban-home/worktrees/task-1/repo";

function createGitDiscovery() {
	return {
		workspaceType: "git",
		rootPath: GIT_ROOT,
		repositories: [{ relativePath: "", workTreePath: GIT_ROOT, gitDirPath: `${GIT_ROOT}/.git`, isRoot: true }],
		repoManifestProjects: [],
		repoManifestPath: null,
		warning: null,
		discoveredAt: Date.now(),
	};
}

function createCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: "task-1",
		title: "Task",
		prompt: "Do the thing",
		baseRef: "main",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	} as RuntimeBoardCard;
}

function createBoard(card: RuntimeBoardCard): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [card] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

async function loadTaskMetadata(card: RuntimeBoardCard) {
	const monitor = createWorkspaceMetadataMonitor({ onMetadataUpdated: vi.fn() });
	const metadata = await monitor.connectWorkspace({
		workspaceId: "workspace-1",
		workspacePath: GIT_ROOT,
		board: createBoard(card),
	});
	monitor.close();
	return metadata.taskWorkspaces[0] ?? null;
}

describe("workspace metadata monitor task paths", () => {
	beforeEach(() => {
		discoveryMocks.loadWorkspaceDiscovery.mockReset();
		taskWorktreeMocks.getTaskWorkspacePathInfo.mockReset();
		gitSyncMocks.getGitSyncSummary.mockReset();
		gitSyncMocks.probeGitWorkspaceState.mockReset();

		discoveryMocks.loadWorkspaceDiscovery.mockResolvedValue(createGitDiscovery());
		taskWorktreeMocks.getTaskWorkspacePathInfo.mockResolvedValue({
			taskId: "task-1",
			path: WORKTREE_PATH,
			exists: true,
			baseRef: "main",
		});
		gitSyncMocks.probeGitWorkspaceState.mockResolvedValue({
			repoRoot: WORKTREE_PATH,
			currentBranch: null,
			headCommit: "abc1234",
			untrackedPaths: [],
			stateToken: "token-1",
		});
		gitSyncMocks.getGitSyncSummary.mockResolvedValue({
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		});
	});

	it("reports the project root for a Direct task in a Git project", async () => {
		const metadata = await loadTaskMetadata(createCard({ executionMode: "direct" }));

		expect(metadata?.path).toBe(GIT_ROOT);
		// The worktree path must not even be computed: asking for it was the bug.
		expect(taskWorktreeMocks.getTaskWorkspacePathInfo).not.toHaveBeenCalled();
	});

	it("reports the worktree path for an Isolated task in a Git project", async () => {
		const metadata = await loadTaskMetadata(createCard({ executionMode: "isolated" }));

		expect(metadata?.path).toBe(WORKTREE_PATH);
		expect(metadata?.exists).toBe(true);
		// The Git pipeline still supplies branch and diff stats for isolated work.
		expect(metadata?.headCommit).toBe("abc1234");
	});

	it("keeps the worktree path for a legacy card with no stored execution mode", async () => {
		const metadata = await loadTaskMetadata(createCard());

		expect(metadata?.path).toBe(WORKTREE_PATH);
	});

	it("reports the isolated copy, not a worktree, for a Direct task in a non-Git project", async () => {
		discoveryMocks.loadWorkspaceDiscovery.mockResolvedValue({
			workspaceType: "none",
			rootPath: GIT_ROOT,
			repositories: [],
			repoManifestProjects: [],
			repoManifestPath: null,
			warning: null,
			discoveredAt: Date.now(),
		});

		const metadata = await loadTaskMetadata(createCard({ executionMode: "direct" }));

		expect(metadata?.path).toBe(GIT_ROOT);
		expect(taskWorktreeMocks.getTaskWorkspacePathInfo).not.toHaveBeenCalled();
	});
});
