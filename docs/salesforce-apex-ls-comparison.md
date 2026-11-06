# ASFX language server vs the Salesforce Apex language servers

Status: research snapshot, 2026-11-06. Inspected: `salesforce.salesforcedx-vscode-apex` 67.20.0 (Jorje, Java), `salesforce.apex-language-server-extension` 0.10.0 (TypeScript server), and the rest of the installed Salesforce extension pack. Evidence comes from their `package.json` files, bundled code, `javap` on `apex-jorje-lsp.jar`, and live processes (`ps`, `top`, `jcmd`). **Unverified** marks anything not confirmed in code or at runtime.

## Summary

- For **editing and navigation**, users no longer need Jorje. Our server covers completion, hover, definition, references, rename, implementation, type hierarchy, signature help, outline, workspace symbols, semantic tokens, code actions and diagnostics, plus org-aware SObject features and LWC/Aura/VF/Flow-aware references.
- Jorje is still **required by other Salesforce features**:
  - Apex Replay Debugger, including "Debug Test", the test sidebar's debug profile and the anonymous-Apex Debug lens
  - Agentforce DX (through the Replay Debugger)
  - Apex OAS / Create Apex Action
  - the Run Test code lenses
  - the extract refactorings
- **Our extension does not contribute the `apex` / `apex-anon` language ids, grammar or snippets.** Without Jorje's extension or the TS server, `.cls` files lose syntax highlighting.
- **Jorje's compile-level semantic errors are off by default.** `salesforcedx-vscode-apex.enable-semantic-errors` defaults to `false`; when enabled they are reported only as warnings. Default users do not get type checking from Jorje.
- **Memory** (live, this machine, default settings):

| Process | Footprint |
|---|---|
| Jorje JVM | 0.7–2.4 GB per window (no `-Xmx` by default; JVM max heap = ¼ of RAM, 16 GB here) |
| Salesforce TS Apex server | ~1.7 GB per window, up to 98 min CPU, while by default it only serves the outline |
| ASFX server | ~50–60 MB idle, plus ~100–130 MB per extra parse worker (default 1 worker) |

## Feature matrix

| Feature | Jorje / Salesforce | ASFX | Works without Jorje? |
|---|---|---|---|
| Completion | yes (trigger `.`) | yes, org-aware SObject fields, `new`, curated stdlib (~84 types) | yes |
| Hover | yes | yes | yes |
| Go to definition | yes (stdlib navigation probable) | yes, type-resolved, overloads by argument type; SObject/field → stubs; no stdlib navigation | yes (loses stdlib navigation) |
| References | yes | yes, including LWC / Aura / VF / Flow / `Type.forName` | yes |
| Rename | yes | yes (prepare + rename, metadata references where safe) | yes |
| Implementation, type hierarchy, signature help, workspace symbols, semantic tokens | not declared | yes | yes (ours only) |
| Outline | Jorje's is nulled by default (`advanced.lspParityCapabilities`); the TS server provides it | yes | yes |
| Formatting | none in any Salesforce Apex extension | none | — |
| Syntax diagnostics | yes (always, Error) | yes | yes |
| Compile-level semantic diagnostics | off by default; Warning when enabled | no (lint, SObject field validation, "Validate Apex Against Org" check-only deploy) | n/a |
| Code actions | quickfix, extract | different set: try/catch, constructor, implement interface, test class, bulkify SOQL/DML, sharing, remove debug, add `;`, create field stub | yes |
| Extract constant / local variable, declare missing method | yes | no | no |
| Run / Debug Test lenses | yes | removed by design (test sidebar instead) | no |
| Test sidebar, coverage | Salesforce apex-testing | own test controller (Run + Coverage) and coverage highlighting | yes |
| Debug from the test sidebar | via the Replay Debugger | no | no |
| Apex Replay Debugger | hard dependency on Jorje (`extensionDependencies` and runtime `exports.languageClientManager`) | no | no |
| Anonymous Apex | execute (apex-log) and debug (Replay Debugger) | execute | execute yes, debug no |
| Apex OAS / Create Apex Action | hard dependency on Jorje | no | no |
| Agentforce DX | depends on the Replay Debugger | — | no (install-time chain) |
| Agentforce Vibes, Code Analyzer, apex-log, SOQL | no Jorje dependency | — | yes |
| `apex` language id, grammar, language config, snippets | Jorje's extension and the TS server | not contributed | no, unless the TS server is installed |
| Standard Apex library | 2,345 classes, indexed in `apex.db` | ~84 hand-curated types | degraded |

## The Salesforce TS Apex server (`apex-language-server-extension` 0.10.0)

- A separate TypeScript/Node server, not a Jorje wrapper. It is aimed at web support, since Jorje needs a JVM.
- It contributes the `apex`, `apex-anon` and `soql` languages, grammars and snippets.
- In the default `apex.environment.serverMode=production` its only capability is **document symbols**. Setting `development` mode adds completion, hover, definition, references, rename, code actions, code lenses and pull diagnostics.
- Its cost is high for that output: about 1.7 GB per window.

## Duplicates when everything runs

| Request | Jorje | TS server (prod / dev) | ASFX |
|---|---|---|---|
| Completion | yes | – / yes | yes |
| Hover | yes | – / yes | yes |
| Definition, references | yes | – / yes | yes |
| Outline | nulled | yes | yes |
| Rename, code actions | yes | – / yes | yes |
| Code lenses on `.apex` | Debug | – / yes | Run Anonymous Apex (apex-log adds Execute too) |
| Diagnostics | parse errors | – / pull | parse, lint, schema |

- VS Code merges completion, hover, definition and references from every provider, so completion waits for the slowest one.
- Our former `auto` mode turned **all** our Apex features off when Jorje was merely installed, which also dropped the features Jorje lacks.

## What breaks if a user uninstalls Jorje

1. The Replay Debugger and Apex OAS are disabled (hard dependency), and therefore Agentforce DX as well.
2. Lost: Debug Test, Debug All Tests, the anonymous Debug lens, the Run Test lenses, the extract refactorings, and the opt-in semantic warnings.
3. The `apex` language id, grammar and snippets are gone unless the TS server is installed. Our server still attaches by file pattern, but highlighting is gone (behaviour on a plaintext-language document unverified).
4. Our side: the Jorje health monitor and restarts become no-ops. Stub writing to `.sfdx/tools/sobjects` continues. Our own server still uses the stubs for SObject name detection (schema validation, semantic tokens, rename guard) and for SObject/field go-to-definition.

## Gaps vs Jorje, ranked

| # | Gap | Impact | Effort in our server |
|---|---|---|---|
| 1 | Replay Debugger family, Agentforce DX | high for debugging users | XL (own debug adapter); keep Jorje installed |
| 2 | Apex language id, grammar, snippets | high without Jorje or the TS server | S (1–2 days); grammar licensing and registration clash unverified |
| 3 | Compile-level semantic diagnostics | medium (off by default in Jorje) | pragmatic scope M–L (3–6 weeks); type mismatch L (10+ weeks); needs a full stdlib model |
| 4 | Run / Debug Test lenses | medium | Run lens S; Debug blocked by gap 1 |
| 5 | Standard library completeness and navigation | medium | M–L (generated model, 1–2 weeks) |
| 6 | Extract constant / local variable, declare missing method | low–medium | S–M each |
| 7 | Apex OAS | low | out of scope; keep Jorje |

## Decision (2026-11-06)

**Our server answers; Jorje stays installed for what only it has.** Plan:

1. Suppress Jorje's overlapping providers (completion, hover, definition, references) through its language-client middleware, but only while our server provides those features. Setting: `adure-sfx-toolkit.apex.preferOwnProviders`, default on.
2. `apex.languageServer: auto` behaves like `on`.
3. A one-time, opt-in memory recommendation: cap Jorje at 1 GB (`salesforcedx-vscode-apex.java.memory`) and point the user to the TS Apex server so they can disable it if they don't need it.
4. Later: a standalone mode (Apex language registration and a Run Test lens), then basic semantic diagnostics behind a setting once a full stdlib model exists.

## Not verified

- Jorje with semantic errors enabled on real code: what it reports, and the false-positive rate.
- VS Code merge and dedupe behaviour per provider type.
- Rendering of `.cls` files with no Apex language contribution installed.
- Salesforce's roadmap for Jorje versus the TS server, and redistribution terms for the grammar and stdlib.
