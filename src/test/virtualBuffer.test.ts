/**
 * Integration test for the webview editors' virtual buffers: spawns the bundled
 * language server (out/server.js), plays the extension host, and drives documents
 * on the `asfx-buffer:` scheme exactly like ApexBufferBridge does (synthetic
 * didOpen / full-text didChange + direct completion/hover/definition requests),
 * then runs the results through the same wire conversion the bridge uses.
 *
 * Requires `npm run compile` first (out/server.js).
 */
import * as assert from "assert";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { completionToWire, definitionTargets, hoverToWire } from "../providers/bufferBridgeCore";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rpc = require("vscode-jsonrpc/node");

const ACCOUNT = {
  name: "Account",
  label: "Account",
  fields: [
    { name: "Id", type: "id", sortable: true },
    { name: "Name", type: "string", label: "Account Name", sortable: true },
    { name: "Industry", type: "picklist", picklistValues: ["Banking", "Retail"] },
  ],
  childRelationships: [],
};

describe("virtual workbench buffers (asfx-buffer: scheme)", function () {
  this.timeout(20000);
  let child: cp.ChildProcess;
  let conn: any;
  let root: string;
  const hostUris: string[] = [];
  const published: { uri: string; diagnostics: unknown[] }[] = [];

  before(async () => {
    const serverPath = path.join(__dirname, "..", "server.js");
    assert.ok(fs.existsSync(serverPath), "out/server.js must be built (run npm run compile)");
    child = cp.spawn("node", [serverPath, "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
    conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout!), new rpc.StreamMessageWriter(child.stdin!));
    conn.onRequest("sfx/objectList", (p: { uri?: string }) => { if (p?.uri) hostUris.push(p.uri); return ["Account", "Contact"]; });
    conn.onRequest("sfx/describe", (p: { uri?: string; sobject: string }) => { if (p?.uri) hostUris.push(p.uri); return p.sobject === "Account" ? ACCOUNT : null; });
    conn.onRequest("sfx/describeMany", (p: { names: string[] }) => p.names.map((n) => (n === "Account" ? ACCOUNT : null)));
    conn.onRequest("sfx/projectInfo", () => ({ namespace: null }));
    conn.onRequest("sfx/objectInfo", () => ({ description: null }));
    conn.onNotification("textDocument/publishDiagnostics", (p: { uri: string; diagnostics: unknown[] }) => { published.push(p); });
    conn.listen();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-vbuf-"));
    await conn.sendRequest("initialize", { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: {}, initializationOptions: { apexFeatures: true } });
    await conn.sendNotification("initialized", {});
  });

  after(() => {
    try { conn?.dispose(); } catch { /* ignore */ }
    try { child?.kill(); } catch { /* ignore */ }
  });

  /** The bridge's virtual URI: the historic buffer file path on the asfx-buffer scheme. */
  const vuri = (rel: string) => pathToFileURL(path.join(root, rel)).href.replace(/^file:/, "asfx-buffer:");

  it("serves SOQL completion for a virtual soql buffer and the host sees the buffer path", async () => {
    const uri = vuri(".vscode/workbench-soql-buffer.soql");
    await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "soql", version: 1, text: "SELECT  FROM Account" } });
    const res = await conn.sendRequest("textDocument/completion", { textDocument: { uri }, position: { line: 0, character: 7 }, context: { triggerKind: 1 } });
    const wire = completionToWire(res, { position: { line: 0, character: 7 } });
    const labels = wire.items.map((i) => (typeof i.label === "string" ? i.label : i.label.label));
    assert.ok(labels.includes("Name") && labels.includes("Industry"), labels.join(","));
    assert.ok(hostUris.includes(uri), "schema requests carry the virtual URI (host resolves org by its fsPath)");
  });

  it("never publishes non-empty diagnostics for asfx-buffer documents", async () => {
    const uri = vuri(".vscode/anon-workbench-buffer-diag.apex");
    await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version: 1, text: "Account a = new Account(;\nfoo bar baz" } });
    await conn.sendNotification("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: "Account a = new Account(;\na.NoSuchField__c = 1;" }] });
    await new Promise((r) => setTimeout(r, 1200)); // past the 300ms schema-validation debounce
    const bad = published.filter((p) => p.uri === uri && p.diagnostics.length > 0);
    assert.strictEqual(bad.length, 0, JSON.stringify(bad));
    await conn.sendNotification("textDocument/didClose", { textDocument: { uri } });
  });

  it("serves Apex completion after 20 full-text didChange edits without duplicate labels", async () => {
    const uri = vuri(".vscode/anon-workbench-buffer.apex");
    let version = 1;
    await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version, text: "" } });
    const base = "Account acc = new Account();\nacc.";
    for (let i = 0; i < 20; i++) {
      const text = base + "Name".slice(0, i % 3);
      await conn.sendNotification("textDocument/didChange", { textDocument: { uri, version: ++version }, contentChanges: [{ text }] });
      const character = 4 + (i % 3);
      const res = await conn.sendRequest("textDocument/completion", { textDocument: { uri }, position: { line: 1, character }, context: { triggerKind: i % 3 ? 3 : 2, triggerCharacter: i % 3 ? undefined : "." } });
      const wire = completionToWire(res, { position: { line: 1, character } });
      const labels = wire.items.map((it) => (typeof it.label === "string" ? it.label : it.label.label));
      assert.ok(labels.includes("Name"), `edit ${i}: ${labels.slice(0, 10).join(",")}`);
      assert.strictEqual(new Set(labels).size, labels.length, `edit ${i}: duplicate labels`);
    }
  });

  it("hovers and resolves in-buffer definitions to the virtual URI", async () => {
    const uri = vuri(".vscode/anon-workbench-buffer-2.apex");
    const text = "public class Inner { }\nInner x = new Inner();\nAccount a = new Account();\na.Name = 'x';";
    await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version: 1, text } });
    const hover = hoverToWire(await conn.sendRequest("textDocument/hover", { textDocument: { uri }, position: { line: 3, character: 3 } }));
    assert.ok(hover && hover.contents.join("\n").includes("Name"), JSON.stringify(hover));
    const def = definitionTargets(await conn.sendRequest("textDocument/definition", { textDocument: { uri }, position: { line: 1, character: 2 } }));
    assert.ok(def.length, "definition found");
    assert.strictEqual(String(def[0].uri), uri, "in-buffer definition points at the virtual buffer");
    assert.strictEqual(def[0].range.start.line, 0);
    await conn.sendNotification("textDocument/didClose", { textDocument: { uri } });
  });
});
