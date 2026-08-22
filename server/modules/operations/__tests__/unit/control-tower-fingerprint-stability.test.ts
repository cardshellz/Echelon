import { describe, expect, it } from "vitest";

import { inventoryIntegritySource } from "../../control-tower-v2.sources";

/**
 * The source fingerprint answers "is this the same problem as last run?", and a
 * difference makes the projector write a `changed` observation.
 *
 * `occurrence_count` is a sighting counter the audit increments on EVERY scan,
 * so hashing it guaranteed a different fingerprint every run for every open
 * finding. Each run then logged a `changed` observation whose evidence was
 * byte-identical to the one before it: measured in production at ~690k rows/day
 * (28,787 findings x 24 hourly runs), which grew
 * operations.control_tower_observations to 37 GB - 72% of the whole database,
 * 99.6% of it noise.
 *
 * The fingerprint must describe WHAT the problem is, never how often it has
 * been seen.
 */
const NOW = new Date("2026-08-22T12:00:00.000Z");

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 17004254,
  check_id: "terminal_order_open_reservation",
  entity_fingerprint: "d".repeat(64),
  category: "reservations",
  severity: "blocker",
  status: "open",
  entity_key: { order_id: 206385, order_item_id: 315852, product_variant_id: 107 },
  current_evidence: { sku: "GLV-MAG-130PT-P50", order_number: "#61153", open_reserved: "2" },
  current_metric: "2",
  first_seen_at: "2026-08-04T17:00:49.469Z",
  last_seen_at: "2026-08-22T02:01:08.370Z",
  last_changed_at: "2026-08-06T18:00:46.683Z",
  occurrence_count: 418,
  recurrence_count: 0,
  worsened_count: 0,
  updated_at: "2026-08-22T02:01:09.653Z",
  ...overrides,
});

describe("control tower fingerprint stability", () => {
  it("does not change when only the sighting counter advances", () => {
    const first = inventoryIntegritySource.projectRow(row({ occurrence_count: 418 }), NOW);
    const nextRun = inventoryIntegritySource.projectRow(row({ occurrence_count: 419 }), NOW);

    expect(nextRun.sourceFingerprint).toBe(first.sourceFingerprint);
    // the counter itself is still projected onto the item for the work-item row
    expect(first.occurrenceCount).toBe(418);
    expect(nextRun.occurrenceCount).toBe(419);
  });

  it("stays stable across many runs of an unchanged finding", () => {
    const prints = new Set(
      [418, 419, 420, 500, 1025].map(
        (n) => inventoryIntegritySource.projectRow(row({ occurrence_count: n }), NOW).sourceFingerprint,
      ),
    );
    expect(prints.size).toBe(1);
  });

  it("still changes when the evidence actually changes", () => {
    const before = inventoryIntegritySource.projectRow(row(), NOW);
    const after = inventoryIntegritySource.projectRow(
      row({ current_evidence: { sku: "GLV-MAG-130PT-P50", order_number: "#61153", open_reserved: "7" } }),
      NOW,
    );
    expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
  });

  it("still changes when severity changes", () => {
    const before = inventoryIntegritySource.projectRow(row(), NOW);
    const after = inventoryIntegritySource.projectRow(row({ severity: "high" }), NOW);
    expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
  });

  it("still changes when a real recurrence or worsening is recorded", () => {
    const before = inventoryIntegritySource.projectRow(row(), NOW);
    expect(
      inventoryIntegritySource.projectRow(row({ recurrence_count: 1 }), NOW).sourceFingerprint,
    ).not.toBe(before.sourceFingerprint);
    expect(
      inventoryIntegritySource.projectRow(row({ worsened_count: 1 }), NOW).sourceFingerprint,
    ).not.toBe(before.sourceFingerprint);
  });
});
