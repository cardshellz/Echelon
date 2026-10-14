import { readFileSync } from "node:fs";
import { z } from "zod";
import { MAX_POSTGRES_FILE_DURATION_MS, POSTGRES_TIMING_FILE_PATTERN } from "./postgres-shard-planner";

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const snapshotSchema = z.object({
  version: z.literal(1),
  metric: z.literal("vitest-duration-ms"),
  source: z.object({
    repository: z.literal("cardshellz/Echelon"),
    runId: positiveId,
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    conclusion: z.literal("success"),
    jobIds: z.array(positiveId).nonempty(),
  }).strict(),
  measurements: z.array(z.object({
    file: z.string().regex(POSTGRES_TIMING_FILE_PATTERN),
    durationMs: z.number().int().positive().max(MAX_POSTGRES_FILE_DURATION_MS),
    jobId: positiveId,
  }).strict()).nonempty(),
}).strict();

export type PostgresTimingSnapshot = z.infer<typeof snapshotSchema>;

export function parsePostgresTimingSnapshot(input: unknown): PostgresTimingSnapshot {
  const snapshot = snapshotSchema.parse(input);
  const jobs = new Set(snapshot.source.jobIds);
  if (jobs.size !== snapshot.source.jobIds.length) throw new Error("PostgreSQL timing provenance contains duplicate job identities.");
  if (new Set(snapshot.measurements.map((row) => row.file)).size !== snapshot.measurements.length) {
    throw new Error("PostgreSQL timing snapshot contains duplicate suite paths.");
  }
  if (snapshot.measurements.some((row) => !jobs.has(row.jobId))) {
    throw new Error("PostgreSQL timing measurement refers to an unrecorded source job.");
  }
  if (snapshot.source.jobIds.some((job) => !snapshot.measurements.some((row) => row.jobId === job))) {
    throw new Error("PostgreSQL timing source job has no measurements.");
  }
  return snapshot;
}

// Read one checked-in artifact, once. CI never fetches timings or selects files
// using a mutable cache; malformed evidence fails the existing fast guard.
export const POSTGRES_TIMING_SNAPSHOT = parsePostgresTimingSnapshot(
  JSON.parse(readFileSync(new URL("./postgres-test-timings.snapshot.json", import.meta.url), "utf8")),
);
export const POSTGRES_TEST_DURATION_MS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(POSTGRES_TIMING_SNAPSHOT.measurements.map((row) => [row.file, row.durationMs])),
);
