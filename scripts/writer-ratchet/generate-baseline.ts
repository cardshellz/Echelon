/**
 * P2.1 — regenerate the writer-topology baseline.
 *
 *   npx tsx scripts/writer-ratchet/generate-baseline.ts
 *
 * Run this ONLY when a change to the writer topology is intended and
 * reviewed (ideally shrinking it — moving a writer behind its owning
 * module's API). The diff of baseline.json IS the review artifact: every
 * added line is a new module writing a table it didn't write before.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanWriterTopology } from "./scan";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const { writers, unresolved } = scanWriterTopology(repoRoot);

writeFileSync(
  join(here, "baseline.json"),
  JSON.stringify(writers, null, 2) + "\n",
);

const tables = Object.keys(writers).length;
const multi = Object.values(writers).filter((w) => w.length > 1).length;
console.log(`baseline.json written: ${tables} tables, ${multi} multi-writer, ${unresolved.length} unresolved drizzle-ish calls (not gated)`);
