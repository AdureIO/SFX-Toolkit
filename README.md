# Adure SFX Toolkit

Adure SFX Toolkit is an open-source VSCode extension designed to supercharge your Salesforce development workflow. It provides a comprehensive set of utilities for log management, debugging, org management, source tracking, and more.

## Features

### 🔍 Log Management & Filtering

-   **Log Viewer**: Easily list, download, and open Salesforce debug logs directly from the sidebar. Works with the Salesforce default extensions’ log locations.
-   **Delete All Logs**: Remove logs from both the org (Tooling API with CLI fallback when needed) and clear the local log cache in one action.
-   **Smart Filtering**: Toggle filters to focus on what matters.
    -   **Debug Filter** (`Cmd+D` / `Ctrl+D`): Instantly show only `USER_DEBUG` statements, errors, and exceptions.
    -   **SOQL & DML Filter**: Filter logs to show only database queries (`SOQL_EXECUTE`) and DML operations.
-   **Visual Feedback**:
    -   **Active State Icons**: Filter icons in the editor title bar light up (blue) when active, so you always know what you're seeing.
    -   **Loading Indicators**: Visual progress indication when applying filters to large log files.
-   **Live Polling**: Automatically poll for new debug logs in the background (every 5 seconds).
-   **Trace Flags**:
    -   **Quick Trace**: One-click setup of a debug trace for the current user.
    -   View, manage, and delete existing trace flags.

### ⚡ Apex & SOQL

-   **Execute Anonymous**: Run Apex code directly from the editor (`.apex` files or selections). Output runs in the **Execute Apex** bottom panel for fast feedback and history.
-   **Rerun Last**: Quickly rerun the last executed Apex snippet without re-selecting code.
-   **SOQL Editor** (`ASFXT: Open SOQL Builder & Editor`): A powerful SOQL builder and editor with completion.
    -   **Builder & Completion**: Object and field completion to write SOQL faster.
    -   **Interactive Table**: View query results in a responsive table.
    -   **Inline Editing**: Directly edit record fields in the table.
    -   **Smart Save**: Commit changes back to Salesforce (`sf data update record`) with automatic quote escaping and error handling.
    -   **Discard Changes**: Easily revert unsaved edits.
-   **Apex CodeLens**: Run specific test methods or entire test classes directly from your Apex code.

### ☁️ Org Management

-   **Org Explorer**: A dedicated view to manage all your connected orgs, scratch orgs, and Dev Hubs.
-   **Quick Actions**:
    -   🌐 Open Org in Browser
    -   ✅ Set as Default Org / Default Dev Hub
    -   📋 Copy Username
    -   ✏️ Rename Alias
    -   🔑 Generate Password for Scratch Orgs
    -   🗑️ Delete/Logout from Org
-   **Scratch Org Wizard**:
    -   **Create Scratch Org**: Interactive wizard to create scratch orgs.
    -   **Quick Scratch**: Create a scratch org with default settings in one click.

### 🛠️ Development Tools

-   **Source Operations**:
    -   **Push Source**: Intelligent push that automatically detects if source tracking is available. Uses `sf project deploy start` (diff) for tracked orgs and falls back to sequential package deployment for others.
    -   **Push Source (Force)**: Override conflicts and force push changes.
    -   **Pull Source**: Retrieve changes from the org.
    -   **Deploy/Retrieve**: Contextual commands to deploy or retrieve the currently open file.
    -   **Reset Source Tracking**: Quickly reset tracking for the default org (`sf project reset tracking`).
-   **Deploy Metadata** (`ASFXT: Deploy Metadata`): Deploy all or selected metadata with full control. Choose to deploy the entire project or specific path(s) (package dirs, custom paths, or browse for folders). Then select test option: run all tests, run specified tests (pick test classes), validate only (dry-run), or no test run. Save **presets** (paths + test option) for repeat deployments.
-   **Test Runner**: Run local tests with ease.
-   **Custom Editors**:
    -   **Permission Set Editor**: A dedicated, user-friendly UI for editing Permission Sets (`.permissionset-meta.xml`).
    -   **Scratch Org Definition Editor**: specialized UI for editing `project-scratch-def.json` files.

### ⚙️ System & Setup

-   **Project Validation**: Automatically checks for `sfdx-project.json` to ensure you are working in a valid Salesforce project.
-   **Output Logging**: detailed logs are available in the "Adure SFX Toolkit" output channel. Logs are suppressed by default during deployments to keep the view clean, opening only on errors.

## Open Source

This project is open source! Contributions, issues, and feature requests are welcome.
Check out the [GitHub Repository](https://github.com/AdureIO/SFX-Toolkit).

## Feedback

If you encounter any issues or have suggestions, please file an issue on our GitHub repository.

## Build

- vsce package
- vsce publish