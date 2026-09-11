// Runs the offline IK check: bundles tools/ikCheck.ts for node and executes it.
//
// Kept as a script (rather than a shell chain in package.json) so that a
// bundling failure - e.g. the solver module not existing yet - fails the whole
// npm script instead of being swallowed and leaving node to report the
// confusing "Cannot find module dist/ikCheck.cjs" afterwards.
const esbuild = require("esbuild");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

async function main() {
  const outfile = path.join(__dirname, "..", "dist", "ikCheck.cjs");

  await esbuild.build({
    entryPoints: [path.join(__dirname, "ikCheck.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    outfile,
    logLevel: "warning",
  });

  const result = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
