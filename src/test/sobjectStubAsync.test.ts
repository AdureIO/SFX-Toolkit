/**
 * Direct module test for server/src/sobjectStub.ts (outside the tsc rootDir, so it is
 * transpiled on the fly): concurrent lookups of a missing stub share one write, and a
 * clearStubs() racing an in-flight write does not resurrect the cache entry.
 */
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ts = require("typescript");

function loadModule(): any {
  const src = path.join(__dirname, "..", "..", "server", "src", "sobjectStub.ts");
  const out = ts.transpileModule(fs.readFileSync(src, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-stubmod-"));
  const file = path.join(dir, "sobjectStub.js");
  fs.writeFileSync(file, out.outputText);
  return require(file);
}

const DESCRIBE = { name: "Widget__c", label: "Widget", fields: [{ name: "Id", type: "id" }, { name: "Size__c", type: "double" }], childRelationships: [] };

describe("sobjectStub (async generation)", () => {
  let mod: any;
  let root: string;
  const realWrite = fs.promises.writeFile;
  let writes = 0;
  let gate: Promise<void> | null = null;

  beforeEach(() => {
    mod = loadModule();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-stubroot-"));
    mod.setStubRoot(root);
    writes = 0;
    gate = null;
    (fs.promises as any).writeFile = async (...a: unknown[]) => {
      writes++;
      if (gate) await gate;
      return (realWrite as any)(...a);
    };
  });
  afterEach(() => {
    (fs.promises as any).writeFile = realWrite;
  });

  it("dedupes concurrent lookups into one write and resolves to the generated file", async () => {
    const [a, b] = await Promise.all([mod.getStub("Widget__c", DESCRIBE), mod.getStub("Widget__c", DESCRIBE)]);
    assert.strictEqual(writes, 1);
    assert.strictEqual(a, b);
    const file = path.join(root, ".sfdx", "tools", "sobjects", "customObjects", "Widget__c.cls");
    assert.ok(fs.existsSync(file));
    assert.strictEqual(a.uri, pathToFileURL(file).href);
    assert.ok(a.fieldLines.has("size__c"));
    // Cached now: no further write or read needed.
    assert.strictEqual(await mod.getStub("Widget__c", DESCRIBE), a);
    assert.strictEqual(writes, 1);
  });

  it("clearStubs during an in-flight write does not resurrect the cache entry", async () => {
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const first = mod.getStub("Widget__c", DESCRIBE);
    await new Promise((r) => setTimeout(r, 30)); // write is now blocked on the gate
    mod.clearStubs();
    release();
    await first;
    gate = null;
    // Not cached: the next lookup re-reads from disk (file exists, so no new write) and yields a fresh object.
    const second = await mod.getStub("Widget__c", DESCRIBE);
    assert.notStrictEqual(second, await first);
    assert.strictEqual(writes, 1);
  });
});
