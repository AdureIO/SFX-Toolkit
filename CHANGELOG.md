# Changelog

All notable changes to the Adure SFX Toolkit extension are documented here.

---

## [0.14.0] — Upcoming

### ✨ New features

#### 📂 Data Export / Import (`ASFXT: Data Export / Import`)

Full-featured data migration panel for Salesforce orgs.

**Export tab**
- Write any SOQL query and export results to CSV or JSON, saved directly to the workspace root with a timestamped filename.
- Click the result bar to open the exported file immediately in the editor.

**Import tab**
- Browse and load any CSV file from disk; preview the first rows and see total record/column counts.
- SObject API name is auto-suggested from the filename.
- Four operations: **Insert**, **Update**, **Upsert**, **Delete**.
- **Composite-key upsert**: select 2–3 CSV columns as a composite lookup key when no dedicated external ID field exists in Salesforce. The panel queries existing records via SOQL, matches client-side, and splits the payload into insert + update batches automatically.
- **Single-field upsert**: standard `composite/sobjects/{SObject}/{ExternalIdField}` API call.
- Uses the SObject Collections REST API in batches of 200 records for all non-delete operations.
- Live progress bar, per-record error display (row number + Salesforce error message), and a final results summary (inserted / updated / failed).
- Auth is resolved automatically via `sf org display` — zero manual token setup.

#### 🔄 Data Migration Wizard (`ASFXT: Data Migration Wizard`)

Full org-to-org object migration with relationship tree discovery and automatic ID remapping.

**Step 1 — Source & Target**
- Pick source and target org (any two connected orgs).
- Write a SOQL query for the root object (e.g. `SELECT … FROM Account WHERE …`).
- Load a previously saved migration profile to re-run the exact same migration.

**Step 2 — Object Tree**
- The root SObject is described via the Salesforce REST API; its child relationships are listed automatically.
- Check any child relationship to include it (Contact under Account, Opportunity, etc.). Each checked child is described lazily — grandchildren appear as you go deeper.
- Per object, select exactly which **fields** to migrate (auto-suggested: all createable fields minus system fields).
- Choose an **External ID / Upsert key** per object to use `PATCH composite/sobjects/{SObject}/{field}` instead of INSERT — avoids duplicates on re-runs.
- **Save Migration Profile** writes a `.migration.json` file capturing the full tree, field selection, external ID config, and source SOQL for exact re-use.

**Migration engine**
- Processes objects in topological order (parents before children) — guaranteed.
- After inserting/upserting parent records, queries the target org to build a `sourceId → targetId` map.
- Child lookup fields are automatically remapped to target IDs before sending — referential integrity is maintained across orgs.
- Uses SObject Collections REST API in batches of 200 records (full `allOrNone: false` semantics).
- Paginates large datasets with SOQL `nextRecordsUrl` — no CLI record limits.
- For children queries > 500 parent IDs, the WHERE IN clause is automatically chunked into multiple queries.
- Per-record error details (row index, source record ID, Salesforce error message).

**Step 3 — Run**
- Live progress per object: phase (querying / inserting / mapping / done), record count, progress bar.
- Final results summary: inserted + updated + failed per object.
- Per-object expandable error list.
- Re-run button to run the same migration again.

#### 🔌 REST API Explorer (`ASFXT: REST API Explorer`)

Built-in Salesforce REST API client with zero authentication setup.

- **Org selector** + automatic `Authorization: Bearer <token>` injection from `sf org display`.
- Method selector (GET / POST / PATCH / PUT / DELETE).
- **Relative URL support**: enter `/services/data/v{version}/sobjects`; `{version}` is substituted from your configured API version and the org's `instanceUrl` is prepended automatically.
- Headers and Body tabs with free-text editors.
- **10 quick templates**: List SObjects, Describe SObject, SOQL Query, Get/Create/Update/Delete Record, Composite API, API Limits, SOSL Search.
- **Request history** (last 10): method, URL, and HTTP status — click any entry to reload it.
- Response panel with colour-coded status badge (green 2xx / amber 4xx / red 5xx), response timing, resolved URL, syntax-highlighted JSON body, and a response headers table.
- All HTTP calls execute server-side (Node.js `https` module) — no CORS issues.

---

## [0.13.x] — Deploy panel sprint

### ✨ New features

#### 🛡️ Pre-Deploy Quality Gate

Automatically scan selected Apex files before every deployment and surface:

| Rule | Severity | What it checks |
|---|---|---|
| `DEBUG_STATEMENT` | ⚠ Warning | `System.debug()` calls left in code |
| `HARDCODED_ID` | ❌ Error | Salesforce record IDs hard-coded in string literals |
| `DML_IN_LOOP` | ❌ Error | SOQL queries or DML statements inside `for`/`while` loops |
| `TODO_FIXME` | ℹ Info | `TODO` or `FIXME` comments |

- Violations are listed with file, line, severity, rule name, and a plain-English message.
- If any violations are found, the deployment is paused and a full violation panel is shown.
- **Deploy anyway** button: experts can proceed past warnings. If errors are present, the button label changes to `⚠ Deploy anyway (errors found)` to make the risk explicit.
- Toggle on/off per session with the **Pre-deploy quality gate** checkbox in the deploy panel.

#### 📊 Test Coverage per Deployment

After a deployment that runs Apex tests, a collapsible **Coverage** panel appears beneath the result bar:

- Per-class coverage percentages parsed from the SF CLI output (supports both format variants).
- Colour-coded: 🟢 green (≥ 75 %), 🟡 amber (≥ 50 %), 🔴 red (< 50 %).
- Average coverage displayed in the collapsed header.

#### 🗂️ Named Test Suites

Save named groups of test classes alongside a deployment preset:

- **Save Suite** button in the test-classes block — prompts for a name or uses the selected preset name.
- **Suite dropdown**: select any saved suite to auto-tick the matching test classes.
- **Delete Suite** button removes the suite from disk.
- Suites are persisted to `.sfdx/asfx/test-suites.json` inside the workspace and survive VS Code restarts.

#### 🕒 Deployment History

Every deployment (success or failure) is persisted and browsable:

- Full history panel with status badge, timestamp, duration, source paths, test level, and target org.
- **Search** history by path, org, or test level.
- **Re-run** any past deployment in one click.
- Stored in `.sfdx/asfx/deploy-history.json`.

### 🔧 Improvements

- **FileSystemWatcher** replaces setInterval polling — the source-path tree refreshes the moment a tracked file is saved (600 ms debounce), eliminating unnecessary CPU usage between saves.
- Deploy panel state (selected paths, test level, org, preset, quality gate toggle, selected suite) is persisted across tab switches via `globalState`.
- `Promise.allSettled` parallel loading of tree, test classes, presets, orgs, and test suites for faster panel open times.

---

## [0.13.0] — Deploy panel visual redesign

### 🔧 Improvements

- Complete visual overhaul of the Deploy Metadata panel: two-column layout, CSS radio pills for test-level selection, badge-style status indicators, cleaner section hierarchy.
- Deployment presets: save and restore full deployment configurations (paths, test level, org).

---

## [0.12.x] — LWC Navigator, Snippets panel

### ✨ New features

- **LWC Navigator** (`Alt+L`): jump between the JS, HTML, CSS, and meta-XML files of an LWC component. Direct shortcuts `Alt+1` – `Alt+4`.
- **Apex Snippets panel**: visual overview panel for all saved snippets with run, edit, and delete actions. Tree view in the sidebar.
- **Ignore helpers**: right-click any file or folder in the Explorer to add it to `.gitignore` or `.forceignore`.

---

## [0.11.x] — Org health, Quick SOQL

### ✨ New features

- **Org Health**: view key governor limit consumption for the default org.
- **Quick SOQL from selection**: highlight a field reference or SObject name and run a quick query.
- **Metadata diff**: compare local metadata files against org metadata.

---

## [0.10.x] — Permission Set & Scratch Org editors

### ✨ New features

- **Permission Set Editor**: custom VS Code editor for `.permissionset-meta.xml` files.
- **Scratch Org Definition Editor**: custom VS Code editor for `project-scratch-def.json` files.

---

## [0.9.x] — SOQL Builder

### ✨ New features

- **SOQL Builder & Editor**: full-featured panel with object/field IntelliSense, result table, inline editing, and save-back to Salesforce.

---

## [0.8.x] — Org management

### ✨ New features

- **Org Explorer**: sidebar tree with connect, open-in-browser, set-as-default, rename, generate password, and delete/logout actions.
- **Scratch Org Wizard** and **Quick Scratch** for fast scratch org creation.

---

## [0.7.x] — Deploy metadata panel (initial)

### ✨ New features

- **Deploy Metadata panel**: select source paths, pick test level, choose target org, run deployment.

---

## [0.6.x] — Execute Anonymous panel

### ✨ New features

- **Execute Anonymous panel**: dedicated bottom panel for Apex execution with output history and re-run.
- Apex CodeLens for running individual test methods.

---

## [0.5.x] — Apex snippets (CLI)

### ✨ New features

- **Apex Snippets**: save, run, and delete named Apex code snippets via the command palette.

---

## [0.4.x] — Source operations

### ✨ New features

- Push / pull source, deploy / retrieve current file, reset source tracking.
- Auto-save before push option.

---

## [0.3.x] — Debug traces

### ✨ New features

- **Trace Flags**: create, view, and delete debug trace flags.
- **Quick Trace**: one-click trace for the current user.

---

## [0.2.x] — Log filtering

### ✨ New features

- **Debug Filter** (`Cmd+D` / `Ctrl+D`): isolate `USER_DEBUG`, errors, exceptions.
- **SOQL/DML Filter**: show only SOQL and DML log lines.
- Active state icons in the editor toolbar.

---

## [0.1.x] — Initial release

- Log listing, download, and viewer.
- Live polling for new debug logs.
- Delete all logs (org + local cache).
