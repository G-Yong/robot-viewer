// Build script for the Robot Viewer extension.
// Produces two bundles:
//   - dist/extension.js : the VS Code extension host (Node/CommonJS)
//   - dist/webview.js   : the 3D viewer that runs inside the webview (browser/IIFE)
const esbuild = require("esbuild");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: [path.join(__dirname, "src", "extension.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: path.join(__dirname, "dist", "extension.js"),
  external: ["vscode", "node-opcua-client"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: [path.join(__dirname, "webview", "main.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: path.join(__dirname, "dist", "webview.js"),
  sourcemap: !production,
  minify: production,
  loader: { ".css": "text" },
  logLevel: "info",
};

async function main() {
  const contexts = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);

  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    console.log("[esbuild] watching...");
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
    console.log("[esbuild] build complete");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
