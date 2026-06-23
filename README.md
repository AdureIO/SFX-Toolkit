# Adure SFX Toolkit

![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/adureio.sfx-toolkit?style=flat-square&label=VS%20Marketplace&color=blue)
![Open VSX Installs](https://img.shields.io/open-vsx/dt/adureio/sfx-toolkit?style=flat-square&label=Open%20VSX&color=orange)

Adure SFX Toolkit is an open-source VSCode extension designed to supercharge your Salesforce development workflow. It provides a comprehensive set of utilities for log management, debugging, org management, source tracking, deployment, data operations, and API exploration.

## Features

### 🔍 Log Management & Filtering

- **Log Viewer**: Easily list, download, and open Salesforce debug logs directly from the sidebar. Works with the Salesforce default extensions' log locations.
- **Delete All Logs**: Remove logs from both the org (Tooling API with CLI fallback when needed) and clear the local log cache in one action.
- **Smart Filtering**: Toggle filters to focus on what matters.
  - **Debug Filter** (`Cmd+D` / `Ctrl+D`): Instantly show only `USER_DEBUG` statements, errors, and exceptions.
  - **SOQL & DML Filter**: Filter logs to show only database queries (`SOQL_EXECUTE`) and DML operations.
- **Visual Feedback**:
  - **Active State Icons**: Filter icons in the editor title bar light up (blue) when active, so you always know what you're seeing.
  - **Loading Indicators**: Visual progress indication when applying filters to large log files.
- **Live Polling**: Automatically poll for new debug logs in the background (every 5 seconds).
- **Trace Flags**:
  - **Quick Trace**: One-click setup of a debug trace for the current user.
  - View, manage, and delete existing trace flags.

![Sidebar with logs, traces, orgs and tools](docs/screenshots/sidebar.png)
![Log filtering for debug and SOQL/DML](docs/screenshots/filter-logs.png)
![Create debug trace flow](docs/screenshots/create-trace.png)

### ⚡ Apex & SOQL

- **Execute Anonymous**: Run Apex code directly from the editor (`.apex` files or selections). Output runs in the **Execute Apex** bottom panel for fast feedback and history.
- **Rerun Last**: Quickly rerun the last executed Apex snippet without re-selecting code.
- **SOQL Editor** (`ASFXT: Open SOQL Builder & Editor`): A powerful SOQL builder and editor with completion.
  - **Builder & Completion**: Object and field completion to write SOQL faster.
  - **Interactive Table**: View query results in a responsive table.
  - **Inline Editing**: Directly edit record fields in the table.
  - **Smart Save**: Commit changes back to Salesforce (`sf data update record`) with automatic quote escaping and error handling.
  - **Discard Changes**: Easily revert unsaved edits.
- **Apex CodeLens**: Run specific test methods or entire test classes directly from your Apex code.
- **Apex Snippets**: Save, organize, run, edit, and delete reusable Apex snippets from the dedicated sidebar view and overview panel.

![SOQL builder and results table](docs/screenshots/soql-builder.png)
![Apex snippets panel](docs/screenshots/apex-snippets.png)

### ☁️ Org Management

- **Org Explorer**: A dedicated view to manage all your connected orgs, scratch orgs, and Dev Hubs.
- **Quick Actions**:
  - 🌐 Open Org in Browser
  - ✅ Set as Default Org / Default Dev Hub
  - 📋 Copy Username
  - ✏️ Rename Alias
  - 🔑 Generate Password for Scratch Orgs
  - 🗑️ Delete/Logout from Org
- **Scratch Org Wizard**:
  - **Create Scratch Org**: Interactive wizard to create scratch orgs.
  - **Quick Scratch**: Create a scratch org with default settings in one click.

### 🛠️ Development Tools

- **Source Operations**:
  - **Push Source**: Intelligent push that automatically detects if source tracking is available. Uses `sf project deploy start` (diff) for tracked orgs and falls back to sequential package deployment for others.
  - **Push Source (Force)**: Override conflicts and force push changes.
  - **Pull Source**: Retrieve changes from the org.
  - **Deploy/Retrieve**: Contextual commands to deploy or retrieve the currently open file.
  - **Reset Source Tracking**: Quickly reset tracking for the default org (`sf project reset tracking`).
- **Flexible Metadata Deploy Flow** (`ASFXT: Deploy Metadata`): Production-style deployment with full control:
  - Select metadata paths / files, pick a test level, target any org.
  - **Deployment History**: Every deployment is persisted with status, duration, test results, and timestamp. Browse, search, and re-run past deployments in one click.
  - **Named Test Suites**: Save named groups of test classes alongside a deployment preset. Load them back in one click for repeat validations.
  - **Pre-Deploy Quality Gate**: Automatically scan your Apex files before deploying and catch:
    - `System.debug()` statements left in code (warning)
    - Hardcoded Salesforce record IDs (error)
    - SOQL or DML inside `for`/`while` loops (error)
    - `TODO` / `FIXME` comments (info)

    You can review violations, then choose to abort or deploy anyway. Errors and warnings are clearly colour-coded.
  - **Test Coverage Display**: After a deployment with tests, a collapsible coverage panel shows per-class coverage percentages — green (≥ 75 %), amber (≥ 50 %), or red (< 50 %) — with the overall average.
  - **Auto-git detection**: The panel automatically detects file changes in your workspace via a `FileSystemWatcher` (debounced 600 ms) so the source tree is always fresh without polling.
  - **Deployment Presets**: Save and load frequently used deployment configurations (paths, test level, target org).
- **Test Runner**: Run local tests with ease.
- **Ignore Helpers**: Add files/folders to `.gitignore` or `.forceignore` directly from explorer context actions.
- **Custom Editors**:
  - **Permission Set Editor**: A dedicated, user-friendly UI for editing Permission Sets (`.permissionset-meta.xml`).
  - **Scratch Org Definition Editor**: specialized UI for editing `project-scratch-def.json` files.

![Deploy metadata flow](docs/screenshots/deploy-metadata.png)

### 🔄 Data Migration Wizard

`ASFXT: Data Migration Wizard` — move entire Salesforce object trees from one connected org to another — no CSV, no manual ID management.

#### How it works

**Step 1 — Source & Target**

Pick source and target org, write a SOQL query for the root object, and give the migration a name. Or load a previously saved migration profile to re-run an existing setup in seconds.

**Step 2 — Object Tree**

The root SObject is described via the Salesforce REST API. Its full list of child relationships is displayed in a tree. You check which children to include — Contacts under Account, Opportunities, Tasks under Contact, etc. Each checked object is described lazily, so you can drill as deep as the data model goes.

For each included object:
- **Fields** — all createable fields are pre-selected. Untick anything you don't need. Bulk "All / None" toggles per object.
- **External ID / Upsert key** — choose a field (any external ID or unique field) to use upsert semantics on the target org. This prevents duplicate records on re-runs and is essential for sandbox refreshes.

Click **Save Profile** to write a `.migration.json` file to your workspace (`.sfdx/asfx/`). Load it back any time to skip the tree-building step.

**Step 3 — Run**

Click **Start Migration**. The wizard:
1. Queries root records from source org (paginated, no record limits).
2. Inserts / upserts root records in target org.
3. Queries target org to map source IDs → target IDs.
4. Fetches child records (`WHERE lookupField IN (parent IDs)`, chunked for > 500 parents).
5. Replaces every lookup field value with the correct target ID before sending.
6. Repeats for each depth level in topological order.

Live per-object progress bars, phase labels, and counts (inserted / updated / failed) update in real time. Errors are expandable per object with row number and Salesforce error message.

#### Key design decisions

| Concern | Solution |
|---|---|
| Referential integrity | After each object, a `sourceId → targetId` map is built by querying the target org. Child lookup fields are remapped before every batch. |
| Large datasets | REST API pagination via `nextRecordsUrl` — no CLI row limits. WHERE IN clauses are chunked at 500 IDs. |
| Re-runability | External ID / upsert mode per object prevents duplicates. Profiles are saved as JSON for exact re-runs. |
| Deep trees | Lazy describe — only objects you check are described. Tree depth is unbounded. |
| Batch efficiency | SObject Collections REST API, 200 records per batch, `allOrNone: false` for partial success. |

### 📂 Data Export / Import

`ASFXT: Data Export / Import` — a full-featured data migration panel for Salesforce orgs.

#### Export

- Write any SOQL query and export results to CSV or JSON, saved directly to your workspace root.
- Click the result bar to open the exported file immediately in the editor.

#### Import

- Select a CSV file from your workspace, preview the first rows, see total record count.
- Choose the SObject API name (auto-guessed from the file name).
- Pick the **operation**:
  - **Insert** — create new records via SObject Collections API in batches of 200.
  - **Update** — update records (requires `Id` column).
  - **Upsert** — match on an external ID field:
    - **Single field**: standard `sf composite/sobjects/{SObject}/{ExternalIdField}` upsert.
    - **Composite key (2–3 fields)**: no dedicated external ID field in Salesforce? Select any 2–3 CSV columns as a composite lookup key. The panel queries the org for existing matches, splits your CSV into insert and update batches client-side, and runs both in one operation.
  - **Delete** — bulk delete records by `Id` column.
- Live progress, per-record error details (row number + SF error message), and a results summary (inserted / updated / failed) are shown after the operation.

Auth is resolved automatically from `sf org display` — no manual token management.

### 🔌 REST API Explorer

`ASFXT: REST API Explorer` — a built-in Salesforce REST API client with zero authentication setup.

#### Left pane — Request builder

- **Org selector** + auto-inject of `Authorization: Bearer <token>` from `sf org display`.
- **Method pills**: GET, POST, PATCH, PUT, DELETE.
- **URL input**: accepts relative paths (e.g. `/services/data/v{version}/sobjects`) or full URLs. `{version}` is automatically substituted from your configured API version.
- **Headers tab**: free-text `Key: Value` headers.
- **Body tab**: JSON body editor for POST / PATCH / PUT.
- **Quick templates**: 10 pre-built templates covering the most common Salesforce REST endpoints:
  - List SObjects, Describe SObject, SOQL Query, Get/Create/Update/Delete Record, Composite API, Limits, SOSL Search.
- **Request history**: last 10 requests with method, URL, and HTTP status. Click any entry to reload it.

#### Right pane — Response viewer

- **Status badge** colour-coded by HTTP status class (2xx green, 4xx amber, 5xx red) with timing in ms.
- **Resolved URL** shown below the toolbar for transparency.
- **Body tab**: pretty-printed, syntax-highlighted JSON (keys, strings, numbers, booleans, nulls each in distinct VS Code theme colours). Falls back to raw text for non-JSON.
- **Response Headers tab**: key/value table of all response headers.
- **Copy body** button.

All HTTP calls are made server-side (TypeScript / Node.js `https` module) — no CORS issues.

### ⚙️ System & Setup

- **Project Validation**: Automatically checks for `sfdx-project.json` to ensure you are working in a valid Salesforce project.
- **Output Logging**: detailed logs are available in the "Adure SFX Toolkit" output channel. Logs are suppressed by default during deployments to keep the view clean, opening only on errors.
- **Configurable Settings**:
  - Polling interval, maximum fetched logs, quick trace defaults, API version, parallel delete count, test timeout, auto-save before push, and HTTP timeout.

### 🧹 Remove Final Newline on Save

Prettier always writes a final end-of-file newline for JS/CSS/HTML, and there is no Prettier core option to opt out. This setting lets you strip that trailing newline for specific files without touching the rest of the document. It runs as a post-format/save step (via `onWillSaveTextDocument`), so it executes after Prettier's `editor.formatOnSave` and just before VS Code writes to disk.

The feature is **opt-in** and entirely workspace-driven. A document is only modified when:

- `adure-sfx-toolkit.removeFinalNewline.enabled` is `true`, **and**
- the document's language id is in `adure-sfx-toolkit.removeFinalNewline.languages`, **and**
- its workspace-relative path matches at least one glob in `adure-sfx-toolkit.removeFinalNewline.patterns`.

Only the trailing `\n` / `\r\n` characters at the very end of the file are removed; interior content (including blank lines) is left untouched. The operation is idempotent.

#### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `adure-sfx-toolkit.removeFinalNewline.enabled` | `false` | Master switch for the feature. |
| `adure-sfx-toolkit.removeFinalNewline.patterns` | `[]` | Workspace-relative globs (forward-slash). At least one must match for the strip to run. |
| `adure-sfx-toolkit.removeFinalNewline.languages` | `["javascript", "javascriptreact", "html", "css"]` | Language ids eligible for stripping. |
| `adure-sfx-toolkit.removeFinalNewline.runOnSave` | `true` | Run automatically as part of the save lifecycle. |

#### Sample workspace configuration

```json
{
  "adure-sfx-toolkit.removeFinalNewline.enabled": true,
  "adure-sfx-toolkit.removeFinalNewline.patterns": [
    "force-app/**/*.js",
    "force-app/**/*.html",
    "force-app/**/*.css"
  ]
}
```

Each applied strip emits a single `INFO` line to the **Adure SFX Toolkit** output channel for traceability.

## Keyboard Shortcuts

- `Cmd+Enter` / `Ctrl+Enter`: Execute anonymous Apex (when editing `.apex`).
- `Cmd+D` / `Ctrl+D`: Toggle debug-focused log filter (when viewing logs).
- `Alt+L`: LWC navigate to sibling picker.
- `Alt+1` / `Alt+2` / `Alt+3` / `Alt+4`: Jump directly to LWC JS / HTML / Meta / CSS file.

## Open Source

This project is open source! Contributions, issues, and feature requests are welcome.
Check out the [GitHub Repository](https://github.com/AdureIO/SFX-Toolkit).

## Feedback

If you encounter any issues or have suggestions, please file an issue on our GitHub repository.
