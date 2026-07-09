import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** P0.9 — retry discipline pins (dead-letter terminal, classification, claims). */
const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("P0.9 — retry discipline", () => {
  it("dead-letter rows block re-seeding everywhere (manual requeue only)", () => {
    const worker = read("../../webhook-retry.worker.ts");
    const recon = read("../../oms-flow-reconciliation.service.ts");
    expect(worker).toContain("AND status IN ('pending', 'dead')");
    const guards = recon.match(/status IN \('pending', 'dead'\)/g) ?? [];
    expect(guards.length).toBe(3);
    // no dedup anywhere may look at pending alone
    for (const src of [worker, recon]) {
      expect(src).not.toMatch(/AND (q\.)?status = 'pending'\n/);
    }
  });

  it("ShipStation 429/timeout/5xx classify as transient, not quarantine", () => {
    const idx = read("../../../../index.ts");
    expect(idx).toContain("isTransientError");
    expect(idx).not.toContain("isTransientDbError");
    expect(idx).toMatch(/\\b429\\b\|rate limit\|ETIMEDOUT/);
  });

  it("sync-recovery backfill never re-pushes review-flagged or held shipments", () => {
    const src = read("../../../sync/sync-recovery.service.ts");
    expect(src).toContain("AND COALESCE(requires_review, false) = false");
    expect(src).toContain("AND COALESCE(held, false) = false");
  });

  it("the retry worker claims batches atomically with FOR UPDATE SKIP LOCKED", () => {
    const worker = read("../../webhook-retry.worker.ts");
    expect(worker).toContain("FOR UPDATE SKIP LOCKED");
    expect(worker).toContain("SET next_retry_at = NOW() + INTERVAL '5 minutes'");
  });
});
