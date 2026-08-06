import { describe, expect, it } from "vitest";
import {
  buildCells,
  fingerprint,
  isDrifting,
  summarize,
  validateSnapshot,
  type Snapshot,
} from "../remediate-lot-drift";

function makeSnapshot(): Snapshot {
  return {
    levels: [{
      id: 1,
      productVariantId: 10,
      warehouseLocationId: 20,
      qtyOnHand: 5,
      qtyReserved: 2,
      qtyPicked: 3,
    }],
    lots: [{
      id: 100,
      lotNumber: "LOT-OLD",
      productVariantId: 10,
      warehouseLocationId: 20,
      qtyOnHand: -1,
      qtyReserved: 0,
      qtyPicked: 0,
      qtyReceived: 2,
      qtyConsumed: 0,
      receivedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      notes: null,
    }, {
      id: 101,
      lotNumber: "LOT-NEW",
      productVariantId: 10,
      warehouseLocationId: 20,
      qtyOnHand: 8,
      qtyReserved: 4,
      qtyPicked: 7,
      qtyReceived: 10,
      qtyConsumed: 0,
      receivedAt: "2026-02-01T00:00:00.000Z",
      status: "active",
      notes: null,
    }],
    costs: new Map([[10, 500]]),
  };
}

describe("lot drift remediation planning", () => {
  it("clamps negative projection buckets before measuring repair quantities", () => {
    const snapshot = makeSnapshot();
    const cells = buildCells(snapshot);

    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      lotOnHand: 8,
      lotReserved: 4,
      lotPicked: 7,
      negativeLotBuckets: 1,
      levelOnHand: 5,
      levelReserved: 2,
      levelPicked: 3,
    });
    expect(isDrifting(cells[0])).toBe(true);
    expect(summarize(cells)).toMatchObject({
      candidateCells: 1,
      onHandUnitsToCreate: 0,
      onHandUnitsToDeplete: 3,
      reservedAbsoluteDrift: 2,
      pickedAbsoluteDrift: 4,
    });
  });

  it("fingerprints all candidate lot buckets and changes when the evidence changes", () => {
    const snapshot = makeSnapshot();
    const first = fingerprint(buildCells(snapshot));
    snapshot.lots[1].qtyPicked += 1;
    const second = fingerprint(buildCells(snapshot));

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });

  it("refuses invalid physical targets and negative receipt history", () => {
    const invalidLevel = makeSnapshot();
    invalidLevel.levels[0].qtyReserved = 6;
    expect(() => validateSnapshot(invalidLevel, buildCells(invalidLevel)))
      .toThrow("invalid target buckets");

    const invalidHistory = makeSnapshot();
    invalidHistory.lots[0].qtyReceived = -1;
    expect(() => validateSnapshot(invalidHistory, buildCells(invalidHistory)))
      .toThrow("negative received/consumed history");
  });
});
