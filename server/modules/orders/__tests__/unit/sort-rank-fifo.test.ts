import { describe, expect, it } from "vitest";
import { computeSortRank } from "../../sort-rank";

describe("computeSortRank — FIFO within the same day", () => {
  const SAME_DAY_MORNING = new Date("2025-05-30T10:00:00Z");
  const SAME_DAY_AFTERNOON = new Date("2025-05-30T14:00:00Z");
  const SAME_DAY_EVENING = new Date("2025-05-30T17:00:00Z");
  const SLA_DEADLINE = new Date("2025-06-04T17:00:00Z");

  it("older order ranks above newer order (same priority, same SLA deadline)", () => {
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
    expect(early > late).toBe(true);
  });

  it("three same-day orders sort oldest-first (FIFO)", () => {
    const ranks = [SAME_DAY_MORNING, SAME_DAY_AFTERNOON, SAME_DAY_EVENING].map(
      (placed) =>
        computeSortRank({
          priority: 100,
          onHold: false,
          slaDueAt: SLA_DEADLINE,
          orderPlacedAt: placed,
        }),
    );
    const sorted = [...ranks].sort().reverse();
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

  it("earlier SLA deadline produces higher S component (more urgent)", () => {
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
    expect(Number(urgent) > Number(relaxed)).toBe(true);
  });

  it("expedited order sorts before standard even when placed later", () => {
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
    expect(expedited > standard).toBe(true);
  });

  it("null orderPlacedAt gives maximum age (sorts first as tiebreaker)", () => {
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

  it("null slaDueAt gives minimum urgency (sorts last within same priority)", () => {
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
    expect(withSla > noSla).toBe(true);
  });
});
