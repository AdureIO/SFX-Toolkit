import * as path from "path";
import { runTests } from "@vscode/test-electron";

/**
 * Launches VS Code, loads this extension, and runs the full mocha suite (src/test/suite)
 * inside the real VS Code API — so tests whose modules transitively require `vscode`
 * (orgSafety, defaultOrg, shellEscape, …) run too, not just the vscode-free subset.
 */
async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // No workspace/other extensions — keep the harness deterministic.
      launchArgs: ["--disable-extensions"],
    });
  } catch (err) {
    console.error("Failed to run integration tests:", err);
    process.exit(1);
  }
}

main();
