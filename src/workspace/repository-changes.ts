// Aggregates workspace changes across every repository in a project.
//
// The existing single-repository diff pipeline assumes one Git root. That
// assumption breaks for a plain folder, a parent of several repositories, and a
// `google-repo` checkout, so this module fans out to each repository and reports
// per-repository results instead of pretending there is one root.
import { join, relative, resolve } from "node:path";

import type {
	RuntimeTaskExecutionMode,
	RuntimeWorkspaceFileChange,
	RuntimeWorkspaceFileStatus,
	RuntimeWorkspaceRepositoryChanges,
	RuntimeWorkspaceRepositoryChangesResponse,
	RuntimeWorkspaceType,
} from "../core/api-contract";
import {
	getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef,
} from "./get-workspace-changes";
import { diffSnapshotDirectories, type SnapshotDiffEntry } from "./snapshot-diff";
import { loadWorkspaceDiscovery } from "./workspace-discovery";

interface RepositoryTarget {
	relativePath: string;
	workTreePath: string;
	kind: "git" | "snapshot";
}

function toRepositoryTargets(input: {
	workspaceType: RuntimeWorkspaceType;
	workspacePath: string;
	repositories: Array<{ relativePath: string; workTreePath: string; isRoot: boolean }>;
}): RepositoryTarget[] {
	if (input.workspaceType === "git") {
		const root = input.repositories.find((repository) => repository.isRoot) ?? input.repositories[0];
		return [
			{
				relativePath: root?.relativePath ?? "",
				workTreePath: root?.workTreePath ?? input.workspacePath,
				kind: "git",
			},
		];
	}
	if (input.repositories.length > 0) {
		return input.repositories.map((repository) => ({
			relativePath: repository.relativePath,
			workTreePath: repository.workTreePath,
			kind: "git" as const,
		}));
	}
	return [
		{
			relativePath: "",
			workTreePath: input.workspacePath,
			kind: "snapshot",
		},
	];
}

function toSnapshotFileChange(entry: SnapshotDiffEntry): RuntimeWorkspaceFileChange {
	return {
		path: entry.path,
		...(entry.previousPath ? { previousPath: entry.previousPath } : {}),
		status: mapSnapshotStatus(entry.status),
		additions: entry.additions,
		deletions: entry.deletions,
		oldText: entry.oldText,
		newText: entry.newText,
	};
}

function mapSnapshotStatus(status: SnapshotDiffEntry["status"]): RuntimeWorkspaceFileStatus {
	switch (status) {
		case "added":
			return "added";
		case "deleted":
			return "deleted";
		case "modified":
			return "modified";
		default:
			return "unknown";
	}
}

export interface GetWorkspaceRepositoryChangesInput {
	workspaceId: string;
	workspacePath: string;
	taskId: string;
	baseRef: string;
	mode: "working_copy" | "last_turn";
	/** Last-turn checkpoint commits for Git mode, when available. */
	fromCheckpointCommit?: string | null;
	toCheckpointCommit?: string | null;
	/** Where the agent actually worked, when reviewing an isolated task. */
	changesRoot?: string;
	executionMode?: RuntimeTaskExecutionMode;
}

/**
 * Collect changes for every repository in a workspace.
 *
 * Each repository is inspected independently and failures are captured per
 * repository rather than failing the whole request, so one broken sub-repository
 * cannot blank out the review panel.
 */
export async function getWorkspaceRepositoryChanges(
	input: GetWorkspaceRepositoryChangesInput,
): Promise<RuntimeWorkspaceRepositoryChangesResponse> {
	const changesRoot = input.changesRoot ?? input.workspacePath;
	const discovery = await loadWorkspaceDiscovery(input.workspaceId, input.workspacePath);
	const targets = toRepositoryTargets({
		workspaceType: discovery.workspaceType,
		workspacePath: changesRoot,
		repositories: discovery.repositories.map((repository) => {
			// Re-root each repository onto the changes directory so isolated tasks
			// report changes from the isolated copy, not the source project.
			if (changesRoot === input.workspacePath) {
				return repository;
			}
			return {
				relativePath: repository.relativePath,
				workTreePath: repository.relativePath ? join(changesRoot, repository.relativePath) : changesRoot,
				isRoot: repository.isRoot,
			};
		}),
	});

	const repositories = await Promise.all(
		targets.map(async (target): Promise<RuntimeWorkspaceRepositoryChanges> => {
			try {
				const files = await collectRepositoryFiles(target, input);
				return {
					relativePath: target.relativePath,
					workTreePath: target.workTreePath,
					kind: target.kind,
					error: null,
					files,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					relativePath: target.relativePath,
					workTreePath: target.workTreePath,
					kind: target.kind,
					error: message,
					files: [],
				};
			}
		}),
	);

	return {
		generatedAt: Date.now(),
		workspaceType: discovery.workspaceType,
		repositories,
		partial: repositories.some((repository) => repository.error !== null),
	};
}

async function collectRepositoryFiles(
	target: RepositoryTarget,
	input: GetWorkspaceRepositoryChangesInput,
): Promise<RuntimeWorkspaceFileChange[]> {
	if (target.kind === "snapshot") {
		// Non-Git projects have no baseline in version control, so a snapshot
		// comparison is the only way to show what an agent changed.
		const snapshotDiff = await diffSnapshotDirectories({
			taskId: input.taskId,
			workspacePath: input.workspacePath,
			currentPath: target.workTreePath,
		});
		return snapshotDiff.map(toSnapshotFileChange);
	}

	if (input.mode === "last_turn" && input.toCheckpointCommit) {
		if (input.fromCheckpointCommit) {
			return (
				await getWorkspaceChangesBetweenRefs({
					cwd: target.workTreePath,
					fromRef: input.fromCheckpointCommit,
					toRef: input.toCheckpointCommit,
				})
			).files;
		}
		return (
			await getWorkspaceChangesFromRef({
				cwd: target.workTreePath,
				fromRef: input.toCheckpointCommit,
			})
		).files;
	}

	return (await getWorkspaceChanges(target.workTreePath)).files;
}

/** Relative path of a repository to its project root, for display grouping. */
export function getRepositoryDisplayLabel(repository: RuntimeWorkspaceRepositoryChanges): string {
	if (repository.relativePath) {
		return repository.relativePath;
	}
	if (repository.kind === "snapshot") {
		return ".";
	}
	return relative(resolve(repository.workTreePath), resolve(repository.workTreePath)) || ".";
}
