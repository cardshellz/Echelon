import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { requireSuccessfulJobs } from "./require-success.mjs";

/** Only a successful planner with an explicit empty plan may skip execution. */
export function requireSelectedSuccess(needs, executionJob) {
  if (!needs || typeof needs !== "object" || Array.isArray(needs)
      || Object.keys(needs).sort().join(",") !== ["preflight", executionJob].sort().join(","))
    throw new Error("Unexpected selected-check dependencies.");
  const preflight = needs.preflight;
  requireSuccessfulJobs({ preflight }, ["preflight"]);
  const run = preflight.outputs?.run;
  const matrix = JSON.parse(preflight.outputs?.matrix ?? "null");
  if (!matrix || !Array.isArray(matrix.include) || !["true", "false"].includes(run))
    throw new Error("Missing or invalid test selection evidence.");
  if (run === "false") {
    if (matrix.include.length !== 0 || needs[executionJob]?.result !== "skipped")
      throw new Error("A skipped suite requires an explicitly empty successful plan.");
    return;
  }
  if (matrix.include.length === 0) throw new Error("A requested suite cannot have an empty matrix.");
  requireSuccessfulJobs({ [executionJob]: needs[executionJob] }, [executionJob]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Expected one execution job.");
    requireSelectedSuccess(JSON.parse(process.env.CI_NEEDS ?? "null"), process.argv[2]);
  } catch (error) {
    console.error("::error::" + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
