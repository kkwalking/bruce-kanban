import { AlertTriangle, CheckCircle2, HardDrive, Layers, Trash2, Upload } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeIsolatedApplyPlan, RuntimeTaskExecutionMode } from "@/runtime/types";
import { formatPathForDisplay } from "@/utils/path-display";

export interface IsolatedWorkspacePanelProps {
	taskId: string;
	workspaceId: string;
	/** The mode this task actually ran in. Only `isolated` can be applied. */
	executionMode: RuntimeTaskExecutionMode | null;
	/** Absolute path the agent worked in, when known. */
	workspacePath: string | null;
}

/**
 * Shows the isolated workspace for a task and lets the user apply or clean it up.
 *
 * This panel exists because Direct and Isolated have genuinely different
 * lifecycles (FR-08 / AC-05.5): a Direct task's changes are already live, so an
 * "apply" button there would be misleading and is not offered. An Isolated task
 * needs an explicit, conflict-checked apply.
 */
export function IsolatedWorkspacePanel({
	taskId,
	workspaceId,
	executionMode,
	workspacePath,
}: IsolatedWorkspacePanelProps): ReactElement | null {
	const [plan, setPlan] = useState<RuntimeIsolatedApplyPlan | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [isApplying, setIsApplying] = useState(false);
	const [isCleaning, setIsCleaning] = useState(false);
	const [isApplyConfirmOpen, setIsApplyConfirmOpen] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);

	const loadPlan = useCallback(async () => {
		if (executionMode !== "isolated") {
			setPlan(null);
			return;
		}
		setIsLoading(true);
		try {
			const client = getRuntimeTrpcClient(workspaceId);
			const response = await client.workspace.getIsolatedApplyPlan.query({ taskId });
			if (response.ok && response.plan) {
				setPlan(response.plan);
				setLoadError(null);
			} else {
				setPlan(null);
				setLoadError(response.error ?? null);
			}
		} catch (error) {
			setPlan(null);
			setLoadError(error instanceof Error ? error.message : String(error));
		} finally {
			setIsLoading(false);
		}
	}, [executionMode, taskId, workspaceId]);

	useEffect(() => {
		void loadPlan();
	}, [loadPlan]);

	const handleApply = useCallback(async () => {
		setIsApplying(true);
		try {
			const client = getRuntimeTrpcClient(workspaceId);
			const response = await client.workspace.applyIsolatedWorkspace.mutate({ taskId, confirmed: true });
			if (response.applied.length > 0) {
				showAppToast({
					intent: response.partial ? "warning" : "success",
					message:
						response.applied.length === 1
							? "Applied 1 file to your project."
							: `Applied ${response.applied.length} files to your project.`,
				});
			}
			if (response.conflicts.length > 0) {
				// AC-08.7: surface conflicts loudly; nothing was overwritten.
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: `${response.conflicts.length} file(s) were skipped because your project changed since this task started.`,
					timeout: 10_000,
				});
			}
			if (!response.ok && response.error) {
				showAppToast({ intent: "danger", icon: "warning-sign", message: response.error, timeout: 7000 });
			}
			await loadPlan();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showAppToast({ intent: "danger", icon: "warning-sign", message, timeout: 7000 });
		} finally {
			setIsApplying(false);
			setIsApplyConfirmOpen(false);
		}
	}, [loadPlan, taskId, workspaceId]);

	const handleCleanup = useCallback(async () => {
		setIsCleaning(true);
		try {
			const client = getRuntimeTrpcClient(workspaceId);
			const response = await client.workspace.cleanupIsolatedWorkspace.mutate({ taskId });
			if (response.ok) {
				showAppToast({ intent: "success", message: "Isolated workspace removed." });
				await loadPlan();
				return;
			}
			if (response.refusedReason) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: response.refusedReason,
					timeout: 10_000,
				});
				return;
			}
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message: response.error ?? "Could not clean up the isolated workspace.",
				timeout: 7000,
			});
		} finally {
			setIsCleaning(false);
		}
	}, [loadPlan, taskId, workspaceId]);

	if (executionMode !== "isolated") {
		return null;
	}

	const applicableCount = plan?.applicable.length ?? 0;
	const conflictCount = plan?.conflicting.length ?? 0;

	return (
		<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 flex flex-col gap-3">
			<div className="flex items-center gap-2">
				<Layers size={14} className="text-text-secondary" />
				<h6 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0">
					Isolated workspace
				</h6>
				{isLoading ? <Spinner size={13} /> : null}
			</div>

			{workspacePath ? (
				<p className="font-mono text-[11px] text-text-tertiary m-0 break-all">
					{formatPathForDisplay(workspacePath)}
				</p>
			) : null}

			<p className="text-text-secondary text-[13px] m-0">
				This task ran in a separate copy of your project. Nothing has been written back to your project folder yet.
			</p>

			{loadError ? <p className="text-status-orange text-[12px] m-0">{loadError}</p> : null}

			{plan && !plan.empty ? (
				<div className="flex flex-col gap-1">
					{applicableCount > 0 ? (
						<p className="flex items-center gap-1.5 text-[12px] text-text-secondary m-0">
							<CheckCircle2 size={12} className="text-status-green" />
							{applicableCount} file{applicableCount === 1 ? "" : "s"} ready to apply
						</p>
					) : null}
					{conflictCount > 0 ? (
						<div className="flex flex-col gap-1">
							<p className="flex items-center gap-1.5 text-[12px] text-status-orange m-0">
								<AlertTriangle size={12} />
								{conflictCount} conflicting file{conflictCount === 1 ? "" : "s"} will be skipped
							</p>
							<ul className="m-0 pl-4 text-[11px] text-text-tertiary flex flex-col gap-0.5">
								{plan.conflicting.slice(0, 5).map((entry) => (
									<li key={entry.path} className="font-mono break-all">
										{entry.path}
									</li>
								))}
							</ul>
						</div>
					) : null}
				</div>
			) : null}

			{plan?.empty ? <p className="text-text-tertiary text-[12px] m-0">No changes to apply yet.</p> : null}

			<div className="flex items-center gap-2">
				<Button
					variant="primary"
					size="sm"
					icon={isApplying ? <Spinner size={13} /> : <Upload size={13} />}
					disabled={isApplying || isCleaning || applicableCount === 0}
					onClick={() => setIsApplyConfirmOpen(true)}
				>
					Apply to project
				</Button>
				<Button
					variant="ghost"
					size="sm"
					icon={isCleaning ? <Spinner size={13} /> : <Trash2 size={13} />}
					disabled={isApplying || isCleaning}
					onClick={() => void handleCleanup()}
				>
					Clean up
				</Button>
				<Button variant="ghost" size="sm" icon={<HardDrive size={13} />} onClick={() => void loadPlan()}>
					Refresh
				</Button>
			</div>

			<AlertDialog open={isApplyConfirmOpen} onOpenChange={setIsApplyConfirmOpen}>
				<AlertDialogHeader>
					<AlertDialogTitle>Apply changes to your project?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<p className="text-[13px] text-text-primary m-0">
						{applicableCount} file{applicableCount === 1 ? "" : "s"} will be written into your project folder.
						{conflictCount > 0
							? ` ${conflictCount} conflicting file${conflictCount === 1 ? "" : "s"} will be skipped so your own edits are preserved.`
							: ""}
					</p>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" size="sm">
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button variant="primary" size="sm" onClick={() => void handleApply()} disabled={isApplying}>
							{isApplying ? "Applying…" : "Apply changes"}
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}
