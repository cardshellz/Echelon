import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { sendShopifyProductSyncFailure } from "../../routes/shopify-product-sync.response";

function response() {
  const result = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  result.status.mockReturnValue(result); return result;
}
describe("Shopify catalog sync failure response", () => {
  it("reports an exhausted nested selection conflict as retryable and honest about earlier commits", () => {
    const res = response();
    sendShopifyProductSyncFailure(res as unknown as Response, new Error("private SQL", { cause: { code: "55P03", message: "PUBLICATION_SELECTION_BUSY" } }));
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "2"); expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "PUBLICATION_SELECTION_BUSY", retryable: true, partialChangesPossible: true }));
    expect(JSON.stringify(res.json.mock.calls)).not.toContain("private SQL");
  });
  it("does not misclassify unrelated failures or expose provider/SQL diagnostics", () => {
    const res = response(); const log = vi.spyOn(console,"error").mockImplementation(() => undefined);
    try {
      sendShopifyProductSyncFailure(res as unknown as Response, new Error("private-token and SQL"));
      expect(res.status).toHaveBeenCalledWith(500); expect(JSON.stringify(res.json.mock.calls)).not.toContain("private-token");
      expect(res.setHeader).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
