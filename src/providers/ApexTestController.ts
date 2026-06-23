import * as vscode from "vscode";
import { runCommandArgs } from "../utils/commandRunner";
import { Logger } from "../utils/outputChannel";
import { isSalesforceProject } from "../utils/projectUtils";

/**
 * Integrates Apex tests with VS Code's native Testing view ("Test Explorer").
 * Test classes/methods are discovered from the workspace and run via the
 * Salesforce CLI; pass/fail (with messages) and code coverage are reported back
 * into the native UI — instead of just shelling out a command.
 */

/** A test method (or class) parsed from a .cls file. */
interface Parsed {
  className: string;
  methods: { name: string; line: number }[];
}

const TEST_METHOD_RE = /(?:@\s*istest\b[^\n]*|\btestmethod\b)/i;

function parseTestClass(fileName: string, text: string): Parsed | null {
  // Only classes annotated @isTest anywhere are test classes.
  if (!/@\s*istest/i.test(text)) return null;
  const className = fileName.replace(/\.cls$/i, "");
  const methods: { name: string; line: number }[] = [];
  // Match test methods: an @isTest / testMethod marker followed (soon) by a method signature.
  const re = /(@\s*istest\b|testmethod\b)([\s\S]{0,200}?)\b(?:void|[\w<>[\],. ]+?)\s+(\w+)\s*\(/gi;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(text)) !== null) {
    const name = m[3];
    if (!name || seen.has(name)) continue;
    // Skip obvious non-methods (e.g. the class declaration itself).
    if (/^(class|interface|enum)$/i.test(name)) continue;
    seen.add(name);
    const idx = m.index + m[0].length - 1;
    const line = text.slice(0, idx).split("\n").length - 1;
    methods.push({ name, line });
  }
  return { className, methods };
}

export function registerApexTestController(context: vscode.ExtensionContext): vscode.Disposable {
  const controller = vscode.tests.createTestController("adureApexTests", "Apex Tests");
  context.subscriptions.push(controller);

  const fileToClassId = new Map<string, string>();

  async function discoverFile(uri: vscode.Uri): Promise<void> {
    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch {
      return;
    }
    const fileName = uri.path.split("/").pop() ?? "";
    const parsed = parseTestClass(fileName, text);
    if (!parsed) {
      // No longer a test class — remove any stale item.
      const prev = fileToClassId.get(uri.toString());
      if (prev) { controller.items.delete(prev); fileToClassId.delete(uri.toString()); }
      return;
    }
    const classId = "class:" + parsed.className;
    const classItem = controller.createTestItem(classId, parsed.className, uri);
    classItem.canResolveChildren = false;
    for (const meth of parsed.methods) {
      const mItem = controller.createTestItem(classId + "." + meth.name, meth.name, uri);
      mItem.range = new vscode.Range(meth.line, 0, meth.line, 0);
      classItem.children.add(mItem);
    }
    controller.items.add(classItem);
    fileToClassId.set(uri.toString(), classId);
  }

  async function discoverAll(): Promise<void> {
    controller.items.replace([]);
    fileToClassId.clear();
    if (!isSalesforceProject()) return;
    let files: vscode.Uri[];
    try {
      files = await vscode.workspace.findFiles("**/classes/*.cls", "**/node_modules/**", 5000);
    } catch {
      return;
    }
    for (const f of files) await discoverFile(f);
  }

  controller.resolveHandler = async (item) => {
    if (!item) await discoverAll();
  };
  controller.refreshHandler = async () => { await discoverAll(); };

  // Keep in sync with edits/creates/deletes of Apex classes.
  const watcher = vscode.workspace.createFileSystemWatcher("**/classes/*.cls");
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate((u) => void discoverFile(u)),
    watcher.onDidChange((u) => void discoverFile(u)),
    watcher.onDidDelete((u) => {
      const prev = fileToClassId.get(u.toString());
      if (prev) { controller.items.delete(prev); fileToClassId.delete(u.toString()); }
    })
  );

  // ── Run profile ────────────────────────────────────────────────────────────
  const runProfile = controller.createRunProfile(
    "Run Apex Tests",
    vscode.TestRunProfileKind.Run,
    (request, token) => runTests(controller, request, token, false),
    true
  );
  context.subscriptions.push(runProfile);
  // Coverage profile — same runner, asks the CLI for code coverage.
  const covKind = (vscode.TestRunProfileKind as { Coverage?: vscode.TestRunProfileKind }).Coverage;
  if (covKind !== undefined) {
    const covProfile = controller.createRunProfile(
      "Run Apex Tests with Coverage",
      covKind,
      (request, token) => runTests(controller, request, token, true),
      false
    );
    context.subscriptions.push(covProfile);
  }

  // Command to open the native Testing view (the exact command id varies by VS
  // Code version, so try the known ones in order).
  context.subscriptions.push(
    vscode.commands.registerCommand("adure-sfx-toolkit.openApexTests", async () => {
      const candidates = ["workbench.view.testing", "testing.focusTestExplorerView", "workbench.view.extension.test"];
      for (const cmd of candidates) {
        try { await vscode.commands.executeCommand(cmd); return; } catch { /* try the next */ }
      }
      vscode.window.showInformationMessage("Open the Testing view from the Activity Bar to run Apex tests.");
    })
  );

  // Initial discovery.
  void discoverAll();

  return controller;
}

/** Flatten the requested items (or all) into the class/method test items to run. */
function collectItems(controller: vscode.TestController, request: vscode.TestRunRequest): vscode.TestItem[] {
  const out: vscode.TestItem[] = [];
  const exclude = new Set((request.exclude ?? []).map((i) => i.id));
  const visit = (item: vscode.TestItem) => {
    if (exclude.has(item.id)) return;
    if (item.children.size > 0) {
      item.children.forEach(visit);
    } else {
      out.push(item);
    }
  };
  if (request.include) {
    request.include.forEach(visit);
  } else {
    controller.items.forEach(visit);
  }
  return out;
}

async function runTests(
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
  withCoverage: boolean
): Promise<void> {
  const run = controller.createTestRun(request);
  const items = collectItems(controller, request);
  // Map FullName (Class.Method) → TestItem for result correlation.
  const byFullName = new Map<string, vscode.TestItem>();
  const testArgs: string[] = [];
  for (const item of items) {
    // item.id is "class:Class.method" for methods, "class:Class" for whole class.
    const id = item.id.replace(/^class:/, "");
    run.enqueued(item);
    if (id.includes(".")) {
      byFullName.set(id.toLowerCase(), item);
      testArgs.push("--tests", id);
    } else {
      // Whole class — correlate by class prefix later.
      byFullName.set(id.toLowerCase(), item);
      testArgs.push("--class-names", id);
    }
  }
  if (testArgs.length === 0) { run.end(); return; }

  items.forEach((i) => run.started(i));

  const args = ["apex", "run", "test", ...testArgs, "--result-format", "json", "--synchronous", "--wait", "30"];
  if (withCoverage) args.push("--code-coverage");

  try {
    if (token.isCancellationRequested) { run.end(); return; }
    const raw = await runCommandArgs("sf", args);
    const parsed = JSON.parse(raw);
    const result = parsed.result ?? parsed;
    const tests: Array<Record<string, unknown>> = result?.tests ?? [];
    for (const t of tests) {
      const fullName = String(t.FullName ?? `${(t.ApexClass as { Name?: string })?.Name ?? ""}.${t.MethodName ?? ""}`);
      const outcome = String(t.Outcome ?? "");
      const runtime = Number(t.RunTime ?? 0);
      const item = byFullName.get(fullName.toLowerCase())
        ?? byFullName.get(String((t.ApexClass as { Name?: string })?.Name ?? "").toLowerCase());
      if (!item) continue;
      if (/pass/i.test(outcome)) {
        run.passed(item, runtime);
      } else if (/skip/i.test(outcome)) {
        run.skipped(item);
      } else {
        const msg = new vscode.TestMessage(`${t.Message ?? "Test failed"}\n${t.StackTrace ?? ""}`.trim());
        run.failed(item, msg, runtime);
      }
    }
    const summary = result?.summary ?? {};
    run.appendOutput(
      `Apex tests: ${summary.passing ?? "?"} passed, ${summary.failing ?? "?"} failed` +
      (withCoverage && summary.testRunCoverage ? ` · coverage ${summary.testRunCoverage}` : "") + "\r\n"
    );
    Logger.info(`Apex test run: ${summary.passing ?? "?"} pass / ${summary.failing ?? "?"} fail`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const tm = new vscode.TestMessage(`Could not run Apex tests: ${message}`);
    items.forEach((i) => run.errored(i, tm));
    Logger.error("Apex test run failed", e);
  } finally {
    run.end();
  }
}
