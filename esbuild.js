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
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
