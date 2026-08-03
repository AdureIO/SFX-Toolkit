import * as path from "path";
// mocha/glob are loaded via require to avoid ESM/CJS interop friction in the test build.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Mocha = require("mocha");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const glob = require("glob");

/**
 * Entry point @vscode/test-electron calls inside the launched VS Code instance.
 * Collects every compiled `*.test.js` and runs them under mocha.
 */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", color: true, timeout: 20000 });
  const testsRoot = path.resolve(__dirname, ".."); // out/test

  return new Promise((resolve, reject) => {
    const files: string[] = glob.sync("**/*.test.js", { cwd: testsRoot });
    for (const f of files) mocha.addFile(path.resolve(testsRoot, f));
    try {
      mocha.run((failures: number) => (failures > 0 ? reject(new Error(`${failures} test(s) failed.`)) : resolve()));
    } catch (err) {
      reject(err);
    }
  });
}
