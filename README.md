# Adure SFX Toolkit

![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/adureio.sfx-toolkit?style=flat-square&label=VS%20Marketplace&color=blue)
![Open VSX Installs](https://img.shields.io/open-vsx/dt/adureio/sfx-toolkit?style=flat-square&label=Open%20VSX&color=orange)

Adure SFX Toolkit is an open-source VSCode extension designed to supercharge your Salesforce development workflow. It provides a comprehensive set of utilities for log management, debugging, org management, source tracking, and more.

## Features

### 🔍 Log Management & Filtering

- **Log Viewer**: Easily list, download, and open Salesforce debug logs directly from the sidebar. Works with the Salesforce default extensions’ log locations.
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
- **Flexible Metadata Deploy Flow** (`ASFXT: Deploy Metadata`): Production-style deployment with full control. Select metadata paths/files, choose test option (run all tests, run relevant tests, run specified tests, validate only, or no test run), and optionally save a **preset** for repeat deployments.
- **Test Runner**: Run local tests with ease.
- **Ignore Helpers**: Add files/folders to `.gitignore` or `.forceignore` directly from explorer context actions.
- **Custom Editors**:
  - **Permission Set Editor**: A dedicated, user-friendly UI for editing Permission Sets (`.permissionset-meta.xml`).
  - **Scratch Org Definition Editor**: specialized UI for editing `project-scratch-def.json` files.

![Deploy metadata flow](docs/screenshots/deploy-metadata.png)

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
