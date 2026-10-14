// File-snapshot comparison for non-Git workspaces.
//
// Without version control there is no baseline to diff against, so Kanban stores
// a snapshot of a task's isolated workspace before the agent starts and compares
// the current state against it. This is what makes non-Git projects reviewable
// at all, and it is also the basis for conflict detection on apply.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-paths";

const SNAPSHOT_DIRECTORY_NAME = "snapshots";
const MAX_SNAPSHOT_FILES = 100_000;
/** Files larger than this are recorded by hash only, never by content. */
const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024;
/** Directories never included in a snapshot. */
const SNAPSHOT_SKIP_DIRECTORIES = new Set([
	".git",
	".repo",
	"node_modules",
	".next",
	".nuxt",
	".turbo",
	"dist",
	"build",
	"coverage",
	"target",
	"__pycache__",
	".venv",
	"venv",
	".terraform",
	".gradle",
]);

export interface SnapshotFileEntry {
	path: string;
	hash: string;
	size: number;
	/** File content, when small enough to store. Null means "hash only". */
	content: string | null;
}

interface SnapshotRecord {
	version: number;
	taskId: string;
	workspacePath: string;
	createdAt: number;
	files: SnapshotFileEntry[];
	truncated: boolean;
}

const SNAPSHOT_VERSION = 1;

export interface SnapshotDiffEntry {
	path: string;
	previousPath?: string;
	status: "added" | "modified" | "deleted";
	additions: number;
	deletions: number;
	oldText: string | null;
	newText: string | null;
}

export interface TaskSnapshotHandle {
	taskId: string;
	workspacePath: string;
	snapshotPath: string;
	createdAt: number;
	fileCount: number;
	truncated: boolean;
	/** Absolute directory the snapshot was captured from. */
	capturedFrom: string;
}

function getSnapshotsRootPath(): string {
	return join(getRuntimeHomePath(), SNAPSHOT_DIRECTORY_NAME);
}

function sanitizeTaskIdForPath(taskId: string): string {
	return taskId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getSnapshotPath(taskId: string, workspacePath: string): string {
	const scopeHash = createHash("sha256").update(workspacePath).digest("hex").slice(0, 12);
	return join(getSnapshotsRootPath(), `${sanitizeTaskIdForPath(taskId)}-${scopeHash}.json`);
}

function isTextLike(content: Buffer): boolean {
	// Treat a file as text when it has no NUL byte in its first 8 KiB.
	const sample = content.subarray(0, 8192);
	return !sample.includes(0);
}

function countLines(text: string): number {
	if (!text) {
		return 0;
	}
	return text.split("\n").length;
}

function hashContent(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

interface CaptureOptions {
	taskId: string;
	/** Directory to capture. */
	sourcePath: string;
	/** Scope key so two roots cannot collide. */
	workspacePath: string;
}

/**
 * Capture a snapshot of a directory tree.
 *
 * Secrets are not filtered here (the isolated workspace copy already excludes
 * them); this only records what exists so later comparisons are meaningful.
 */
export async function captureTaskSnapshot(options: CaptureOptions): Promise<TaskSnapshotHandle> {
	const files: SnapshotFileEntry[] = [];
	let truncated = false;

	const walk = async (currentPath: string, relativePath: string): Promise<void> => {
		if (files.length >= MAX_SNAPSHOT_FILES) {
			truncated = true;
			return;
		}
		let entries: Array<{
			name: string;
			isDirectory: () => boolean;
			isFile: () => boolean;
			isSymbolicLink: () => boolean;
		}>;
		try {
			entries = await readdir(currentPath, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= MAX_SNAPSHOT_FILES) {
				truncated = true;
				return;
			}
			if (entry.isSymbolicLink()) {
				continue;
			}
			const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
			const entryPath = join(currentPath, entry.name);
			if (entry.isDirectory()) {
				if (SNAPSHOT_SKIP_DIRECTORIES.has(entry.name)) {
					continue;
				}
				await walk(entryPath, entryRelativePath);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			try {
				const fileStat = await stat(entryPath);
				const isSmallEnough = fileStat.size <= MAX_SNAPSHOT_FILE_BYTES;
				const content = isSmallEnough ? await readFile(entryPath) : null;
				files.push({
					path: entryRelativePath,
					hash: content ? hashContent(content) : `${fileStat.size}:${fileStat.mtimeMs}`,
					size: fileStat.size,
					content: content && isTextLike(content) ? content.toString("utf8") : null,
				});
			} catch {
				// Skip unreadable files rather than failing the capture.
			}
		}
	};

	await walk(options.sourcePath, "");

	const record: SnapshotRecord = {
		version: SNAPSHOT_VERSION,
		taskId: options.taskId,
		workspacePath: options.workspacePath,
		createdAt: Date.now(),
		files,
		truncated,
	};

	const snapshotPath = getSnapshotPath(options.taskId, options.workspacePath);
	await lockedFileSystem.writeJsonFileAtomic(snapshotPath, record, { lock: null });

	return {
		taskId: options.taskId,
		workspacePath: options.workspacePath,
		snapshotPath,
		createdAt: record.createdAt,
		fileCount: files.length,
		truncated,
		capturedFrom: options.sourcePath,
	};
}

export async function readTaskSnapshot(taskId: string, workspacePath: string): Promise<SnapshotRecord | null> {
	try {
		const raw = await readFile(getSnapshotPath(taskId, workspacePath), "utf8");
		const parsed = JSON.parse(raw) as SnapshotRecord;
		if (parsed.version !== SNAPSHOT_VERSION) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

export async function hasTaskSnapshot(taskId: string, workspacePath: string): Promise<boolean> {
	return (await readTaskSnapshot(taskId, workspacePath)) !== null;
}

export async function deleteTaskSnapshot(taskId: string, workspacePath: string): Promise<void> {
	await rm(getSnapshotPath(taskId, workspacePath), { force: true }).catch(() => {});
}

export interface SnapshotDiffInput {
	taskId: string;
	/** Project root, used as the snapshot scope key. */
	workspacePath: string;
	/** Directory to compare against the snapshot. */
	currentPath: string;
}

/**
 * Compare a directory against a previously captured snapshot.
 *
 * Returns the same shape the Git diff pipeline produces so review UI can render
 * both without branching.
 */
export async function diffSnapshotDirectories(input: SnapshotDiffInput): Promise<SnapshotDiffEntry[]> {
	const snapshot = await readTaskSnapshot(input.taskId, input.workspacePath);
	if (!snapshot) {
		return [];
	}

	const baselineByPath = new Map(snapshot.files.map((file) => [file.path, file]));
	const currentByPath = new Map<string, SnapshotFileEntry>();

	const walk = async (currentPath: string, relativePath: string): Promise<void> => {
		if (currentByPath.size >= MAX_SNAPSHOT_FILES) {
			return;
		}
		let entries: Array<{
			name: string;
			isDirectory: () => boolean;
			isFile: () => boolean;
			isSymbolicLink: () => boolean;
		}>;
		try {
			entries = await readdir(currentPath, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) {
				continue;
			}
			const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
			const entryPath = join(currentPath, entry.name);
			if (entry.isDirectory()) {
				if (SNAPSHOT_SKIP_DIRECTORIES.has(entry.name)) {
					continue;
				}
				await walk(entryPath, entryRelativePath);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			try {
				const fileStat = await stat(entryPath);
				const isSmallEnough = fileStat.size <= MAX_SNAPSHOT_FILE_BYTES;
				const content = isSmallEnough ? await readFile(entryPath) : null;
				currentByPath.set(entryRelativePath, {
					path: entryRelativePath,
					hash: content ? hashContent(content) : `${fileStat.size}:${fileStat.mtimeMs}`,
					size: fileStat.size,
					content: content && isTextLike(content) ? content.toString("utf8") : null,
				});
			} catch {
				// Skip unreadable files.
			}
		}
	};

	await walk(input.currentPath, "");

	const changes: SnapshotDiffEntry[] = [];
	for (const [path, current] of currentByPath) {
		const baseline = baselineByPath.get(path);
		if (!baseline) {
			changes.push({
				path,
				status: "added",
				additions: countLines(current.content ?? ""),
				deletions: 0,
				oldText: null,
				newText: current.content,
			});
			continue;
		}
		if (baseline.hash === current.hash) {
			continue;
		}
		changes.push({
			path,
			status: "modified",
			additions: countLines(current.content ?? ""),
			deletions: countLines(baseline.content ?? ""),
			oldText: baseline.content,
			newText: current.content,
		});
	}
	for (const [path, baseline] of baselineByPath) {
		if (currentByPath.has(path)) {
			continue;
		}
		changes.push({
			path,
			status: "deleted",
			additions: 0,
			deletions: countLines(baseline.content ?? ""),
			oldText: baseline.content,
			newText: null,
		});
	}

	changes.sort((left, right) => left.path.localeCompare(right.path));
	return changes;
}

/**
 * Write an updated snapshot after changes have been applied back to the source
 * workspace, so the same changes are not reported twice.
 */
export async function refreshTaskSnapshot(input: {
	taskId: string;
	workspacePath: string;
	sourcePath: string;
}): Promise<TaskSnapshotHandle> {
	return await captureTaskSnapshot({
		taskId: input.taskId,
		workspacePath: input.workspacePath,
		sourcePath: input.sourcePath,
	});
}

/** Write snapshot content files into a directory (used when applying changes). */
export async function writeSnapshotFile(targetPath: string, content: string): Promise<void> {
	await mkdir(dirname(targetPath), { recursive: true });
	await writeFile(targetPath, content, "utf8");
}

/** Relative path helper kept here so callers do not re-implement separators. */
export function toSnapshotRelativePath(from: string, to: string): string {
	return relative(from, to).replaceAll("\\", "/");
}
