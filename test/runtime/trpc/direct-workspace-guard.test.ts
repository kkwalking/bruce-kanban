import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { DirectWorkspaceBusyError, findConflictingDirectTaskIds } from "../../../src/trpc/runtime-api";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/project",
		executionMode: "direct",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		awaitingPermission: false,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

describe("direct workspace single-writer guard", () => {
	it("reports another running Direct task as a conflict", () => {
		const conflicts = findConflictingDirectTaskIds({
			summaries: [createSummary({ taskId: "other-task", executionMode: "direct", state: "running" })],
			requestedTaskId: "task-1",
		});

		expect(conflicts).toEqual(["other-task"]);
	});

	it("ignores Isolated tasks because they cannot clobber the project root", () => {
		const conflicts = findConflictingDirectTaskIds({
			summaries: [createSummary({ taskId: "isolated-task", executionMode: "isolated", state: "running" })],
			requestedTaskId: "task-1",
		});

		expect(conflicts).toEqual([]);
	});

	it("allows parallel Isolated tasks", () => {
		const conflicts = findConflictingDirectTaskIds({
			summaries: [
				createSummary({ taskId: "isolated-a", executionMode: "isolated", state: "running" }),
				createSummary({ taskId: "isolated-b", executionMode: "isolated", state: "running" }),
			],
			requestedTaskId: "new-isolated-task",
		});

		expect(conflicts).toEqual([]);
	});

	it("excludes the requested task so resuming it is not self-blocking", () => {
		const conflicts = findConflictingDirectTaskIds({
			summaries: [createSummary({ taskId: "task-1", executionMode: "direct", state: "awaiting_review" })],
			requestedTaskId: "task-1",
		});

		expect(conflicts).toEqual([]);
	});

	it("ignores Direct tasks that already finished", () => {
		const conflicts = findConflictingDirectTaskIds({
			summaries: [
				createSummary({ taskId: "finished", executionMode: "direct", state: "idle" }),
				createSummary({ taskId: "failed", executionMode: "direct", state: "failed" }),
				createSummary({ taskId: "interrupted", executionMode: "direct", state: "interrupted" }),
			],
			requestedTaskId: "task-1",
		});

		expect(conflicts).toEqual([]);
	});

	it("treats a task awaiting review as still holding the workspace", () => {
		// Awaiting review means the agent is paused, not gone. Starting a second
		// writer could still conflict with unfinished work.
		const conflicts = findConflictingDirectTaskIds({
			summaries: [createSummary({ taskId: "paused", executionMode: "direct", state: "awaiting_review" })],
			requestedTaskId: "task-1",
		});

		expect(conflicts).toEqual(["paused"]);
	});

	it("describes the conflict in actionable terms", () => {
		const error = new DirectWorkspaceBusyError(["first-task", "second-task"]);

		expect(error.message).toContain("first-task");
		expect(error.message).toContain("second-task");
		expect(error.message).toContain("Isolated");
		expect(error.name).toBe("DirectWorkspaceBusyError");
	});
});
