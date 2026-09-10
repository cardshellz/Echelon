import { describe, expect, it, vi } from "vitest";
import { assertLegacyQuantityImportAllowed } from "../../application/legacy-quantity-import";

describe("retired legacy physical stock imports", () => {
  it("permits the explicit pre-opening compatibility path", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    await expect(assertLegacyQuantityImportAllowed({ execute }, "Shopify seed inventory")).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects quantity creation after the verified opening with recovery guidance", async () => {
    const execute = vi.fn(async () => ({ rows: [{ command_id: "opening" }] }));
    await expect(assertLegacyQuantityImportAllowed({ execute }, "Manual cost import")).rejects.toMatchObject({
      code: "QUANTITY_LEGACY_WRITER_RETIRED",
      message: expect.stringContaining("audited inventory adjustment"),
    });
  });

  it.each([null, undefined, {}, { rows: null }])("does not treat malformed authority evidence %j as legacy", async result => {
    await expect(assertLegacyQuantityImportAllowed({ execute: async () => result }, "Import")).rejects.toMatchObject({
      code: "QUANTITY_AUTHORITY_RESULT_INVALID",
    });
  });

  it("propagates database failures without admitting an import", async () => {
    const error = new Error("database unavailable");
    await expect(assertLegacyQuantityImportAllowed({ execute: async () => { throw error; } }, "Import")).rejects.toBe(error);
  });
});
