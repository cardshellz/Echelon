import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { scanWriterTopology } from "../../../scripts/writer-ratchet/scan";

/**
 * P2.1 — THE WRITER-RATCHET.
 *
 * The audit (ARCHITECTURE-AUDIT-2026-07.md) found 41 multi-writer tables and
 * 83 route-layer write sites — the root enabler of every double-writer bug
 * in the incident history. This test freezes the current writer topology as
 * the WORST it will ever be:
 *
 *  - A NEW (table ← writer) pair fails CI. Route the write through the
 *    owning module's API (see the ownership map in the audit §4.1). If a new
 *    writer is genuinely intended, regenerate the baseline in the same PR —
 *    the baseline diff is the review artifact.
 *  - A REMOVED pair also fails until the baseline is shrunk — so the
 *    baseline never rots and eliminated writers can't silently return.
 *
 *  Regenerate: npx tsx scripts/writer-ratchet/generate-baseline.ts
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

describe("writer-ratchet (P2.1)", () => {
  const baseline: Record<string, string[]> = JSON.parse(
    readFileSync(join(repoRoot, "scripts/writer-ratchet/baseline.json"), "utf8"),
  );
  const { writers: current } = scanWriterTopology(repoRoot);

  it("no table gains a writer that is not in the baseline", () => {
    const added: string[] = [];
    for (const [table, buckets] of Object.entries(current)) {
      const allowed = new Set(baseline[table] ?? []);
      for (const b of buckets) {
        if (!allowed.has(b)) added.push(`${table}  ←  ${b}`);
      }
    }
    expect(
      added,
      `NEW writer(s) detected outside the baseline. Writes belong in the table's ` +
        `owning module (ownership map: ARCHITECTURE-AUDIT-2026-07.md §4.1) — call its ` +
        `public API instead. If this new writer is genuinely intended and reviewed, ` +
        `regenerate the baseline in this PR:\n  npx tsx scripts/writer-ratchet/generate-baseline.ts\n\n` +
        added.join("\n"),
    ).toEqual([]);
  });

  it("eliminated writers are removed from the baseline (no rot)", () => {
    const stale: string[] = [];
    for (const [table, buckets] of Object.entries(baseline)) {
      const now = new Set(current[table] ?? []);
      for (const b of buckets) {
        if (!now.has(b)) stale.push(`${table}  ←  ${b}`);
      }
    }
    expect(
      stale,
      `Writer(s) eliminated — nice. Shrink the baseline in this PR so the ` +
        `improvement is locked in:\n  npx tsx scripts/writer-ratchet/generate-baseline.ts\n\n` +
        stale.join("\n"),
    ).toEqual([]);
  });
});
