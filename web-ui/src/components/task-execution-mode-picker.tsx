import { HardDrive, Layers, ShieldAlert, ShieldCheck } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "@/components/ui/cn";
import { NativeSelect } from "@/components/ui/native-select";
import { Tooltip } from "@/components/ui/tooltip";
import type {
	RuntimeAgentDefinition,
	RuntimeTaskExecutionMode,
	RuntimeTaskPermissionPolicy,
	RuntimeWorkspaceType,
} from "@/runtime/types";

export interface ExecutionModeSelectorProps {
	value: RuntimeTaskExecutionMode;
	onChange: (value: RuntimeTaskExecutionMode) => void;
	/** Workspace type of the current project, used to explain mode availability. */
	workspaceType: RuntimeWorkspaceType | null;
	disabled?: boolean;
	/** Renders a compact inline variant instead of the full labelled control. */
	variant?: "inline" | "full";
}

function getExecutionModeLabel(mode: RuntimeTaskExecutionMode): string {
	return mode === "direct" ? "Direct" : "Isolated";
}

function getExecutionModeDescription(
	mode: RuntimeTaskExecutionMode,
	workspaceType: RuntimeWorkspaceType | null,
): string {
	if (mode === "direct") {
		return "The agent works directly in your project folder. Changes are live as they happen.";
	}
	if (workspaceType === "git") {
		return "The agent works in a separate Git worktree. Your project folder stays untouched until you apply the changes.";
	}
	return "The agent works in a copy of your project folder. Your original files stay untouched until you apply the changes.";
}

function getExecutionModeUnavailableReason(
	mode: RuntimeTaskExecutionMode,
	workspaceType: RuntimeWorkspaceType | null,
): string | null {
	if (mode === "direct" && workspaceType === "git") {
		return null;
	}
	return null;
}

/**
 * Direct vs. Isolated execution selector (FR-05).
 *
 * The choice is always explicit and never silently converted: if a mode cannot
 * be used, the reason is shown rather than silently switching the task.
 */
export function ExecutionModeSelector({
	value,
	onChange,
	workspaceType,
	disabled = false,
	variant = "full",
}: ExecutionModeSelectorProps): ReactElement {
	const unavailableReason = getExecutionModeUnavailableReason(value, workspaceType);
	const description = getExecutionModeDescription(value, workspaceType);
	const Icon = value === "direct" ? HardDrive : Layers;

	if (variant === "inline") {
		return (
			<Tooltip content={description}>
				<span className="inline-flex items-center gap-1 text-[11px] text-text-secondary">
					<Icon size={11} />
					{getExecutionModeLabel(value)}
				</span>
			</Tooltip>
		);
	}

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-2">
				<Icon size={14} className="text-text-secondary" />
				<span className="text-[12px] text-text-primary">Workspace</span>
				<NativeSelect
					size="sm"
					value={value}
					disabled={disabled}
					onChange={(event) => onChange(event.currentTarget.value as RuntimeTaskExecutionMode)}
					className="ml-auto"
					aria-label="Task workspace execution mode"
				>
					<option value="isolated">Isolated</option>
					<option value="direct">Direct</option>
				</NativeSelect>
			</div>
			<p className="text-[11px] text-text-tertiary m-0">{description}</p>
			{unavailableReason ? <p className="text-[11px] text-status-orange m-0">{unavailableReason}</p> : null}
		</div>
	);
}

export interface PermissionModeSelectorProps {
	/** Declared permission modes for the selected agent backend. */
	permissionModes: RuntimeAgentDefinition["permissionModes"];
	/** Currently selected mode id, or null to use the CLI default. */
	value: string | null;
	onChange: (value: string | null) => void;
	/** Autonomous/auto-approve toggle, independent from permission mode. */
	autonomousModeEnabled: boolean;
	onAutonomousModeChange: (value: boolean) => void;
	disabled?: boolean;
}

/**
 * Permission selection for a task (FR-07).
 *
 * Each agent backend declares its own permission vocabulary, so this renders
 * whatever modes the backend supports rather than a hardcoded union. Risky modes
 * are labelled so the user opts in knowingly, and Kanban never enables one on
 * the user's behalf.
 */
export function PermissionModeSelector({
	permissionModes,
	value,
	onChange,
	autonomousModeEnabled,
	onAutonomousModeChange,
	disabled = false,
}: PermissionModeSelectorProps): ReactElement {
	const selectedMode = permissionModes.find((mode) => mode.id === value) ?? null;
	const riskySelected = selectedMode?.risky === true;

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-2">
				{riskySelected ? (
					<ShieldAlert size={14} className="text-status-orange" />
				) : (
					<ShieldCheck size={14} className="text-text-secondary" />
				)}
				<span className="text-[12px] text-text-primary">Permissions</span>
				<NativeSelect
					size="sm"
					value={value ?? ""}
					disabled={disabled || permissionModes.length === 0}
					onChange={(event) => onChange(event.currentTarget.value || null)}
					className="ml-auto"
					aria-label="Agent permission mode"
				>
					<option value="">CLI default</option>
					{permissionModes.map((mode) => (
						<option key={mode.id} value={mode.id}>
							{mode.label}
						</option>
					))}
				</NativeSelect>
			</div>
			{selectedMode?.description ? (
				<p className={cn("text-[11px] m-0", riskySelected ? "text-status-orange" : "text-text-tertiary")}>
					{selectedMode.description}
				</p>
			) : (
				<p className="text-[11px] text-text-tertiary m-0">Use the agent CLI's own default permission behavior.</p>
			)}
			<label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer select-none mt-0.5">
				<input
					type="checkbox"
					checked={autonomousModeEnabled}
					disabled={disabled}
					onChange={(event) => onAutonomousModeChange(event.currentTarget.checked)}
					className="accent-[var(--color-accent)]"
				/>
				<span>Run autonomously (auto-approve actions)</span>
			</label>
		</div>
	);
}

/** Build the persisted policy object, omitting unset fields. */
export function buildPermissionPolicy(input: {
	modeId: string | null;
	autonomousModeEnabled: boolean;
}): RuntimeTaskPermissionPolicy | undefined {
	const policy: RuntimeTaskPermissionPolicy = {};
	if (input.modeId) {
		policy.mode = input.modeId;
	}
	policy.autonomousModeEnabled = input.autonomousModeEnabled;
	return Object.keys(policy).length > 0 ? policy : undefined;
}
