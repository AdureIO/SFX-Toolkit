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

### Gotchas

- The project requires `@types/glob` as a devDependency (not listed in the original `package.json`). Without it, `npm run compile` fails because `glob` v8 does not bundle its own TypeScript declarations.
- The project ships without an `.eslintrc.json`. One was created during setup; without it `npm run lint` errors with "couldn't find a configuration file."
- There are no automated tests (`src/test/` is empty). The `npm run test` script will fail since the test runner file doesn't exist.
- The extension requires the Salesforce CLI (`sf`) to be installed for any runtime functionality (org management, deployments, log viewing, etc.). Without `sf`, the extension loads but shows "sf: not found" errors in the sidebar.
- To manually test the extension in VS Code, open a folder containing an `sfdx-project.json` file, then use the Adure SFX Toolkit icon in the activity bar to access the sidebar views (Logs, Debug Traces, Orgs, Development).
- To launch the Extension Development Host from VS Code, use the "Run Extension" launch configuration (F5).
