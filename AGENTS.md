# Agents

## Cursor Cloud specific instructions

This is a VS Code extension project (Adure SFX Toolkit) for Salesforce development.

### Key commands

| Task | Command |
|------|---------|
| Install deps | `npm install` |
| Compile | `npm run compile` |
| Watch mode | `npm run watch` |
| Lint | `npm run lint` |
| Package .vsix | `vsce package --no-git-tag-version` |

### CI/CD (GitHub Actions)

- **CI** (`.github/workflows/ci.yml`): on push/PR to `main` or `master` — `npm ci`, compile, lint. Tests are not run (see Gotchas).
- **Publish** (`.github/workflows/publish.yml`): on **published** GitHub Releases or **workflow_dispatch** — packages with `@vscode/vsce`, publishes to the [Visual Studio Marketplace](https://marketplace.visualstudio.com/) and [Open VSX](https://open-vsx.org/), uploads `extension.vsix` as a workflow artifact.

Repository **Secrets** (Settings → Secrets and variables → Actions):

| Secret | Purpose |
|--------|---------|
| `VSCE_PAT` | [Azure DevOps PAT](https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate) with **Marketplace (Manage)** scope, for the publisher in `package.json` (`AdureIO`). |
| `OVSX_PAT` | Personal access token from [open-vsx.org](https://open-vsx.org/) user settings, for the same publisher namespace. |

Before publishing: bump `version` in `package.json`, commit, tag (e.g. `v0.8.0`), push tag, then create/publish a GitHub Release from that tag (or run **Publish extension** manually after merging the version bump).

### Gotchas

- The project requires `@types/glob` as a devDependency (not listed in the original `package.json`). Without it, `npm run compile` fails because `glob` v8 does not bundle its own TypeScript declarations.
- The project ships without an `.eslintrc.json`. One was created during setup; without it `npm run lint` errors with "couldn't find a configuration file."
- There are no automated tests (`src/test/` is empty). The `npm run test` script will fail since the test runner file doesn't exist.
- The extension requires the Salesforce CLI (`sf`) to be installed for any runtime functionality (org management, deployments, log viewing, etc.). Without `sf`, the extension loads but shows "sf: not found" errors in the sidebar.
- To manually test the extension in VS Code, open a folder containing an `sfdx-project.json` file, then use the Adure SFX Toolkit icon in the activity bar to access the sidebar views (Logs, Debug Traces, Orgs, Development).
- To launch the Extension Development Host from VS Code, use the "Run Extension" launch configuration (F5).
