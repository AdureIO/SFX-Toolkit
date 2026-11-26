# Deploy & Retrieve Metadata

Status: design 2026-11-23, updated 2026-11-26 (the Deploy Metadata panel is replaced; this panel was called the Deploy & Retrieve Center before). Internal identifiers keep the `SyncCenter*` names.

## Decisions (user)

- **Replaces the Deploy Metadata panel.** The Org Browser stays as it is, with a button "Open in Deploy & Retrieve Metadata".
  - The command id `adure-sfx-toolkit.deployMetadata` stays registered as a hidden alias (user keybindings) and opens this panel; opened from an Explorer or editor context menu with files or folders it selects their components and adjusts the filter so they show.
  - The Development view button and tree item open this panel.
- **Direction: smart sync plus manual.**
  - There is one selection with two buttons, `Retrieve (n)` and `Deploy (n)`.
  - The filters and the header checkbox ("select all shown rows") preselect the obvious work. There are no quick actions.
  - Conflicts never block. A selected conflict row takes part by default; the run asks for confirmation. A per-row choice is an optional override.
- **v1 extras:**
  - a diff per row;
  - delete from the org;
  - history;
  - presets shared with the Deploy panel.
- **Right-hand options follow the chosen action:**
  - a segmented control **Deploy | Retrieve | Delete** under the operation card (default Deploy, remembered in the UI state);
  - a Presets section (always visible; the org is chosen in the top bar only);
  - only the chosen action's section (Deploy, Retrieve or Delete with danger styling); the others are hidden, not collapsed;
  - the grid follows: rows that cannot take part in the action (Deploy needs local files, Retrieve needs the org copy, Delete takes only-org rows) are dimmed and cannot be ticked; select-all and the counts use the participating rows.

## Rows

The rows are the union of the local index (`scanProject`) and the org listing, keyed by `compKey(type, name)`. Local names are percent-decoded the same way `orgLookupKey` does it.

Statuses come from `compareStatusPure.ts` plus the content compare service, the same engine the other two panels use:

| Status | Meaning | Label |
|---|---|---|
| `only-local` | local, not in the org listing | Only local |
| `only-org` | in the org, not local | Only in org |
| `partial` | object partly local (the Org Browser meaning) | Partly local |
| `equal` | verified or provisional equal | Equal |
| `changed-locally` | | Changed locally |
| `changed-in-org` | | Changed in org (latest) |
| `conflict` | both changed | Conflict |
| `unknown` | the org listing of the type is missing, or local info isn't read yet | Not compared / unknown |

- Provisional statuses render dashed, as in the other panels.
- Query aliases: `status:local` and `status:new` mean only-local; `status:org` and `status:not-local` mean only-org; plus the aliases of the other panels.
- **In project** is a status filter option, selected by default: every row that exists locally, i.e. everything except `only-org`. It combines with the other status options like the group does (OR). Query aliases: `status:project`, `status:in-project`. "Clear all filters" clears it too. A saved layout from before the default existed gets it once.

## Layout

- **Top bar:**
  - project selector (multi-project);
  - org select;
  - search (`filterSearchMarkup`);
  - "Listed …" info;
  - Refresh;
  - **Compare contents (n)**, a primary button: compares the selected components, else the project components shown. Contents are never compared automatically (`compare.verifyContents` defaults to `manual`; `auto` still works). The progress text and a Cancel button show while it runs.
- **Left:** the filter sidebar (`filterGroupsMarkup`): status, type, namespace, modified. It is identical to the Org Browser, including collapse and auto-hide below 560 px.
- **Center:** the Org Browser-style virtual grid.
  - Columns: a checkbox (header: select all shown rows), then the columns of the column layout (below).
  - "Group by type" toggle, as in the Org Browser. The rows under a group header are indented (name cell).
  - Group header: a refresh icon (re-list this type) with the theme's icon colour and a hover background.
  - Actions cell (always visible, never hover-only), icon buttons with tooltips:
    - **Deploy**, for rows that exist locally (and partly local objects);
    - **Retrieve**, for rows that exist in the org;
    - **Diff**, on `changed-*`, `conflict` and `equal` rows;
    - on `conflict` rows, a two-state choice chip "Keep local" / "Take org", unset by default. The Deploy and Retrieve icons of a conflict row do not need the chip: the host asks first in a modal ("Conflict: overwrite the org's version with your local version?" / "… your local version with the org's version?").
    - A per-row Deploy or Retrieve runs the same host path as the main buttons (safety checks, history, re-compare) for that one component with the current Deploy or Retrieve section options. It ignores the selection and "Skip equal".
  - **Column layout.** Columns are shown or hidden in a column menu (the "Columns" button, or a right-click on a header), reordered by dragging the headers, and resized by the grip. "Reset columns" restores the defaults.
    - Columns: Name (always shown, always first), Type, Namespace, Last modified by, Last modified, Status, Created date, Id, File name (the org's file name), Local path, Manageable state, Actions. Default: the first six plus Actions.
    - Not offered: *Created by* (the org listing only carries the creation date).
    - Stored per computer by the host in `globalState`, key `syncCenter.columns` (order, visibility, widths). The webview gets it with `init` and posts changes debounced (300 ms). Everything read is sanitised (`syncCenterColumnsPure.normalizeLayout`): unknown or duplicate columns are dropped, missing ones appended, widths clamped.
  - **Loading.** While the host loads, lists or scans, or a compare runs, a thin indeterminate progress bar shows under the top bar (filled when the listing reports progress), next to the progress text. The first load shows a "Loading…" card instead of an empty grid.
- **Right:** four sections.
  1. **Presets**
     - The preset select and "Save preset", as in the Deploy panel (shared store).
  2. **Deploy**
     - Test level and specified tests, Validate only, and Auto-select git changes, all as in the Deploy panel.
     - "Deploy name" (optional text): a local label, as Salesforce has none. It travels with the deploy request (`label`), is stored in the history entry and shown in Local history.
     - "Skip equal components" (default on).
     - Button `Deploy (n)`.
  3. **Retrieve**
     - "Confirm before overwriting local changes" (default on; uses the existing retrieve-safety check).
     - "Retrieve the whole object when a child is selected" (default off).
     - "Skip equal components" (default on).
     - Button `Retrieve (n)`.
  4. **Delete from org** (collapsed, danger styling)
     - Its own test level (No Test Run / Run Specified Tests / Run Local Tests / Run All Tests) and, for specified tests, the test-class tree and suites (the shared component, a second instance).
     - Production cannot use No Test Run (an org that could not be verified counts as production): the delete is refused. On a non-production org, deleting Apex classes or triggers with No Test Run is allowed and shows a hint.
     - Button `Delete from org (n)`. It counts only selected `only-org` rows.
  - Footer tabs: **Deployment history** | status line. Segments: **Deploys** (default; the org's recent deploys merged with local history) and **Local history** (local deploys, validations, retrieves, deletes; tooltip: "Deploys, validations, retrieves and deletes run by this extension on this machine").
    - The merged deploy list per org is stored in the shared disk cache (`org-browser/deploys/list-<org>.json.gz`), sent to the webview when the org loads, refreshed in the background after the first render, when an operation ends, and when the tab opens with data older than 60 s. The tab shows "updated … ago" and a spinner while it refreshes; it never shows an empty state when cached data exists.
    - Details of a finished deploy are cached per deploy id (`deploys/details/<id>.json.gz`); in-progress deploys are not cached.

## Button counts and rules

- `Deploy (n)` counts every selected row that exists locally (`only-local`, `changed-locally`, `changed-in-org`, `conflict`, `partial`, `equal` when not skipped). A conflict set to "Take org" is excluded.
- `Retrieve (n)` counts every selected row that exists in the org (`only-org`, `changed-in-org`, `changed-locally`, `conflict`, `partial`, `equal` when not skipped). A conflict set to "Keep local" is excluded.
- Rows whose run overwrites the other side (Deploy: `changed-in-org` and conflicts without a choice; Retrieve: `changed-locally` and conflicts without a choice) take part and are flagged. The buttons are never disabled because of them. A neutral warning line shows near the buttons: "n selected components have a newer version in the org — deploying overwrites them." (Retrieve: "…have local changes — retrieving overwrites your local files."), with a "Show conflicts" link that filters the list to the affected rows.
- Confirmation at run time (host modal): a deploy with flagged rows asks "Overwrite org" / Cancel, listing up to 10 names and "+n more". Validate only (check-only) does not ask. A retrieve with flagged rows asks "Overwrite local" / Cancel, unless "Confirm before overwriting local changes" is on (its own overwrite check already lists the files). A row's own Deploy and Retrieve icons use the same modal.
- Selection summary: a text link directly below the action button of the active section, "2 selected · 0 to deploy · 2 skipped". Clicking it toggles the only-selected filter (the text then ends in " — show all"). The tooltip lists why rows are skipped ("1 equal (Skip equal components is on)"). It is hidden when nothing is selected and the filter is off.
- A selected row that doesn't count for a button is listed in that button's tooltip ("3 only-in-org rows skipped").
- Deploy reuses the Deploy panel's deploy path:
  - the live org check before the deploy;
  - the production safety from `orgSafety`;
  - `recordDeployed`;
  - deploy results and errors in the panel;
  - the compare service pauses during the deploy and re-compares afterwards.
- Retrieve reuses `retrieveComponents` (with recording and the overwrite safety, as the Org Browser does), then rescans locally and re-compares.

## Diff

- Changed in SC1: the content compare service **keeps** the org copies.
  - After a compare, each compared component's org files move to `<cacheRoot>/org/<safe key>/<inner path>`, replacing the previous copy. Only the run's output dir is removed.
  - `orgCopyFiles(key)` returns `inner → abs path`.
  - `fetchOrgCopy(key)` retrieves one component on demand (for example a Profile, or one not compared yet) and stores it the same way.
- The diff action:
  - With one file pair, it calls `vscode.diff(orgUri, localUri, "<Name> (org ↔ local)")`. The org side is read-only (a copy in globalStorage).
  - With several files, it shows a quick pick of the files that differ (equal files listed last, marked), then opens that diff.
  - A file present on only one side opens against an empty untitled doc.

## Delete from org

- Only `only-org` rows count.
- Confirmation is a modal listing the components (first 20, then "+n more"), the org alias and username.
  - Production orgs (`orgSafety`) also require typing the org alias.
- Implementation: a temp dir with an empty `package.xml` (the API version of the project) and `destructiveChanges.xml`, built by a pure builder with tests. The command:
  `sf project deploy start --manifest package.xml --post-destructive-changes destructiveChanges.xml --target-org <user> --json`
- The test level comes from the Delete section's own options (`checkDeleteTestOptions` in `deployTestArgsPure.ts`). Production can't use NoTestRun.
- Results and errors show like a deploy. Recorded in history as kind `delete`. Afterwards the listing of the affected types is refreshed.

## History

- Store: `globalStorage/history/<sha1(projectDir)[0:12]>.json`, newest first, capped at 200 entries, written debounced.
- Entry fields:
  - `id`, `kind: deploy | validate | retrieve | delete`;
  - `org` (username), `at`, `durationMs`, `label?` (the optional "Deploy name");
  - `components: string[]` (keys), `testLevel?`, `deployId?`;
  - `ok: boolean`, `errors?: { component?, message }[]` (capped at 50);
  - `source: center | deployPanel | orgBrowser | command`.
- Recorded by:
  - the Center;
  - the Deploy panel's deploy;
  - the Org Browser's retrieve;
  - the right-click deploy and retrieve commands, when they go through the shared engines.
- The UI is the Local history segment of the Deployment history footer tab, listing kind icon, org, relative time, the count and ok/failed.
  - Expanding an entry shows the components and errors.
  - Actions: "Select these components", "Re-run" (same kind, same options; asks first), and "Open in Setup" for deploys with an id. "Open in Setup" uses the existing open-org-at-path helper: `/lightning/setup/DeployStatus/page?address=%2Fchangemgmt%2FmonitorDeploymentsDetails.apexp%3FasyncId%3D<id>`.

## Presets

- The existing deploy presets (component keys, per project) move into a shared per-project store used by both the Deploy panel and the Center. Existing presets migrate in place: same storage key, or a one-time copy.
- Loading a preset selects its components. In the Center it works for both directions.
- "Save preset" saves the current selection.

## Tasks

| ID | Scope | Model | Depends on |
|---|---|---|---|
| SC1 | Engine: union row model (pure) and center status vocab; compare service keeps org copies plus `orgCopyFiles`/`fetchOrgCopy`; diff opener; destructive-changes builder (pure) and delete runner; history store (pure plus host) wired into the Deploy panel, the Org Browser and the right-click commands; shared presets store with migration; tests | sonnet | none |
| SC2 | Center panel: provider, webview (esbuild entry), layout above, selection rules and button counts, conflict chips, diff action, delete flow, Local history segment, presets, open buttons in the two existing panels, command `adure-sfx-toolkit.openSyncCenter` ("Deploy & Retrieve Metadata") in the palette | sonnet | SC1 |
| SC3 | Combined gate, review, test VSIX | lead | SC2 |

## Opening fast

- The project's components render from the stored local index (and stored change times) before the org list, the org check or the test-class scan are done; those follow in separate messages (`orgs`, `testClasses`).
- The org listing comes from the shared cache first and refreshes in the background; statuses update when it arrives.
- The "open:" log line carries a `first rows @… ms` timestamp (first local index posted to the webview).

## Parity with the removed Deploy Metadata panel

| Deploy panel feature | Deploy & Retrieve Metadata |
|---|---|
| Component grid with status against the org, type groups, filters, search | present (union grid, In project filter, column chooser) |
| Search text and type selection shared with the Org Browser | present |
| Org picker, project selector, default org change | present |
| Test level (No tests, Run local, Run relevant, Specified), test class tree, search | present |
| Named test suites | present |
| Validate only (dry run) | present |
| Auto-select Git changes, "Select changed (Git)" | present; the saved auto option is restored when the panel opens |
| Presets (select, save, shared store) | present |
| Re-deploy from the Deployment History command | ported: opens the panel with selection, test level, validate flag and tests |
| Deploy from Explorer / editor context with paths | ported: `deployMetadata` alias takes the URIs (the context-menu commands "Deploy to Default Org" never opened the panel) |
| Pre-deploy live org check and confirmation | present |
| Hidden-selection prompt | present |
| Production org confirmation | present |
| Live progress, cancel | present (operation card) |
| Result bar, tests, coverage panel | present |
| Problems-view diagnostics and notifications | present (shared `reportDeployOutcome`) |
| Classic deployment history entries (Deployment History command) | ported: the panel writes them too |
| New history (local) | present |
| Compare contents button, progress | present (on demand, with Cancel) |
| Project switch deferred while a deploy runs | ported (also for retrieve and delete) |
| Keyboard navigation in the grid | present |
| Dirty-preset "save changes?" modal when switching presets | missing; open question |

## Toolbar, selection view, local-time filter, Retrieve project

- **Grid toolbar** is one line that never wraps. Left: a funnel icon button (show/hide filters) and the count ("52 of 2,399"; "Selection" while only the selection is shown), which truncates with an ellipsis. Right: icon buttons for Group by type (toggle), Collapse/Expand all (only while grouped) and Columns. "Select all filtered (n)" lives on the header checkbox tooltip.
- **Selection link** under the action button of the active section: "5 selected (2 hidden) · 3 to deploy · 2 skipped". Clicking toggles the only-selected filter. The hidden part has small "show" and "clear hidden" links. The tooltip lists why rows are skipped.
- **Selection banner**: while only-selected is on, a slim info bar under the toolbar reads "Showing your selection: 5 selected (2 hidden) · 3 to deploy · 2 skipped" (the current mode's counting). Actions: "Back to all components", "Clear selection" (deselects all and leaves the view) and ×. Esc in the grid or panel leaves the view unless a menu is open. The bar is hidden when the filter is off.
- **Modified time filter** passes a row when its org last-modified date or its local change time lies in the window. The local change time is the one the date-based status uses (`localInfo`: dirty or untracked files use the file mtime, else the last commit time; the newest across the component's files). Only-org rows have only the org date, only-local rows only the local date. Facet counts use the same predicate. "Modified by me" stays org-based. An optional column "Last modified (local)" (off by default) shows the value.
- **Retrieve project (n)**: a secondary button in the Retrieve section. It retrieves every row that exists locally and in the org, independent of selection and filters (only-local rows and, with "Skip equal components", equal rows are skipped). One modal asks "Retrieve n components of project <name> from <org>? Local files will be overwritten." and, when "Confirm before overwriting local changes" is on, lists up to 10 locally changed components (it replaces the retrieve's own overwrite check, so there is no second prompt). It uses the normal host retrieve path (history label "Retrieve project", op card, rescan, re-compare). The button waits for the org listing; there is no package-directory fallback.
