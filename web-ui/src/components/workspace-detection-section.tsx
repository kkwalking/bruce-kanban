import { AlertTriangle, FolderTree, RefreshCw } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeWorkspaceDiscovery, RuntimeWorkspaceType } from "@/runtime/types";
import { formatPathForDisplay } from "@/utils/path-display";

const WORKSPACE_TYPE_LABELS: Record<RuntimeWorkspaceType, string> = {
	none: "Plain folder",
	git: "Git repository",
	"multi-git": "Multiple Git repositories",
	"google-repo": "Google repo workspace",
};

export interface WorkspaceDetectionSectionProps {
	workspaceId: string | null;
	/** Bumped whenever the workspace changes so the section refetches. */
	refreshKey?: number;
}

/**
 * Project Settings: workspace detection (FR-02 / AC-02.3 / AC-02.7).
 *
 * Shows what Kanban detected for the project root and lets the user refresh,
 * override, or disable Git integration when detection is wrong. Detection is
 * informational only: it never gates whether a project is usable.
 */
export function WorkspaceDetectionSection({
	workspaceId,
	refreshKey = 0,
}: WorkspaceDetectionSectionProps): ReactElement | null {
	const [discovery, setDiscovery] = useState<RuntimeWorkspaceDiscovery | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [isRefreshing, setIsRefreshing] = useState(false);

	const load = useCallback(async () => {
		if (!workspaceId) {
			setDiscovery(null);
			return;
		}
		setIsLoading(true);
		try {
			const client = getRuntimeTrpcClient(workspaceId);
			setDiscovery(await client.workspace.getWorkspaceDiscovery.query());
		} catch {
			setDiscovery(null);
		} finally {
			setIsLoading(false);
		}
	}, [workspaceId]);

	useEffect(() => {
		void load();
	}, [load, refreshKey]);

	const handleRefresh = useCallback(
		async (options: { type?: RuntimeWorkspaceType; disableGit?: boolean; resetOverride?: boolean }) => {
			if (!workspaceId) {
				return;
			}
			setIsRefreshing(true);
			try {
				const client = getRuntimeTrpcClient(workspaceId);
				const next = await client.workspace.refreshWorkspaceDiscovery.mutate({
					...(options.type ? { workspaceType: options.type } : {}),
					...(options.disableGit !== undefined ? { gitIntegrationEnabled: !options.disableGit } : {}),
					...(options.resetOverride ? { resetOverride: true } : {}),
				});
				setDiscovery(next);
				showAppToast({ intent: "success", message: "Workspace detection updated." });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				showAppToast({ intent: "danger", icon: "warning-sign", message, timeout: 7000 });
			} finally {
				setIsRefreshing(false);
			}
		},
		[workspaceId],
	);

	if (!workspaceId) {
		return null;
	}

	return (
		<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
			<div className="flex items-center justify-between mb-2">
				<h6 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0">
					<FolderTree size={12} />
					Workspace detection
				</h6>
				<Button
					variant="ghost"
					size="sm"
					icon={isRefreshing ? <Spinner size={14} /> : <RefreshCw size={14} />}
					onClick={() => void handleRefresh({ resetOverride: true })}
					disabled={isRefreshing}
				>
					Refresh
				</Button>
			</div>

			<p className="text-text-secondary text-[13px] mt-0 mb-3">
				Kanban detects whether this folder is a Git repository, a parent of several repositories, or a Google{" "}
				<span className="font-mono">repo</span> workspace. Detection only enables extra features — it never blocks
				project creation or task execution.
			</p>

			{isLoading && !discovery ? (
				<div className="flex items-center gap-2 text-text-secondary text-[13px]">
					<Spinner size={14} />
					Detecting…
				</div>
			) : null}

			{discovery ? (
				<div className="flex flex-col gap-3">
					<div className="flex items-center gap-2">
						<span className="text-[13px] text-text-secondary">Type</span>
						<NativeSelect
							size="sm"
							className="ml-auto"
							value={discovery.workspaceType}
							onChange={(event) =>
								void handleRefresh({ type: event.currentTarget.value as RuntimeWorkspaceType })
							}
							disabled={isRefreshing}
							aria-label="Detected workspace type"
						>
							{(Object.keys(WORKSPACE_TYPE_LABELS) as RuntimeWorkspaceType[]).map((type) => (
								<option key={type} value={type}>
									{WORKSPACE_TYPE_LABELS[type]}
								</option>
							))}
						</NativeSelect>
					</div>

					<div className="flex items-center gap-2">
						<span className="text-[13px] text-text-secondary">Git integration</span>
						<label className="ml-auto flex items-center gap-2 text-[13px] text-text-primary cursor-pointer select-none">
							<input
								type="checkbox"
								checked={discovery.gitIntegrationEnabled !== false}
								disabled={isRefreshing}
								onChange={(event) => void handleRefresh({ disableGit: !event.currentTarget.checked })}
								className="accent-[var(--color-accent)]"
							/>
							<span>Enabled</span>
						</label>
					</div>

					{discovery.repositories.length > 0 ? (
						<div>
							<p className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary mt-0 mb-1">
								Repositories ({discovery.repositories.length})
							</p>
							<ul className="m-0 pl-4 text-[13px] text-text-secondary flex flex-col gap-0.5">
								{discovery.repositories.map((repository) => (
									<li key={repository.relativePath || repository.workTreePath} className="font-mono break-all">
										{repository.relativePath || "."}
									</li>
								))}
							</ul>
						</div>
					) : null}

					{discovery.repoManifestPath ? (
						<p className="text-text-tertiary text-[12px] m-0 break-all">
							Manifest: {formatPathForDisplay(discovery.repoManifestPath)}
						</p>
					) : null}

					{discovery.warning ? (
						<div className="flex items-start gap-2 rounded-md border border-status-orange/30 bg-status-orange/10 px-3 py-2">
							<AlertTriangle size={14} className="text-status-orange shrink-0 mt-0.5" />
							<p className="text-[12px] text-status-orange m-0">{discovery.warning}</p>
						</div>
					) : null}

					{discovery.overridden ? (
						<p className="text-text-tertiary text-[12px] m-0">
							You overrode the detected type. Use Refresh to re-detect from disk.
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}
