import { afterEach, describe, expect, it, vi } from "vitest";
import { saveProductAssetScope } from "../product-asset-scope";

const attempt = { assetId: 2, command: { productVariantId: null, expectedProductVariantId: 10 }, idempotencyKey: "photo-command-123" };
afterEach(() => vi.unstubAllGlobals());

describe("photo assignment request and outcome", () => {
  it("uses the caller's stable key and exact observed scope", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ productId: 1, assetId: 2, productVariantId: null, changed: true }));
    vi.stubGlobal("fetch", fetch);
    await saveProductAssetScope(1, attempt);
    expect(fetch).toHaveBeenCalledWith("/api/products/1/assets/2/scope", expect.objectContaining({
      method: "PUT", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.idempotencyKey },
      body: JSON.stringify(attempt.command),
    }));
  });
  it.each([
    [409, "ASSET_SCOPE_CHANGED", "rejected"], [403, "FORBIDDEN", "rejected"],
    [422, "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED", "rejected"],
    [409, "FINANCIAL_COMMAND_IN_PROGRESS", "unconfirmed"], [409, "FINANCIAL_COMMAND_STALE_OWNER", "unconfirmed"],
    [500, "ASSET_SCOPE_SAVE_FAILED", "unconfirmed"],
  ])("classifies HTTP %s %s as %s", async (status, code, outcome) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code, error: "Safe explanation" }, { status })));
    await expect(saveProductAssetScope(1, attempt)).rejects.toMatchObject({ message: "Safe explanation", outcome });
  });
  it("retains uncertainty when the response is lost", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network failed")));
    await expect(saveProductAssetScope(1, attempt)).rejects.toMatchObject({ outcome: "unconfirmed" });
  });
  it.each([null, {}, { productId: 2, assetId: 2, productVariantId: null, changed: true },
    { productId: 1, assetId: 3, productVariantId: null, changed: true },
    { productId: 1, assetId: 2, productVariantId: 11, changed: true },
  ])("does not claim success for an unverified response %j", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(saveProductAssetScope(1, attempt)).rejects.toMatchObject({ outcome: "unconfirmed" });
  });
});
