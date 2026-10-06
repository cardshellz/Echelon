import { describe, expect, it } from "vitest";
import { returnCommandRequestSchema, returnCommandResultFor, returnCommandResultSchema } from "../../return-command";

const body = { orderId: 61, warehouseLocationId: 30,
  items: [{ orderItemId: 71, productVariantId: 101, qty: 1, condition: "sellable" as const }] };
const result = { orderId: 61, processed: 1, sellable: 1, damaged: 0, totalBaseUnitsReturned: 5,
  items: [{ ...body.items[0], baseUnitsReturned: 5 }] };

describe("physical return request boundary", () => {
  it.each([body, { ...body, commandKey: "inventory:retained-return" }])("retains optional-key client compatibility", request => {
    expect(returnCommandRequestSchema.parse(request)).toEqual(request);
  });
  it.each([
    null, [], { ...body, commandKey: "" }, { ...body, commandKey: " key" },
    { ...body, commandKey: 42 }, { ...body, commandKey: "x".repeat(121) },
    { ...body, items: [body.items[0], body.items[0]] }, { ...body, unknownField: true },
  ])("rejects malformed requests before physical work", request => {
    expect(returnCommandRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("physical return acknowledgement", () => {
  it("accepts an exact response for the original command", () => {
    expect(returnCommandResultFor(body).parse(result)).toEqual(result);
  });
  it.each([
    { ...result, processed: 0 }, { ...result, sellable: 0 }, { ...result, damaged: 1 },
    { ...result, totalBaseUnitsReturned: 4 }, { ...result, items: [] },
    { ...result, processed: 2, sellable: 2, totalBaseUnitsReturned: 10, items: [result.items[0], result.items[0]] },
  ])("rejects an inconsistent numeric success summary", invalid => {
    expect(returnCommandResultSchema.safeParse(invalid).success).toBe(false);
  });
  it.each([
    { ...result, orderId: 62 },
    { ...result, items: [{ ...result.items[0], orderItemId: 72 }] },
    { ...result, items: [{ ...result.items[0], productVariantId: 102 }] },
    { ...result, items: [{ ...result.items[0], qty: 2 }] },
    { ...result, sellable: 0, damaged: 1, items: [{ ...result.items[0], condition: "damaged" }] },
  ])("retains the command when a valid-shaped response identifies different physical work", invalid => {
    expect(returnCommandResultFor(body).safeParse(invalid).success).toBe(false);
  });
});
