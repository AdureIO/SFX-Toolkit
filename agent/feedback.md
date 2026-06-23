# General

# Data migration

# Sidebar 'Development'

# API Explorer

# SOQL Editor/ Workbench

- [x] Friendlier builder: [x] multiple AND/OR WHERE rows (add/remove, type-aware operators & quoting) · [x] relationship/parent fields in SELECT (pick relationship → field → chip, e.g. Owner.Name) · [x] visual child-subqueries (pick child relationship → field → chip → (SELECT … FROM Rel)) · [x] two-way sync ("↺ From query" parses object/fields/parent-fields/child-subqueries/WHERE/ORDER/LIMIT back into the builder).
- [~] Workbench UX: [x] export CSV/JSON · [x] format/prettify (Shift+Alt+F) · [x] result count · [x] pagination ("⬇ Load more" pages through nextRecordsUrl) · [x] saved queries (see below) · [ ] multiple tabs (deferred — needs an in-webview tab model).
- [x] the format button should be on the top right of the query instead of between query and results -> moved ✨ Format into the Query card header (top-right); removed it from the run bar.
- [x] visual builder, how are the fields sorted? add search box to find fields quickly, add support for related objects -> fields now sorted alphabetically (Id & Name pinned on top); added a "Filter fields…" search box (Select all / Clear respect the filter); related objects supported via parent-field picker + child-relationship subqueries.
- [x] visual builder: add button Execute too to replace in builder & exectute other than just apply to the query -> added "▶ Apply & Execute" alongside "Apply to query →".
- [x] implement 'presets' or save query to let users save specific queries in the project, just like deploy metadata etc. -> Saved queries: 💾 save / open via dropdown / 🗑 delete, persisted per-project to .sfdx/asfx/soql-saved.json.
- [x] the visual rework removed the ability to edit columns/ rows in the query results => NOT OKAY -> editing logic was intact but had no visual cue after the restyle; editable cells now show a text cursor, hover highlight + ✎ affordance and an "Editable — click to change" tooltip (read-only cells stay greyed). Inline edit → "💾 Save edits" still writes back via sf.
- [x] save query does not function/ work, nothing happens, i can not give it a name too to recognize it. -> root cause: webview window.prompt/window.confirm are no-ops in VS Code. The name prompt + overwrite/delete confirms now run host-side via showInputBox/showWarningMessage; 💾 opens a named input box, 🗑 confirms. Persists to .sfdx/asfx/soql-saved.json.
- [] inline edit is still not working. should work for all types of input

# Tests
