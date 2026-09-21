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
  const { writers: currentIncludingScripts } = scanWriterTopology(repoRoot, {
    roots: ["server", "scripts"],
  });

  it("wms.order_items has exactly one owning writer across runtime and operational scripts", () => {
    expect(current["wms.order_items"]).toEqual(["modules/wms"]);
    expect(currentIncludingScripts["wms.order_items"]).toEqual(["modules/wms"]);
    expect(baseline["wms.order_items"]).toEqual(["modules/wms"]);
  });

  it("the Archon order outbox has only the OMS owning writer, including operational scripts", () => {
    expect(current["oms.archon_order_outbox"]).toEqual(["modules/oms"]);
    expect(currentIncludingScripts["oms.archon_order_outbox"]).toEqual(["modules/oms"]);
    expect(baseline["oms.archon_order_outbox"]).toEqual(["modules/oms"]);
  });

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

  it("keeps Walmart connection writes in channels and order reconciliation writes in OMS", () => {
    for (const table of ["channels.walmart_connections", "channels.walmart_connection_events", "channels.walmart_order_receipts"]) {
      expect(current[table]).toEqual(["modules/channels"]);
    }
    for (const table of ["oms.oms_orders", "oms.oms_order_lines", "oms.oms_order_events"]) {
      expect(current[table]).toContain("modules/oms");
      expect(current[table]).not.toContain("modules/channels");
    }
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
