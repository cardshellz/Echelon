import { describe, expect, it } from "vitest";
import {
  calculateFungibleAtpBase,
  calculateFIFOConsumption,
  calculateLotPickableOnHand,
  calculateUnreservedLotOnHand,
} from "../../domain/inventory.domain";

describe("FIFO lot availability", () => {
  it("does not subtract picked or packed workflow counters from on-hand ATP", () => {
    expect(calculateFungibleAtpBase({
      onHand: 10,
      reserved: 2,
      picked: 7,
      packed: 5,
      backorder: 0,
    })).toBe(8);
  });

  it("does not subtract previously picked units from remaining on-hand", () => {
    const lot = { qtyOnHand: 4, qtyReserved: 0, qtyPicked: 4 };

    expect(calculateUnreservedLotOnHand(lot)).toBe(4);
    expect(calculateLotPickableOnHand(lot, false)).toBe(4);
    expect(calculateFIFOConsumption([{
      lotId: 1,
      lotNumber: "LOT-001",
      unitCostCents: 500,
      ...lot,
    }], 4)).toEqual({
      consumptions: [{
        lotId: 1,
        lotNumber: "LOT-001",
        qty: 4,
        unitCostCents: 500,
        totalCostCents: 2_000,
      }],
      unfundedQty: 0,
    });
  });

  it("protects reservations when the operation has no reservation authority", () => {
    const lot = { qtyOnHand: 4, qtyReserved: 3, qtyPicked: 99 };

    expect(calculateUnreservedLotOnHand(lot)).toBe(1);
    expect(calculateLotPickableOnHand(lot, false)).toBe(1);
    expect(calculateLotPickableOnHand(lot, true)).toBe(4);
  });

  it("clamps corrupt over-reservation instead of reporting negative availability", () => {
    expect(calculateUnreservedLotOnHand({ qtyOnHand: 2, qtyReserved: 5 })).toBe(0);
  });
});
