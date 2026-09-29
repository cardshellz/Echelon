import { describe, expect, it } from "vitest";
import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";
import { acceptedDemandQuantitiesMatch } from "../../domain/inventory-cutover-accepted-demand";
import { reconstructionEvidence } from "../fixtures/inventory-cutover-reconstruction.fixture";

function fixture(authorizedQty: string, fulfilledQuantity: number, materializedQty = "6") {
  const items = [{ ...reconstructionEvidence().items[0], fulfilledQuantity }];
  const demand: CutoverReconstructionEvidence["acceptedOmsDemand"][number] = {
    lineId: "11", orderId: "9", productVariantId: 101, sku: "P5", authorizationStatus: "authorized",
    authorizedQty, materializedQty,
  };
  return { demand, items };
}

describe("accepted cutover quantity coverage", () => {
  it.each([["6", 0], ["6", 2], ["4", 2], ["0", 6]] as const)(
    "accepts authority %s with %s fulfilled without altering original rows", (authorized, fulfilled) => {
      const { demand, items } = fixture(authorized, fulfilled);
      const before = structuredClone({ demand, items });
      expect(acceptedDemandQuantitiesMatch(demand, items)).toBe(true);
      expect({ demand, items }).toEqual(before);
    });
  it.each([["0", 0], ["3", 2], ["5", 2], ["7", 0], ["6", -1], ["6", 7]] as const)(
    "rejects unexplained authority/progress %s/%s", (authorized, fulfilled) => {
      const { demand, items } = fixture(authorized, fulfilled);
      expect(acceptedDemandQuantitiesMatch(demand, items)).toBe(false);
    });
  it("requires the complete original materialization", () => {
    const { demand, items } = fixture("4", 2, "4");
    expect(acceptedDemandQuantitiesMatch(demand, items)).toBe(false);
  });
  it("does not mistake missing or zero original demand for fulfilled coverage", () => {
    const { demand, items } = fixture("0", 0, "0");
    expect(acceptedDemandQuantitiesMatch(demand, [])).toBe(false);
    expect(acceptedDemandQuantitiesMatch(demand, [{ ...items[0], quantity: 0 }])).toBe(false);
  });
  it("exhausts multiple WMS owners without duplicating their original or remaining demand", () => {
    const { demand, items } = fixture("4", 1);
    const split = [{ ...items[0], quantity: 3 }, { ...items[0], id: 12, quantity: 3 }];
    expect(acceptedDemandQuantitiesMatch(demand, split)).toBe(true);
    expect(acceptedDemandQuantitiesMatch(demand, [...split, { ...split[0], id: 13 }])).toBe(false);
  });
});
