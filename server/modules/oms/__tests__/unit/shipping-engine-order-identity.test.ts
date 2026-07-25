import { describe, expect, it } from "vitest";

import { resolveProviderOrderId } from "../../shipping-engine-order-identity";

const base = {
  legacyHeaderPolicy: "aggregate_projection" as const,
  persistedProviderOrderId: "765969910",
  persistedProviderOrderKey: "echelon-wms-shp-11729",
  incomingProviderOrderId: "766840931",
  incomingProviderOrderKey: "echelon-wms-shp-11729",
  incomingProviderOrderIdAlreadyAliased: false,
};

describe("shipping-engine provider order identity", () => {
  it("accepts a new provider order id alias only for the same stable order key", () => {
    expect(resolveProviderOrderId(base)).toBe("stable_key_alias");
  });

  it("rejects a different provider order id when stable order keys differ", () => {
    expect(resolveProviderOrderId({
      ...base,
      incomingProviderOrderKey: "echelon-wms-shp-99999",
    })).toBe("conflict");
  });

  it("keeps strict legacy header handling immutable", () => {
    expect(resolveProviderOrderId({
      ...base,
      legacyHeaderPolicy: "strict",
    })).toBe("conflict");
  });

  it("accepts an alias already bound to the canonical shipping-engine order", () => {
    expect(resolveProviderOrderId({
      ...base,
      legacyHeaderPolicy: "strict",
      incomingProviderOrderKey: null,
      incomingProviderOrderIdAlreadyAliased: true,
    })).toBe("known_alias");
  });

  it("accepts missing or unchanged optional provider order ids", () => {
    expect(resolveProviderOrderId({
      ...base,
      incomingProviderOrderId: "765969910",
    })).toBe("compatible");
    expect(resolveProviderOrderId({
      ...base,
      incomingProviderOrderId: null,
    })).toBe("compatible");
  });
});
