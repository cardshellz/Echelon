import { describe, expect, it } from "vitest";
import { packingOrderSelection } from "../../packing-order-selection";
describe("packing handoff deep link", () => {
  it("selects a valid order ID", () => { expect(packingOrderSelection("?orderId=70")).toBe(70); });
  it.each(["", "?orderId=0", "?orderId=-1", "?orderId=1e2", "?orderId=1.2", "?orderId=2147483648", "?orderId=70junk"])("rejects malformed %s", (query) => {
    expect(packingOrderSelection(query)).toBeNull();
  });
});
