import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Keep stable required-check identities while their work runs in parallel.
 * A missing, skipped, cancelled, or newly unaccounted-for job cannot pass.
 * @param {unknown} jobs GitHub's toJSON(needs) value.
 * @param {readonly string[]} expectedJobs Explicit dependency identities.
 */
export function requireSuccessfulJobs(jobs, expectedJobs) {
  if (!Array.isArray(expectedJobs) || !expectedJobs.length
    || expectedJobs.some((job) => typeof job !== "string" || !/^[a-z][a-z0-9-]{0,100}$/.test(job))
    || new Set(expectedJobs).size !== expectedJobs.length) {
    throw new Error("Expected CI jobs must be a nonempty, unique list of job identities.");
  }
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    throw new Error("CI dependency results must be an object.");
  }
  const actualJobs = Object.keys(jobs);
  if (actualJobs.length !== expectedJobs.length || expectedJobs.some((job) => !Object.hasOwn(jobs, job))) {
    throw new Error("CI dependency identities do not match the required jobs.");
  }
  const failures = expectedJobs.filter((job) => {
    const value = jobs[job];
    return !value || typeof value !== "object" || Array.isArray(value)
      || !Object.hasOwn(value, "result") || value.result !== "success";
  });
  if (failures.length) {
    throw new Error("CI jobs did not all succeed: " + failures.join(", "));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    let jobs;
    try {
      jobs = JSON.parse(process.env.CI_NEEDS ?? "null");
    } catch {
      throw new Error("CI_NEEDS must contain valid JSON dependency results.");
    }
    requireSuccessfulJobs(jobs, process.argv.slice(2));
  } catch (error) {
    console.error("::error::" + (error instanceof Error ? error.message : "Invalid CI dependency results."));
    process.exitCode = 1;
  }
}
