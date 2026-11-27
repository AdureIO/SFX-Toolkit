# Multiple Salesforce projects in one window

Status: design, 2026-11-23. This document is the shared reference for tasks MP1–MP4.

## Decisions (user)

- **Detection.** SFDX (`sfdx-project.json`) and MDAPI (`src/package.xml`, Metadata namespace) projects are found at a workspace-folder root and up to **2 levels below it**. A deeper SFDX project nested inside a found project still works per file, through `findSfdxProjectDir`, as it does today.
- **Active project.** It follows the active editor, the way Git picks a repository:
  - the project that contains the active editor's file;
  - otherwise the last active project (persisted in workspaceState);
  - otherwise the first discovered project.
  - A status bar picker switches the active project manually.
- **Default orgs.** Every project uses its own default org. `null` / "the default org" always means **the active project's** default org. Per-file features use **the file's project's** default org.
- **Views and panels.** They follow the active project by default.
  - **Webview panels** (Deploy & Retrieve Metadata, Data Tools, Data Migration, REST Explorer, Package Explorer, Workbench, SOQL editor):
    - When more than one project exists, the header has a **project selector** (dropdown), with the active project preselected.
    - Picking another project in the selector switches only that panel. It does not change the global active project.
    - While the panel's selector is still on the active project, the panel follows active-project changes.
    - Once the user has picked a different project, the panel stays pinned to it until they pick again.
  - **Snippets view:** snippets exist per project. The view lists the snippets of **all** projects:
    - each snippet has a project-name badge (`description`);
    - a view-title filter command chooses all projects or one project, defaulting to all;
    - running or editing a snippet uses that snippet's own project and its default org.
  - **Traces, coverage, Dev actions, Apex tests:** active project only.
- **Language server.** There is still one server. Its symbol index is partitioned by the project's **default org**:
  - projects with the same default org share completion, references, rename and type resolution;
  - projects with different orgs are isolated;
  - a project without a default org is its own partition (keyed by the project dir);
  - files outside any project form a partition `none`.

## Discovery rules

- Scan each workspace folder:
  - the root;
  - its direct subfolders (depth 1);
  - their subfolders (depth 2).
- Skip:
  - names starting with `.`;
  - `node_modules`, `out`, `dist`, `build`, `target`, `vendor`, `bin`, `obj`, `coverage`, `tmp`;
  - anything inside an already found project (no projects inside projects from discovery).
- A folder is SFDX if it contains `sfdx-project.json`.
- A folder is MDAPI if it passes `isMdapiFolder`: `src/package.xml` with the Metadata namespace, and no `sfdx-project.json` in it or above it.
- Re-discover on:
  - workspace-folder changes;
  - a file system watcher for `**/sfdx-project.json` and `**/src/package.xml`, filtered to depth ≤ 2 (plus `src/`) and debounced 500 ms.
- Activation events: add `workspaceContains:*/sfdx-project.json`, `workspaceContains:*/*/sfdx-project.json`, `workspaceContains:*/src/package.xml` and `workspaceContains:*/*/src/package.xml`.

## Project registry (`src/utils/projectRegistry.ts`, new)

```ts
interface SfProject {
  dir: string;              // absolute fs path
  kind: "sfdx" | "mdapi";
  name: string;             // folder path relative to its workspace folder, or the folder name at a root
  workspaceFolder: string;  // absolute path of the containing workspace folder
}
projects(): SfProject[]                     // sorted by workspace-folder order, then path
projectOfFile(file: string): SfProject | undefined   // deepest discovered project containing the file
activeProject(): SfProject | undefined
setActiveProject(dir: string): void         // from the picker; persisted
onDidChangeProjects: vscode.Event<void>
onDidChangeActiveProject: vscode.Event<SfProject | undefined>
```

The existing helpers in `projectUtils.ts` keep their names and change meaning:

| Helper | New meaning |
|---|---|
| `primaryProjectRoot()` | `activeProject()?.dir`, else the first workspace folder |
| `isSalesforceProject()` | any SFDX project discovered |
| `isMdapiProject()` | the active project is MDAPI |
| `isWorkspaceUsable()` | any project discovered |
| `mdapiFolders()` | the dirs of the discovered MDAPI projects |

Context keys:
- `isSalesforceProject`, `isMdapiProject` and `isUsableProject` keep their meaning above.
- New `adure-sfx-toolkit:multipleProjects` (more than one project).
- New `adure-sfx-toolkit:activeProjectIsSfdx`.
- All of them are updated on project and active-project changes.

## CLI and org resolution

- `commandRunner` uses the active project's dir as the default cwd, not `workspaceFolders[0]`. Every `sf` call without an explicit cwd then picks up the right `sfdx-project.json` and default org.
- `canonicalOrgKey(null)`, `resolveDefaultTargetOrgUsername*` and `getDefaultOrg*` without a root resolve against the active project.
- Global fallbacks (`getKnownTargetOrgUsername`, the org-list-cache default) may only answer for the project the org list was produced in.
- On an active-project change:
  - invalidate the default-org key cache for `""`/null;
  - invalidate the org-list cache's default flags;
  - fire `notifyDefaultOrgChanged` (the UI then re-renders and warms caches for the new org);
  - do **not** restart the language server.
- Host `orgForUri` uses `projectOfFile`, falling back to `findSfdxProjectDir`. MDAPI files then resolve to their own project's default org, as the server's `orgContext` already does.

## Status bar

- A project item (Left, priority just before the health item) is shown only when more than one project exists: `$(folder) <name>`. Its tooltip gives the kind and default org.
- Clicking it opens a quick pick of all projects with kind, relative path and default org. The current project is marked.
- Picking one calls `setActiveProject`.
- The health item stays as it is, but takes its active project from the registry (`selectActiveProject` becomes a thin wrapper).

## Tasks

| ID | Scope | Model | Depends on |
|---|---|---|---|
| MP1 | Registry, discovery, watcher, active project, status bar picker, context keys, activation events, `projectUtils` redirect, commandRunner default cwd, default-org and orgKey resolution, cache invalidation on switch, host `orgForUri` for MDAPI | sonnet | none |
| MP2 | Per-file features: right-click deploy and retrieve org per file project, validateApex, metadataDiff, addToIgnore, LWC providers and typings, jsconfig repair, test controller (active-project discovery, run cwd and org, ids without collisions), orgSafety per project | sonnet | MP1 |
| MP3 | Panels get a project selector (pinning, see Decisions): Deploy & Retrieve Metadata, Data Tools, Data Migration, REST Explorer, Package Explorer, SOQL editor storage, Workbench storage and buffer. Snippets view lists all projects with a badge and filter. Follow the active project: logPaths, Process Map, Object Visualizer, Traces, Dev actions, coverage | sonnet | MP1 |
| MP4 | Language server partitioning by org, per-project stubs, namespace per file, host→server project map | sonnet | MP1 |
| MP5 | Combined gate, review, test VSIX | lead | MP2–MP4 |
