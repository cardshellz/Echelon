import { describe, it, expect } from "vitest";
import { resolvePackingFulfillmentChannel } from "../../domain/fulfillment-channel";

const base = {
  source: "manual",
  channelName: null,
  channelType: null,
  channelProvider: null,
  shippingConfig: null,
};
describe("packing fulfillment channel", () => {
  it("recognizes accepted Dropship OMS orders without optional markers", () => {
    expect(
      resolvePackingFulfillmentChannel({
        ...base,
        channelName: "Dropship OMS",
        channelType: "internal",
        channelProvider: "manual",
      }),
    ).toBe("dropship");
  });
  it.each([
    { dropship: { role: "OMS" } },
    { dropship: { omsChannel: true } },
    { dropship: { omsChannel: "true" } },
  ])("honors explicit Dropship markers", (shippingConfig) => {
    expect(
      resolvePackingFulfillmentChannel({
        ...base,
        source: "ebay",
        shippingConfig,
      }),
    ).toBe("dropship");
  });
  it("does not identify an unrelated marketplace store by its display name", () => {
    expect(
      resolvePackingFulfillmentChannel({
        ...base,
        source: "ebay",
        channelName: "Dropship OMS",
        channelType: "marketplace",
        channelProvider: "ebay",
      }),
    ).toBe("ebay");
  });
  it.each(["shopify", "ebay"] as const)("keeps %s separate", (source) =>
    expect(resolvePackingFulfillmentChannel({ ...base, source })).toBe(source),
  );
  it("uses the internal profile for an unmarked manual order", () =>
    expect(resolvePackingFulfillmentChannel(base)).toBe("internal"));
});
