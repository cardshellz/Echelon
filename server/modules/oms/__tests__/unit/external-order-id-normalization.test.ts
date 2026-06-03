import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeExternalOrderId } from "../../oms.service";

const OMS_SERVICE_SRC = readFileSync(
  resolve(__dirname, "../../oms.service.ts"),
  "utf8",
);
const SHOPIFY_BRIDGE_SRC = readFileSync(
  resolve(__dirname, "../../shopify-bridge.ts"),
  "utf8",
);

describe("normalizeExternalOrderId — converge bridge (GID) + webhook (numeric)", () => {
  it("strips the Shopify Order GID prefix to the bare numeric id", () => {
    expect(normalizeExternalOrderId("gid://shopify/Order/12011890671775")).toBe(
      "12011890671775",
    );
  });

  it("passes a bare numeric id through unchanged", () => {
    expect(normalizeExternalOrderId("12011890671775")).toBe("12011890671775");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeExternalOrderId("  12011890671775  ")).toBe("12011890671775");
  });

  it("leaves non-Shopify ids untouched", () => {
    expect(normalizeExternalOrderId("EBAY-123-456")).toBe("EBAY-123-456");
  });

  it("a GID and its numeric form normalize to the SAME dedup key", () => {
    const gid = normalizeExternalOrderId("gid://shopify/Order/55566123");
    const num = normalizeExternalOrderId("55566123");
    expect(gid).toBe(num);
  });
});

describe("ingestOrder applies the normalizer at the dedup chokepoint", () => {
  it("normalizes externalOrderIdRaw before insert", () => {
    expect(OMS_SERVICE_SRC).toMatch(
      /const externalOrderId = normalizeExternalOrderId\(externalOrderIdRaw\)/,
    );
  });
});

describe("backfillShopifyOrders dedup tolerates both id formats", () => {
  it("matches on the bare numeric id via split_part on both sides", () => {
    expect(SHOPIFY_BRIDGE_SRC).toMatch(
      /split_part\(oo\.external_order_id, '\/', -1\) = split_part\(so\.id, '\/', -1\)/,
    );
  });
});
