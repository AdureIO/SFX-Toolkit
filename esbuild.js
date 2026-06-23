// Bundles the extension into a single file for fast activation.
// Without bundling, VS Code synchronously require()s ~60 separate modules on
// activation, which noticeably delays the sidebar/icon. One bundle fixes that.
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    // Overwrite the tsc-emitted entry with a single bundled file. tsc still emits
    // all the other out/ modules (used by the test runner); only the runtime
    // entry (main = ./out/extension.js) becomes the fast single-file bundle.
    outfile: "out/extension.js",
    external: ["vscode"], // provided by the VS Code runtime
    sourcemap: !production,
    minify: production,
    logLevel: "info"
  });

  // Webview bundle: the Object Visualizer's graph script (Cytoscape + dagre + svg)
  // is bundled to a single self-contained IIFE loaded via webview.asWebviewUri.
  // This is NOT externalized — the browser context has no module loader. The
  // extension bundle never imports cytoscape, so out/extension.js stays small.
  const webviewCtx = await esbuild.context({
    entryPoints: ["src/webview/objectVisualizer.ts"],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    outfile: "resources/webview/objectVisualizer.js",
    sourcemap: !production,
    minify: production,
    logLevel: "info"
  });

  if (watch) {
    await Promise.all([ctx.watch(), webviewCtx.watch()]);
  } else {
    await Promise.all([ctx.rebuild(), webviewCtx.rebuild()]);
    await Promise.all([ctx.dispose(), webviewCtx.dispose()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
