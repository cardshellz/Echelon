import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuantityCorrectionClient } from "../../receipt-shipment-quantity-correction";
import {
  correctionContext,
  correctionInput,
} from "../../../../../test/fixtures/quantity-correction";
afterEach(() => vi.unstubAllGlobals());
describe("quantity correction command recovery", () => {
  it("keeps the exact request and key after response loss", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValue(new Response(JSON.stringify(correctionContext(true))));
    vi.stubGlobal("fetch", fetch);
    const key = vi.fn(() => "quantity-key"),
      client = createQuantityCorrectionClient(key);
    await expect(client.approve(1, correctionInput)).rejects.toMatchObject({
      ambiguous: true,
    });
    expect(await client.approve(1, correctionInput)).toEqual(
      correctionContext(true),
    );
    expect(key).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toEqual(fetch.mock.calls[1][1]);
  });
  it.each([
    {},
    correctionContext(false),
    { ...correctionContext(true), shipmentLineId: 2 },
    {
      ...correctionContext(true),
      history: [
        {
          ...correctionContext(true).history[0],
          sourceVersion: "d".repeat(64),
        },
      ],
    },
    {
      ...correctionContext(true),
      history: [
        {
          ...correctionContext(true).history[0],
          reason: "An unrelated approval",
        },
      ],
    },
  ])("rejects unverified success", async (raw) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(raw))),
    );
    await expect(
      createQuantityCorrectionClient(() => "key").approve(1, correctionInput),
    ).rejects.toMatchObject({ ambiguous: true });
  });
  it("blocks payload changes and invalid identifiers", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("lost response"));
    vi.stubGlobal("fetch", fetch);
    const client = createQuantityCorrectionClient(() => "key");
    await expect(client.approve(0, correctionInput)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.approve(1, correctionInput)).rejects.toThrow();
    await expect(
      client.approve(1, { ...correctionInput, shippedPieces: 1000 }),
    ).rejects.toMatchObject({ code: "QUANTITY_CORRECTION_PENDING" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
