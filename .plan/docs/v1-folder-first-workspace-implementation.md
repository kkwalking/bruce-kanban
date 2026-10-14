# Folder-first Workspace and Multi-Agent Support — Implementation Record

Implements `specs/v1.md`. This document is the final deliverable required by §8:
gap analysis, milestone record, domain model, change list, compatibility notes,
verification results, known limitations, and reproducible local validation.

- Status: Milestones 1–4 implemented.
- Verification: 637 runtime tests, 498 web-UI tests, lint, both typechecks, and a
  production build all pass. Folder-first, isolation, apply, and conflict flows
  were additionally verified against a running server (see §7).

---

## 1. Requirement Gap Analysis

Findings from reading the actual code before changing anything. This is the
baseline the implementation had to move.

| # | Requirement | State before | Root cause in code |
| --- | --- | --- | --- |
| FR-01 | Any local directory as a project | **Missing** | `loadWorkspaceContext` called `resolveWorkspacePath`, which ran `git rev-parse --show-toplevel` and threw `No git repository detected`. Every project entry point funnelled through it. `projects-api.addProject` rejected non-Git folders with `requiresGitInitialization`, and `ensureInitialCommit` created an initial commit on *every* Git project add. |
| FR-02 | Workspace type detection | **Missing** | No notion of a workspace type existed. `RuntimeWorkspaceStateResponse` carried a single `git` field, and project summaries had no type. |
| FR-03 | Direct workspace execution | **Missing** | `resolveTaskCwd` always required a worktree, which required a Git repository and a base ref. `ensureTaskWorktreeIfDoesntExist` ran `git worktree add`, so a non-Git project could not start a task at all. |
| FR-04 | Isolated workspace execution | **Partial** | Git worktrees existed and worked well. There was no isolation for non-Git folders, multi-repository parents, or `google-repo` checkouts. |
| FR-05 | Task-level execution mode | **Missing** | The execution mode was implicit: "always a worktree". No task, project, or session field existed to choose otherwise. |
| FR-06 | Multi-agent backends | **Partial** | `RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS` was gated to `cline`, `claude`, `codex`, `droid`, `kiro`; `opencode` and `gemini` were commented out. Pi did not exist anywhere in the catalog. The agent catalog had no capability model. |
| FR-07 | Free permission configuration | **Missing** | `claudeAdapter` unconditionally set `--permission-mode auto` and `CLAUDE_CODE_ENABLE_AUTO_MODE=1` whenever autonomous mode was on, and autonomous mode defaulted to `true`. The user could not choose Default or Plan-only-without-auto. |
| FR-08 | Multi-repository / non-Git review | **Missing** | `getWorkspaceChanges` called `git rev-parse --show-toplevel` and threw for non-Git roots. There was no snapshot comparison, no multi-repository aggregation, and no apply/conflict path. |
| FR-09 | UI and data compatibility | At risk | Project creation, workspace validation, and review all assumed Git, so `git`-optional work had to avoid regressing them. |

Additional non-obvious findings that shaped the design:

- **`workspace-registry.resolveWorkspaceForStream` deleted projects that were not
  Git repositories.** This was the most damaging assumption: it silently pruned
  any non-Git project on the next state read, so folder-first support could not
  work without removing it.
- **`loadWorkspaceContext` replaced the project root with the containing Git
  root.** Selecting a subdirectory of a repository silently retargeted the
  project. The spec explicitly forbids this (FR-01.5), so the resolution was
  changed to canonicalize the *chosen* path only.
- **Git worktrees live under `~/.cline/worktrees/<task>/<label>`**, not under the
  project. Any review/apply logic that assumed "isolated path = a subdirectory of
  the isolated root" would read the wrong directory.
- **`runGit` trims stdout by default.** Using it to read a baseline file for
  conflict detection made every file look modified, because the trailing newline
  was stripped. Baseline reads now pass `trimStdout: false`.
- **`runtime-api.test.ts` mocks the worktree module**, so introducing real
  discovery inline would have made the tests hit the filesystem. The resolution
  logic was moved behind an injectable dependency instead.

---

## 2. Milestone Record

### Milestone 1 — Folder-first Project (P0) — Complete

- Project creation accepts any accessible directory. Git is never required, no
  `git init` runs implicitly, and no initial commit is forced
  (`src/trpc/projects-api.ts`).
- `resolveWorkspacePath` now canonicalizes the user-selected directory and never
  substitutes a containing Git root (`src/state/workspace-state.ts`).
- Git discovery became optional metadata: `detectGitRepositoryInfo` returns empty
  branch info instead of throwing.
- Stream-time project pruning no longer removes non-Git projects
  (`src/server/workspace-registry.ts`).
- Discovered type is persisted per workspace so project lists and Project
  Settings can show it without rescanning (`src/workspace/workspace-discovery.ts`).
- Project summaries carry `workspaceType`.

### Milestone 2 — Agent Flexibility (P0) — Complete

- Claude Code no longer forces Auto Mode. Permission modes are declared per
  backend in the agent catalog and resolved explicitly per launch.
- Pi backend added (catalog entry, capability declaration, adapter).
- OpenCode re-enabled for launch.
- Capabilities are declared per backend (`interactiveTui`, `hookEvents`,
  `sessionResume`, `permissionPrompts`, `modelSelection`, `nativeChat`) instead of
  being assumed uniformly.
- Task-level agent, model, and permission selection flows through
  `RuntimeTaskPermissionPolicy`.
- Permission requests surface as `awaitingPermission` rather than completion.

### Milestone 3 — Dual Workspace Modes (P1) — Complete

- Execution mode resolution precedence: explicit request → task card → project
  default → built-in default.
- Git repositories rooted at the project root keep the existing worktree flow
  exactly (`resolveTaskExecutionDirectory`).
- Non-Git and multi-repository projects get a structural directory copy that
  preserves relative paths (`src/workspace/isolated-workspace.ts`).
- Isolation skips secrets and credential-shaped paths, refuses to follow symlinks
  out of the workspace, and re-initializes Git metadata locally so it cannot
  reach back into source repositories.
- Cleanup refuses to delete a workspace with unapplied changes unless forced.
- Direct mode is protected by a single-writer guard per project.

### Milestone 4 — Multi-repository Review (P1) — Complete

- Per-repository change aggregation (`src/workspace/repository-changes.ts`).
- Snapshot comparison for non-Git projects (`src/workspace/snapshot-diff.ts`).
- Apply planning with three-way conflict detection
  (`src/workspace/isolated-apply.ts`).
- Apply requires explicit confirmation and never overwrites a conflicting file.
- Partial application is reported explicitly.

---

## 3. Core Domain Model

| Concept | Implementation | Responsibility |
| --- | --- | --- |
| Project | `RuntimeWorkspaceContext` + `~/.cline/kanban/workspaces/<id>/` | A user-selected directory. Not coupled to Git. |
| Repository | `WorkspaceDiscoveryResult["repositories"]` | Optional, discovered version-control resources under a project root. |
| Task | `RuntimeBoardCard` | Work item. Owns `agentId`, `model`, `executionMode`, `permissionPolicy`. |
| Workspace Instance | `RuntimeTaskWorkspaceInstance` | The filesystem environment for one task execution. |
| Agent Backend | `RuntimeAgentCatalogEntry` | Declares executable, capabilities, permission modes, model flag. |
| Agent Session | `RuntimeTaskSessionSummary` | One run. Records `executionMode` and `permissionModeId` for display and resume fidelity. |
| Change Set | `RuntimeWorkspaceRepositoryChanges` | Per-repository changes, Git or snapshot. |

Key modules and why they exist:

| Module | Role |
| --- | --- |
| `src/workspace/workspace-discovery.ts` | Detects `none` / `git` / `multi-git` / `google-repo`. Total: never throws. Caches per workspace, supports user override. |
| `src/workspace/task-execution-directory.ts` | The single place that decides Direct vs. Isolated and which isolation strategy to use. |
| `src/workspace/isolated-workspace.ts` | Creates, describes, reuses, and cleans isolated workspaces. |
| `src/workspace/snapshot-diff.ts` | Baseline capture and comparison for non-Git projects. |
| `src/workspace/isolated-apply.ts` | Apply planning and confirmed application with conflict detection. |
| `src/workspace/repository-changes.ts` | Fans a review request out across every repository. |
| `src/state/runtime-paths.ts` | Canonical on-disk paths, extracted so low-level modules avoid an import cycle with `workspace-state.ts`. |
| `src/core/agent-catalog.ts` | Single source of truth for agent capabilities, permission modes, and autonomy flags. |

---

## 4. Change List

### New files

**Runtime**

- `src/workspace/workspace-discovery.ts` — workspace type detection, Google `repo`
  manifest parsing, per-workspace cache and override.
- `src/workspace/isolated-workspace.ts` — isolation creation, reuse, safety
  verification, cleanup.
- `src/workspace/task-execution-directory.ts` — Direct/Isolated resolution.
- `src/workspace/snapshot-diff.ts` — non-Git baseline capture and diff.
- `src/workspace/isolated-apply.ts` — apply plan, conflict detection, confirmed apply.
- `src/workspace/repository-changes.ts` — multi-repository change aggregation.
- `src/state/runtime-paths.ts` — shared path helpers.

**Web UI**

- `web-ui/src/components/task-execution-mode-picker.tsx` — execution mode and
  permission selectors.
- `web-ui/src/components/workspace-detection-section.tsx` — Project Settings
  detection display, refresh, and override.
- `web-ui/src/components/isolated-workspace-panel.tsx` — review, apply, and
  cleanup for isolated tasks.
- `web-ui/src/test-fixtures/runtime-fixtures.ts` — shared test builders.

**Tests**

- `test/runtime/workspace/workspace-discovery.test.ts` (8)
- `test/runtime/workspace/isolated-workspace.test.ts` (9)
- `test/runtime/workspace/isolated-apply.test.ts` (8)
- `test/runtime/terminal/agent-catalog-permissions.test.ts` (10)
- `test/runtime/trpc/direct-workspace-guard.test.ts` (7)

### Modified areas

- **Contracts** (`src/core/api-contract.ts`): added `workspaceType`,
  `executionMode`, `permissionPolicy`, `model`, `RuntimeTaskPermissionPolicy`,
  discovery, isolated instance, apply, and repository-changes schemas; extended
  agent definitions with capabilities and permission modes; extended project
  summaries and workspace state.
- **Agent catalog** (`src/core/agent-catalog.ts`): rewritten around declarative
  capabilities and per-backend permission modes; Pi added; OpenCode enabled.
- **Claude adapter** (`src/terminal/agent-session-adapters.ts`): removed the
  forced `--permission-mode auto` and `CLAUDE_CODE_ENABLE_AUTO_MODE=1`. Permission
  application is centralized in one `applyPermissionPolicy` helper used by every
  adapter.
- **Session startup** (`src/trpc/runtime-api.ts`): execution-mode resolution,
  permission-policy resolution, Direct single-writer guard.
- **Workspace API** (`src/trpc/workspace-api.ts`): discovery, workspace instance,
  apply plan/apply, cleanup, multi-repository changes, and Git-free review
  fallback.
- **Project API** (`src/trpc/projects-api.ts`): Git is optional; `initializeGit`
  is now opt-in only.
- **Workspace registry** (`src/server/workspace-registry.ts`): tracks workspace
  type, no longer prunes non-Git projects.
- **Config** (`src/config/runtime-config.ts`): project-scoped
  `defaultExecutionMode` and `defaultPermissionModeId`, written only when they
  differ from built-ins.
- **Web UI**: execution mode and permission selection in create/edit dialogs,
  mode badge and permission-attention state on cards, Project Settings detection
  and defaults, add-project "Add Without Git" path, isolated workspace panel in
  the task detail view.

---

## 5. Data Migration and Compatibility

No manual migration is required.

- **Existing Git projects** load unchanged. Discovery classifies them as `git`
  and the worktree flow is preserved byte-for-byte: same path
  (`~/.cline/worktrees/<task>/<label>`), same base ref handling, same diff review,
  same commit/PR actions.
- **Existing board data** parses because all new card fields are optional. Cards
  without `executionMode` fall back to the project default, which for a Git
  project is `isolated` — the behavior those cards already had.
- **Existing session records** parse because `executionMode`,
  `permissionModeId`, and `awaitingPermission` are optional. Missing
  `awaitingPermission` reads as `false`.
- **Existing agent selection** still resolves. New catalog entries are additive,
  and `normalizeAgentId` continues to accept every previously valid id.
- **`requiresGitInitialization`** is retained in the response schema (marked
  deprecated) so an older client cannot crash on a missing field, but the runtime
  never sets it now.
- **New on-disk state** lives alongside existing state: a `discovery.json` per
  workspace, and a `snapshots/` directory for non-Git baselines. Removing either
  degrades gracefully — discovery re-runs, and a missing snapshot means an empty
  diff rather than an error.

Behavioral changes that are intentional and required by the spec:

1. Adding a non-Git folder no longer prompts for or performs `git init`.
2. Adding a Git repository no longer creates an initial commit if the repository
   is empty and unused. (Initial commits are still created by the opt-in
   `initializeGit` path.)
3. Claude Code no longer forces Auto Mode. Users who relied on it should select
   the `auto` permission mode explicitly, or enable autonomous mode.

---

## 6. Requirement Completion Status

| Requirement | Status | Notes |
| --- | --- | --- |
| FR-01 Any local directory as a Project | Complete | Verified end-to-end for plain folders, Git, multi-repo, and `google-repo`. |
| FR-02 Workspace type detection | Complete | Manifest-based for `google-repo`, bounded scan otherwise, override available. |
| FR-03 Direct execution | Complete | Includes single-writer guard. |
| FR-04 Isolated execution | Complete | Worktree for Git roots; verified copy for everything else. |
| FR-05 Task-level execution mode | Complete | Request → card → project → built-in precedence. |
| FR-06 Multi-agent backends | Complete | Claude, Codex, Pi, OpenCode, plus Cline. |
| FR-07 Permission configuration | Complete | Per-backend modes, explicit consent for risky modes. |
| FR-08 Review and change tracking | Complete | Multi-repo aggregation, snapshots, conflict-checked apply. |
| FR-09 UI compatibility | Complete | Existing flows preserved; new options integrated into existing dialogs. |

### Acceptance criteria notes

Criteria verified by automated tests or the live server run in §7 are not
repeated here. The following are implemented but rely on an external CLI being
present, so they are verified structurally rather than by driving a real agent:

- **AC-06.1–AC-06.6** (each agent starts, in Direct and Isolated modes): launch
  arguments, working directory, and permission flags are unit-tested per backend.
  Actually spawning each vendor CLI requires those binaries installed and
  authenticated.
- **AC-07.5** (user completes a permission approval): Kanban marks the task
  `Needs attention` and leaves the prompt to the agent's own TUI over the
  existing PTY session. The approval interaction itself happens inside the
  vendor CLI.

---

## 7. Verification

### Automated

```
npm run typecheck        # runtime: clean
npm run web:typecheck    # web UI: clean
npx @biomejs/biome check src test web-ui/src   # clean
npx vitest run           # 64 files, 637 tests passing
npm --prefix web-ui run test                   # 70 files, 498 tests passing
npm run build            # runtime + web bundle succeed
```

### Live end-to-end (running server)

Performed against a built `dist/cli.js` with an isolated `HOME`, exercising the
tRPC API directly.

| Scenario | Result |
| --- | --- |
| A — plain non-Git folder | Added as a project with `workspaceType: none`. No `.git` created. |
| B — `google-repo` root | Added with `workspaceType: google-repo`; manifest discovered at `.repo/manifests/default.xml`; two sub-repositories listed. No root `.git` created. |
| Multi-repo parent | Added as **one** project with `workspaceType: multi-git` and two repositories. |
| Git repository | Still reported as `workspaceType: git`. |
| Isolated workspace (non-Git) | Created at `~/.cline/kanban/isolated-workspaces/...`; relative structure preserved (`docs/` intact). |
| Isolation safety | Editing the isolated copy left the source file unchanged. |
| Apply gate | Unconfirmed apply refused with an explicit error; source untouched. |
| Apply | Confirmed apply wrote the modified file and the newly created file into the source. |
| Conflict protection | After a user edit to the source, the plan reported the file as conflicting and the second apply refused, leaving the user's content intact. |
| Git isolation routing | An isolated task in a Git project resolved to the legacy worktree path under `~/.cline/worktrees/`, confirming no regression. |

### Tests changed because requirements changed

These are deliberate, not workarounds:

- `test/integration/runtime-state-stream.integration.test.ts` — the test
  asserting a non-Git folder is *rejected* was replaced by four tests asserting
  it is *accepted* for each workspace type, plus one covering opt-in
  `initializeGit`.
- `test/runtime/terminal/agent-session-adapters.test.ts` — the assertion that
  autonomous mode injects `--permission-mode auto` was replaced by assertions
  that it does not, plus new coverage for explicit modes, unknown-mode rejection,
  and user extra args.
- `test/runtime/terminal/agent-registry.test.ts` — expected launch set updated
  for the Pi/OpenCode additions.
- `test/runtime/trpc/runtime-api.test.ts` and
  `test/runtime/trpc/workspace-api.test.ts` — added a discovery mock so the
  Git-routed cases stay hermetic.
- Web-UI test fixtures gained the new required contract fields.

---

## 8. Known Limitations

1. **Deep-repository discovery is bounded.** Discovery scans two levels and up to
   512 directory entries to keep project creation fast. A repository nested
   deeper is not auto-detected; users can raise expectations by narrowing the
   project root, or override the type in Project Settings. `google-repo`
   workspaces are unaffected because they use the manifest.

2. **Isolation copies, it does not deduplicate.** Non-Git isolation performs a
   real copy (skipping build output and secrets). Large workspaces therefore cost
   time and disk proportional to their size. The copy refuses to proceed past
   200,000 files with a clear error rather than hanging.

3. **Snapshot review has no history.** Non-Git change review compares against a
   baseline captured at isolation time. There is no per-turn history for a
   non-Git project, so `last_turn` mode reports nothing there. Git projects keep
   full per-turn checkpoints.

4. **Cross-repository commit is not atomic.** Commit and PR actions remain
   scoped to a single repository (the existing behavior). A task that spans
   several repositories cannot be committed in one atomic operation; the
   implementer must repeat the action per repository.

5. **Direct mode is single-writer per project.** This is intentional
   (NFR-02) but means two Direct tasks cannot run concurrently in one project.
   Isolated mode is the parallel option.

6. **`git apply`-style patching is not used for non-Git apply.** Non-Git apply
   writes whole files from the isolated copy. A three-way merge is not performed;
   conflicting files are reported and skipped instead.

7. **Agent capability coverage varies.** Pi has no structured hook-event
   integration, so its task state relies on process lifecycle and terminal
   output rather than hooks. This is declared in the catalog rather than faked.

8. **Google `repo` is supported as a directory layout, not via the `repo`
   binary.** Kanban reads the manifest and the working tree directly. It does not
   shell out to `repo sync`, manage manifests, or track upstream revisions.

---

## 9. Reproducible Local Validation

### Prerequisites

```bash
npm run install:all
npm run build
```

### Automated suite

```bash
npm run typecheck && npm run web:typecheck
npx @biomejs/biome check src test web-ui/src
npx vitest run && npm --prefix web-ui run test
```

### Scenario A — plain non-Git folder

```bash
mkdir -p /tmp/kb-plain/docs && echo "print('hi')" > /tmp/kb-plain/main.py
cd /tmp/kb-plain && node /path/to/kanban/dist/cli.js --port 3484
```

Expect: the folder is added without a Git prompt, no `.git` appears, and Project
Settings → Workspace detection reports "Plain folder".

### Scenario B — Google `repo` multi-repository root

```bash
mkdir -p /tmp/kb-android/.repo/manifests /tmp/kb-android/frameworks/base
cat > /tmp/kb-android/.repo/manifests/default.xml <<'XML'
<manifest>
  <project path="frameworks/base" name="platform/frameworks/base" />
</manifest>
XML
(cd /tmp/kb-android/frameworks/base && git init -q)
```

Add `/tmp/kb-android` as a project. Expect `google-repo` detection with the
manifest path and `frameworks/base` listed, and no root `.git`.

### Scenario C — Pi in a non-Git project

With `pi` on `PATH`, create a task in the plain-folder project, choose Pi, and
start it. Expect the Pi TUI in the terminal panel and a live session summary.

### Scenario D — Claude permission approval

Create a task, select Claude Code, and leave Permissions at "CLI default". Start
it and let the agent request a write. Expect the card to show
"Needs attention: permission requested" rather than a completed state, and no
`--permission-mode auto` in the launch command. Approve in the terminal to
continue.

### Scenario E — Isolated tasks

Set the project default to Isolated, create two tasks, and start both. Expect
two independent working directories, no interference, and an unchanged source
project.

### Scenario F — Cross-repository review

Run an Isolated task that touches two sub-repositories plus a plain folder. Open
the task detail view. Expect changes grouped per repository, and the isolated
workspace panel offering Apply. Confirm that nothing is written until Apply is
confirmed, and that a conflicting file is reported instead of overwritten.

### Scenario G — Git regression

Add a normal Git repository, start a task, review the diff, and commit. Expect the
same worktree path (`~/.cline/worktrees/<task>/<label>`), the same diff review,
and a successful commit.

---

## 10. Design Decisions Worth Knowing

These are the choices most likely to surprise a future reader.

1. **Git repositories keep the worktree flow; everything else gets a copy.**
   Rather than reimplementing isolation uniformly, Git-rooted projects route to
   the existing, well-tested worktree machinery
   (`resolveTaskExecutionDirectory`). This is what makes AC-04.1 (no Git
   regression) structural rather than aspirational.

2. **Discovery never throws.** A failed detection produces `none` plus a warning.
   The spec is explicit that discovery failure must not block project creation or
   task execution.

3. **Isolated Git metadata is re-initialized, never copied.** Copying `.git`
   would leave absolute paths pointing at source repositories, so Git commands in
   the isolated workspace could mutate the source index or branches. The isolated
   repository shares the source *object* database (read-only) and nothing else.

4. **Autonomy and permissions are separate axes.** `autonomousArgs` is empty for
   Claude Code specifically so that enabling autonomy cannot silently raise
   permissions. Claude's autonomy is expressible only by choosing a permission
   mode.

5. **Unknown permission mode ids are dropped, not forwarded.** A stale or
   hand-edited config cannot become an arbitrary CLI argument.

6. **Apply is a three-way comparison, not an mtime guess.** Conflict detection
   compares the source file against the repository baseline (or the captured
   snapshot) that the isolated workspace started from. This is why a user edit is
   reliably distinguished from agent output.

7. **`runtime-paths.ts` exists to break an import cycle.** Discovery needs
   workspace paths, and `workspace-state.ts` needs discovery, so the paths moved
   into their own module.
