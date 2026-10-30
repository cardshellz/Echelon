import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { requireSelectedSuccess } from "./require-selected-success.mjs";

export function requireReturnsSuccess(needs) {
  const expected = ["browser-shard", "preflight", "workflow-acceptance"];
  if (!needs || typeof needs !== "object" || Array.isArray(needs)
    || Object.keys(needs).sort().join(",") !== expected.join(",")) throw new Error("Unexpected returns acceptance dependencies.");
  for (const job of ["browser-shard", "workflow-acceptance"])
    requireSelectedSuccess({ preflight: needs.preflight, [job]: needs[job] }, job);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { requireReturnsSuccess(JSON.parse(process.env.CI_NEEDS ?? "null")); }
  catch (error) { console.error("::error::" + (error instanceof Error ? error.message : "Return acceptance results are invalid.")); process.exitCode = 1; }
}
