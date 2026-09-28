/** Throws unless the exact expected set of GitHub jobs all succeeded. */
export function requireSuccessfulJobs(jobs: unknown, expectedJobs: readonly string[]): void;
