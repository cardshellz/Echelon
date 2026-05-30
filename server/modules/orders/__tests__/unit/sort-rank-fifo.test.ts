import { describe, expect, it } from "vitest";
import { computeSortRank } from "../../sort-rank";

/**
 * Sort rank is ASC-sorted: lower value = higher priority.
 * ShipStation customField1 and pick queue both sort ASC.
 */
describe("computeSortRank — ASC ordering (lower = higher priority)", () => {
  const SAME_DAY_MORNING = new Date("2025-05-30T10:00:00Z");
  const SAME_DAY_AFTERNOON = new Date("2025-05-30T14:00:00Z");
  const SAME_DAY_EVENING = new Date("2025-05-30T17:00:00Z");
  const SLA_DEADLINE = new Date("2025-06-04T17:00:00Z");

  it("older order ranks above newer order — lower sort_rank (same priority, same SLA)", () => {
    const early = computeSortRank({
      priority: 100,
      onHold: false,
      slaDueAt: SLA_DEADLINE,
      orderPlacedAt: SAME_DAY_MORNING,
    });
    const late = computeSortRank({
      priority: 100,
      onHold: false,
      slaDueAt: SLA_DEADLINE,
      orderPlacedAt: SAME_DAY_AFTERNOON,
    });
    expect(early < late).toBe(true);
  });

  it("three same-day orders sort oldest-first (FIFO) in ASC", () => {
    const ranks = [SAME_DAY_MORNING, SAME_DAY_AFTERNOON, SAME_DAY_EVENING].map(
      (placed) =>
        computeSortRank({
          priority: 100,
          onHold: false,
          slaDueAt: SLA_DEADLINE,
          orderPlacedAt: placed,
        }),
    );
    const sorted = [...ranks].sort();
    expect(ranks).toEqual(sorted);
  });

  it("same SLA deadline produces identical S component regardless of placement time", () => {
    const earlyParts = computeSortRank({
      priority: 100,
      onHold: false,
      slaDueAt: SLA_DEADLINE,
      orderPlacedAt: SAME_DAY_MORNING,
    }).split("-");
    const lateParts = computeSortRank({
      priority: 100,
      onHold: false,
      slaDueAt: SLA_DEADLINE,
      orderPlacedAt: SAME_DAY_EVENING,
    }).split("-");
    expect(earlyParts[3]).toBe(lateParts[3]);
  });

  it("earlier SLA deadline produces lower S component (more urgent, sorts first)", () => {
    const urgentSla = new Date("2025-06-02T17:00:00Z");
    const relaxedSla = new Date("2025-06-05T17:00:00Z");
    const urgent = computeSortRank({
      priority: 100,
      onHold: false,
      slaDueAt: urgentSla,
      orderPlacedAt: SAME_DAY_MORNING,
    }).split("-")[3];
    const relaxed = computeSortRank({
      priority: 100,
      onHold: false,
      slaDueAt: relaxedSla,
      orderPlacedAt: SAME_DAY_MORNING,
    }).split("-")[3];
    expect(Number(urgent) < Number(relaxed)).toBe(true);
  });

  it("expedited order sorts before standard — lower sort_rank even when placed later", () => {
    const standard = computeSortRank({
      priority: 100,
      onHold: false,
      slaDueAt: SLA_DEADLINE,
      orderPlacedAt: SAME_DAY_MORNING,
    });
    const expedited = computeSortRank({
      priority: 300,
      onHold: false,
      slaDueAt: SLA_DEADLINE,
      orderPlacedAt: SAME_DAY_AFTERNOON,
    });
    expect(expedited < standard).toBe(true);
  });

  it("null orderPlacedAt sorts last (AGE_MAX)", () => {
    const noPlacement = computeSortRank({
      priority: 100,
      onHold: false,
      slaDueAt: SLA_DEADLINE,
      orderPlacedAt: null,
    });
    const withPlacement = computeSortRank({
      priority: 100,
      onHold: false,
      slaDueAt: SLA_DEADLINE,
      orderPlacedAt: SAME_DAY_MORNING,
    });
    expect(noPlacement > withPlacement).toBe(true);
  });

  it("null slaDueAt sorts last (SLA_MAX)", () => {
    const withSla = computeSortRank({
      priority: 100,
      onHold: false,
      slaDueAt: SLA_DEADLINE,
      orderPlacedAt: SAME_DAY_MORNING,
    });
    const noSla = computeSortRank({
      priority: 100,
      onHold: false,
      slaDueAt: null,
      orderPlacedAt: SAME_DAY_MORNING,
    });
    expect(withSla < noSla).toBe(true);
  });

  it("on-hold orders sort after non-held orders", () => {
    const held = computeSortRank({
      priority: 100,
      onHold: true,
      slaDueAt: SLA_DEADLINE,
      orderPlacedAt: SAME_DAY_MORNING,
    });
    const notHeld = computeSortRank({
      priority: 100,
      onHold: false,
      slaDueAt: SLA_DEADLINE,
      orderPlacedAt: SAME_DAY_MORNING,
    });
    expect(held > notHeld).toBe(true);
  });

  it("bumped order (priority 9999) sorts first in ASC", () => {
    const bumped = computeSortRank({
      priority: 9999,
      onHold: false,
      slaDueAt: SLA_DEADLINE,
      orderPlacedAt: SAME_DAY_AFTERNOON,
    });
    const standard = computeSortRank({
      priority: 100,
      onHold: false,
      slaDueAt: SLA_DEADLINE,
      orderPlacedAt: SAME_DAY_MORNING,
    });
    expect(bumped < standard).toBe(true);
  });
});
