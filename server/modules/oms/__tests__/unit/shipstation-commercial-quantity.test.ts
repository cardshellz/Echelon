import { describe, expect, it } from "vitest";

import {
  partitionCommercialRequestedQuantity,
  ShipStationCommercialQuantityError,
} from "../../shipstation-commercial-quantity.domain";

describe("ShipStation split commercial quantity", () => {
  it("preserves nullable historical authority for an unchanged physical split", () => {
    expect(partitionCommercialRequestedQuantity({
      sourceQuantity: 2, splitQuantity: 1, commercialRequestedQuantity: null,
    })).toEqual({ childQuantity: null, retainedQuantity: null });
  });

  it.each([
    { requested: 0, child: 0, retained: 0 },
    { requested: 1, child: 1, retained: 0 },
    { requested: 2, child: 1, retained: 1 },
  ])("conserves $requested authorized units across a partial physical split", ({ requested, child, retained }) => {
    expect(partitionCommercialRequestedQuantity({
      sourceQuantity: 2, splitQuantity: 1, commercialRequestedQuantity: requested,
    })).toEqual({ childQuantity: child, retainedQuantity: retained });
  });

  it.each([NaN, -1, 3, 0.5])("rejects an invalid current commercial quantity %s", (commercialRequestedQuantity) => {
    expect(() => partitionCommercialRequestedQuantity({
      sourceQuantity: 2, splitQuantity: 1, commercialRequestedQuantity,
    })).toThrow(ShipStationCommercialQuantityError);
  });
});
