# SFX-Toolkit — Backlog (audited)

Filtered from the original improvement roadmap against the current codebase
(v0.14.0). Items already shipped have been removed. Each entry is either **NOT
IMPLEMENTED** or **PARTIAL** (some of it exists — only the missing part is
listed). Evidence file paths point at where the work lands.

> Dropped as already implemented: cancellation support (`commandRunner.ts`),
> confirmation dialogs for destructive ops, enhanced org tree icons/badges
> (`OrgTreeProvider.ts`), org metadata cache init (`orgMetadataCache.ts`),
> real-time log streaming (`liveLogService.ts`), SOQL field-type awareness &
> relationship navigation (`SOQLEditorProvider.ts`), deploy panel state
> persistence, webview state retention, org insights dashboard
> (`orgHealth.ts`), copy org username/password with toast (`orgCommands.ts`),
> SOQL history (50 items + clear button), CSV/JSON result export.

---

## Quick Wins

### Visual & Polish
- [ ] **Unified theme system** — NOT IMPLEMENTED. No `src/styles/`; every webview
  inlines its own `<style>` block. Extract shared button/spacing/typography CSS
  (variables `--asfx-radius`/`--vscode-*` are reused but there's no base sheet).
  Files: all `src/providers/*` + `src/editors/*` webviews. ~2-3h
- [ ] **Replace text/emoji icons with VSCode Codicons** — PARTIAL. Only one
  `$(play)` (`ApexCodeLensProvider.ts`); webviews use ▶ ▼ ✨ 🔍 emoji. Swap to
  `$(chevron-*)`, `$(loading~spin)`, `$(check)`, `$(error)`. ~1-2h
- [ ] **Loading skeletons / shimmer** — PARTIAL. Hover/focus transitions and a
  spinner exist (`SOQLEditorProvider.ts`), but no skeleton/shimmer loading state
  for tables and lists. ~1-2h
- [ ] **Empty-state messaging with icons + CTAs** — PARTIAL. Bare "No X found"
  text exists; add consistent template with icon and actionable CTA
  (e.g. "No logs found. Adjust filter or pull from org"). ~1h

### Help & Documentation
- [ ] **Inline help tooltips / help icons** — PARTIAL. `title=` attributes exist;
  add dedicated help icons for SOQL WHERE/ORDER BY/LIMIT, deploy test levels,
  trace log levels. ~2-3h
- [ ] **Consistent keyboard-shortcut display on buttons** — PARTIAL. SOQL editor
  shows `<kbd>` hints; most buttons don't. Standardize across panels. ~1h
- [ ] **Actionable error messages** — PARTIAL. Errors are truncated CLI output
  (`.substring(0,500)`). Extract actionable cause, add "Learn more" links and
  suggested fixes. Files: `deployDiagnostics.ts`, panel providers. ~2-3h

### Quick Functional Wins
- [ ] **Copy-to-clipboard for SOQL results & error messages** — PARTIAL. Org
  username/password copy exists; add copy buttons on result rows/cells and error
  blocks. ~1h
- [ ] **Log filter persistence** — NOT IMPLEMENTED. DEBUG/SOQL filters toggle
  in-memory only (`LogContentProvider.ts`); persist to workspaceState and
  restore. ~1h
- [ ] **Search within SOQL history** — PARTIAL. History (50) + clear exist
  (`SOQLEditorProvider.ts`); add a search/filter box in the history dropdown. ~1h

---

## Phase 1: UX

### Progress & Feedback
- [ ] **Enhanced progress reporting** — PARTIAL. `withProgress()` shows status
  text; add file count, current file name, and ETA for deploy and source
  push/pull. Files: `deployMetadata.ts` (`createDeployProgressHandler`),
  `DeployMetadataPanelProvider.ts`. ~3-4h

---

## Phase 2: Feature Enhancements

### Advanced Log Filtering
- [ ] **Timestamp range filtering** — NOT IMPLEMENTED. last hour/24h/7d/custom,
  date picker, saved presets. Files: `filterLogs.ts`, `LogContentProvider.ts`. ~3-4h
- [ ] **Execution-time filtering** — NOT IMPLEMENTED. Surface queries/DML over
  X ms to spot perf issues. `apexLogParse.ts`, `LogContentProvider.ts`. ~2h
- [ ] **Case-insensitive & regex search in log viewer** — NOT IMPLEMENTED. Search
  box, regex with validation, next/prev nav (Ctrl+G). ~2-3h
- [ ] **Log tagging system** — NOT IMPLEMENTED. Tag logs, filter by tag, persist
  to disk. ~3-4h

### SOQL Builder
- [ ] **Sample data display** — NOT IMPLEMENTED. Show 3-5 sample values per field,
  refresh on demand. `soqlSchemaProvider.ts`, `SOQLEditorProvider.ts`. ~2-3h
- [ ] **XLSX export + copy-for-Excel** — PARTIAL. CSV/JSON export done; add XLSX
  and tab-formatted clipboard copy. `SOQLEditorProvider.ts`. ~2h

### Deploy
- [ ] **Pre-deploy validation summary** — PARTIAL. Post-deploy diagnostics exist
  (`deployDiagnostics.ts`); add pre-deploy file list, size/time estimate,
  dependency check. ~2-3h
- [ ] **Deploy history improvements** — PARTIAL. History stores 50 entries with
  redeploy (`deployHistory.ts`); add pin/favorite, version compare (what
  changed), and search. ~3-4h
- [ ] **Incremental deploy** — NOT IMPLEMENTED. Deploy only files modified since
  last deploy; exclude patterns / whitelist-blacklist. `deployMetadata.ts`. ~2-3h

### Test Runner
- [ ] **Code coverage display (inline + alerts)** — PARTIAL. Coverage % shown in
  deploy result panel; add inline editor coverage gutters and target alerts.
  `ApexTestController.ts`, `DeployMetadataPanelProvider.ts`. ~2-3h
- [ ] **Test result history** — NOT IMPLEMENTED. Cache results, compare this run
  vs last, trend viz. `ApexTestController.ts`. ~3-4h
- [ ] **Run-only-failed / filter by status** — PARTIAL. Name search exists; add
  status filter (passed/failed/skipped) and a re-run-failed action. ~2h

---

## Phase 3: Advanced

- [ ] **Side-by-side log viewer / diff / merge** — NOT IMPLEMENTED. Split-view log
  diff with highlights, optional concat. ~4-5h
- [ ] **Apex snippet management** — PARTIAL. Flat `.apex` files only
  (`apexSnippets.ts`). Add folders/categories, reorder, editable
  descriptions/tags, JSON export/import, team sharing. ~6-8h total
- [ ] **Edit existing trace flags** — PARTIAL. `editTrace` is a placeholder
  (`TraceTreeProvider.ts`). Implement update user/duration/level + batch ops. ~2-3h
- [ ] **Trace presets** — NOT IMPLEMENTED. Save trace configurations, one-click
  apply. `traceCommands.ts`, `addDebugTrace.ts`. ~1-2h
- [ ] **Org comparison between two orgs** — PARTIAL. `metadataDiff.ts` does org-vs-
  local only; add org-to-org metadata/package/config diff. ~4-5h
- [ ] **Multi-org operations** — NOT IMPLEMENTED. Deploy to multiple orgs, run
  tests across orgs, execute anonymous on all. ~4-6h
- [ ] **Permission Set editor: diff viewer + import/clone** — PARTIAL. XML editor
  UI only (`PermissionSetEditorProvider.ts`). Add diff-from-previous and
  import/clone-as-template. ~3-5h
- [ ] **Scratch Org feature dependency resolver** — PARTIAL. Feature picker exists
  (`ScratchOrgDefEditorProvider.ts`); warn on conflicting features and show
  prerequisites. ~2-3h

---

## Accessibility & Testing
- [ ] **WCAG 2.1 AA compliance** — keyboard nav in all webviews, ARIA labels,
  focus management, contrast verification. ~5-7h
- [ ] **Cross-theme testing** — light/dark/high-contrast pass across webviews. ~2-3h
- [ ] **Keyboard shortcut audit** — document all shortcuts, check VSCode conflicts,
  add customization. ~2h

---

*Audited against codebase v0.14.0 on 2026-06-25. Effort estimates carried over
from the source roadmap.*
