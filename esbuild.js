// Bundles the extension into a single file for fast activation.
// Without bundling, VS Code synchronously require()s ~60 separate modules on
// activation, which noticeably delays the sidebar/icon. One bundle fixes that.
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function main() {
  const extensionCtx = await esbuild.context({
    ...shared,
    entryPoints: ["src/extension.ts"],
    // Overwrite the tsc-emitted entry with a single bundled file. tsc still emits
    // all the other out/ modules (used by the test runner); only the runtime
    // entry (main = ./out/extension.js) becomes the fast single-file bundle.
    outfile: "out/extension.js",
    external: ["vscode"], // provided by the VS Code runtime
  });

  // Language server: a standalone Node process spawned by the extension. Bundles
  // @salesforce/soql-language-server + @apexdevtools/apex-parser + vscode-languageserver
  // into one file. apex-parser's antlr4 dependency uses `import.meta.url` +
  // createRequire(); shim it to the bundle path so it works in the CJS output.
  const serverCtx = await esbuild.context({
    ...shared,
    entryPoints: ["server/src/server.ts"],
    outfile: "out/server.js",
    banner: {
      js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;",
    },
    define: {
      "import.meta.url": "__importMetaUrl",
    },
  });

  if (watch) {
    await Promise.all([extensionCtx.watch(), serverCtx.watch()]);
  } else {
    await Promise.all([extensionCtx.rebuild(), serverCtx.rebuild()]);
    await Promise.all([extensionCtx.dispose(), serverCtx.dispose()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
