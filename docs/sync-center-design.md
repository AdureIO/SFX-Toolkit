# Deploy & Retrieve Center

Status: design, 2026-11-23. This is the shared reference for tasks SC1 and SC2.

## Decisions (user)

- **New panel.** The Org Browser and the Deploy Metadata panel stay as they are.
  - Both get a title-bar or toolbar button "Open in Deploy & Retrieve Center".
- **Direction: smart sync plus manual.**
  - There is one selection with two buttons, `Retrieve (n)` and `Deploy (n)`.
  - Quick actions preselect the obvious work.
  - A conflict row needs an explicit per-row choice before it can take part.
- **v1 extras:**
  - a diff per row;
  - delete from the org;
  - history;
  - presets shared with the Deploy panel.
- **Right-hand options are contextual:**
  - shared: org and preset;
  - a Deploy section;
  - a Retrieve section;
  - a Delete section (danger, collapsed).

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

## Layout

- **Top bar:**
  - project selector (multi-project);
  - org select;
  - search (`filterSearchMarkup`);
  - "Listed …" info;
  - Refresh;
  - "Compare contents" plus the compare progress text.
- **Left:** the filter sidebar (`filterGroupsMarkup`): status, type, namespace, modified. It is identical to the Org Browser, including collapse and auto-hide below 560 px.
- **Center:** the Org Browser-style virtual grid.
  - Columns: checkbox, Name, Type, Namespace, Last modified by, Last modified, Status, Actions.
  - "Group by type" toggle and resizable columns, as in the Org Browser.
  - Actions cell:
    - a diff icon on `changed-*`, `conflict` and `equal` rows;
    - on `conflict` rows, a two-state choice chip "Keep local" / "Take org", unset by default.
- **Right:** four sections.
  1. **Sync**
     - The org and preset selects, as in the Deploy panel.
     - Quick actions:
       - "Select changed locally";
       - "Select changed in org";
       - "Select all changes" (changed-locally, changed-in-org and conflict);
       - "Select only local";
       - "Clear".
     - Each shows its count.
  2. **Deploy**
     - Test level and specified tests, Validate only, and Auto-select git changes, all as in the Deploy panel.
     - "Skip equal components" (default on).
     - Button `Deploy (n)`.
  3. **Retrieve**
     - "Confirm before overwriting local changes" (default on; uses the existing retrieve-safety check).
     - "Retrieve the whole object when a child is selected" (default off).
     - "Skip equal components" (default on).
     - Button `Retrieve (n)`.
  4. **Delete from org** (collapsed, danger styling)
     - Button `Delete from org (n)`. It counts only selected `only-org` rows.
  - Footer tabs: **History** | status line.

## Button counts and rules

- `Deploy (n)` counts selected rows that exist locally (`only-local`, `changed-locally`, `equal` when not skipped, `partial`) and conflict rows set to "Keep local".
- `Retrieve (n)` counts selected rows that exist in the org (`only-org`, `changed-in-org`, `equal` when not skipped, `partial`) and conflict rows set to "Take org".
- Selected conflict rows with no choice disable both buttons. The tooltip reads "n conflicts need a choice", and a link filters the list to them.
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
- The test level comes from the Deploy section. Production can't use NoTestRun; the existing deploy logic decides that.
- Results and errors show like a deploy. Recorded in history as kind `delete`. Afterwards the listing of the affected types is refreshed.

## History

- Store: `globalStorage/history/<sha1(projectDir)[0:12]>.json`, newest first, capped at 200 entries, written debounced.
- Entry fields:
  - `id`, `kind: deploy | validate | retrieve | delete`;
  - `org` (username), `at`, `durationMs`;
  - `components: string[]` (keys), `testLevel?`, `deployId?`;
  - `ok: boolean`, `errors?: { component?, message }[]` (capped at 50);
  - `source: center | deployPanel | orgBrowser | command`.
- Recorded by:
  - the Center;
  - the Deploy panel's deploy;
  - the Org Browser's retrieve;
  - the right-click deploy and retrieve commands, when they go through the shared engines.
- The UI is the History tab in the right panel, listing kind icon, org, relative time, the count and ok/failed.
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
| SC2 | Center panel: provider, webview (esbuild entry), layout above, selection rules and button counts, quick actions, conflict chips, diff action, delete flow, History tab, presets, open buttons in the two existing panels, command `adure-sfx-toolkit.openSyncCenter` ("Deploy & Retrieve Center") in the palette | sonnet | SC1 |
| SC3 | Combined gate, review, test VSIX | lead | SC2 |
