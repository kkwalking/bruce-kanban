// Regression tests for a P0 bug: task creation was impossible in any project
// whose root is not itself a Git repository.
//
// `baseRef` is a Git-only concept, but it was treated as required in the card
// schema, the board mutations, request validation, and the task-creation UI.
// For a plain folder, a multi-repository parent, or a `google-repo` checkout
// there are no branches, so the ref was always empty and every create path
// refused the task. FR-01 and FR-03.3 explicitly require Git to be optional, so
// these tests pin the empty-ref case as valid.
import { describe, expect, it } from "vitest";

import {
	runtimeBoardCardSchema,
	runtimeTaskSessionStartRequestSchema,
	runtimeWorkspaceChangesRequestSchema,
} from "../../../src/core/api-contract";
import { parseTaskSessionStartRequest, parseWorkspaceChangesInput } from "../../../src/core/api-validation";
import { addTaskToColumn, updateTask } from "../../../src/core/task-board-mutations";

function createEmptyBoard() {
	return {
		columns: [
			{ id: "backlog" as const, title: "Backlog", cards: [] },
			{ id: "in_progress" as const, title: "In Progress", cards: [] },
			{ id: "review" as const, title: "Review", cards: [] },
			{ id: "trash" as const, title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

describe("non-git projects can create and start tasks", () => {
	it("accepts an empty baseRef on a task card", () => {
		const parsed = runtimeBoardCardSchema.parse({
			id: "task-1",
			prompt: "edit main.py",
			startInPlanMode: false,
			baseRef: "",
			createdAt: 1,
			updatedAt: 1,
		});

		expect(parsed.baseRef).toBe("");
	});

	it("defaults a missing baseRef to an empty string rather than failing", () => {
		const parsed = runtimeBoardCardSchema.parse({
			id: "task-1",
			prompt: "edit main.py",
			startInPlanMode: false,
			createdAt: 1,
			updatedAt: 1,
		});

		expect(parsed.baseRef).toBe("");
	});

	it("creates a backlog card in a project with no branches", () => {
		const result = addTaskToColumn(
			createEmptyBoard(),
			"backlog",
			{
				prompt: "add a docstring",
				baseRef: "",
				executionMode: "direct",
			},
			() => "task-1",
			1000,
		);

		expect(result.task.baseRef).toBe("");
		expect(result.task.executionMode).toBe("direct");
		expect(result.board.columns[0]?.cards).toHaveLength(1);
	});

	it("still requires a prompt even without a base ref", () => {
		expect(() =>
			addTaskToColumn(createEmptyBoard(), "backlog", { prompt: "   ", baseRef: "" }, () => "task-1", 1000),
		).toThrow(/prompt is required/i);
	});

	it("updates a card in a project with no branches", () => {
		const created = addTaskToColumn(
			createEmptyBoard(),
			"backlog",
			{ prompt: "first", baseRef: "" },
			() => "task-1",
			1000,
		);

		// Task ids are normalized on creation (see task-id.ts), so use the id the
		// mutation actually assigned rather than the literal passed in.
		const updated = updateTask(created.board, created.task.id, {
			prompt: "second",
			baseRef: "",
			executionMode: "isolated",
		});

		expect(updated.updated).toBe(true);
		expect(updated.task?.prompt).toBe("second");
	});

	it("accepts an empty baseRef when starting a task session", () => {
		const parsed = runtimeTaskSessionStartRequestSchema.parse({
			taskId: "task-1",
			prompt: "do work",
			baseRef: "",
		});

		expect(parsed.baseRef).toBe("");

		const normalized = parseTaskSessionStartRequest({
			taskId: "task-1",
			prompt: "do work",
			baseRef: "",
		});

		expect(normalized.baseRef).toBe("");
	});

	it("accepts a missing baseRef when starting a task session", () => {
		const normalized = parseTaskSessionStartRequest({
			taskId: "task-1",
			prompt: "do work",
		});

		expect(normalized.baseRef).toBe("");
	});

	it("accepts an empty baseRef when loading changes", () => {
		const parsed = runtimeWorkspaceChangesRequestSchema.parse({ taskId: "task-1", baseRef: "" });
		expect(parsed.baseRef).toBe("");

		const normalized = parseWorkspaceChangesInput({ taskId: "task-1", baseRef: "" });
		expect(normalized.baseRef).toBe("");

		const withoutRef = parseWorkspaceChangesInput({ taskId: "task-1" });
		expect(withoutRef.baseRef).toBe("");
	});

	it("still rejects a changes request without a taskId", () => {
		expect(() => parseWorkspaceChangesInput({ taskId: "  ", baseRef: "" })).toThrow(/taskId/i);
	});
});
