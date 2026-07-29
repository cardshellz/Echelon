const { spawnSync } = require("node:child_process");
const path = require("node:path");

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const script = path.join(__dirname, "fix-clr-barcode-mismatch.ts");
const result = spawnSync(
  npx,
  ["tsx", script, ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
