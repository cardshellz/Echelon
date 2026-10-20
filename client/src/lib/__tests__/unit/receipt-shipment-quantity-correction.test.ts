import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQuantityCorrectionClient,
  receiptCorrectionDraft,
} from "../../receipt-shipment-quantity-correction";
import {
  correctionContext,
  correctionInput,
} from "../../../../../test/fixtures/quantity-correction";
afterEach(() => vi.unstubAllGlobals());
describe("quantity correction command recovery", () => {
  it("shipment retries use their own command URL and cannot include receipt edits", async () => {
    const { receipts: _, ...input } = correctionInput;
    const saved = structuredClone(correctionContext(true));
    saved.history[0].summary.purpose = "shipment";
    saved.history[0].summary.receipts = saved.history[0].summary.receipts.map(
      (row) => ({
        ...row,
        receivedPieces: row.afterPieces,
        piecesPerUnit: row.afterPiecesPerUnit,
      }),
    );
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValue(new Response(JSON.stringify(saved)));
    vi.stubGlobal("fetch", fetch);
    const key = vi.fn(() => "shipment-edit-key"),
      client = createQuantityCorrectionClient(key, "shipment");
    await expect(client.approve(1, correctionInput)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.approve(1, input)).rejects.toMatchObject({
      ambiguous: true,
    });
    expect(await client.approve(1, input)).toEqual(saved);
    expect(key).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/shipment-lines/1/shipment-edit");
    expect(fetch.mock.calls[0][1]).toEqual(fetch.mock.calls[1][1]);
  });
  it("rejects a shipment success that claims to have rewritten a posted receipt", async () => {
    const { receipts: _, ...input } = correctionInput;
    const saved = structuredClone(correctionContext(true));
    saved.history[0].summary.purpose = "shipment";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(saved))),
    );
    await expect(
      createQuantityCorrectionClient(() => "key", "shipment").approve(1, input),
    ).rejects.toMatchObject({
      code: "QUANTITY_CORRECTION_RESPONSE",
      ambiguous: true,
    });
  });
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

describe("explicit receipt correction defaults", () => {
  it("suggests 200,000 for the sole receipt that covered the original 20,000-piece shipment", () => {
    const context = correctionContext();
    context.shippedPieces = 20000;
    context.receipts[0].receivedPieces = 20000;
    expect(receiptCorrectionDraft(context, "200000", {})).toEqual({
      32: "200000",
    });
    expect(context.receipts[0].receivedPieces).toBe(20000);
  });
  it("preserves a typed override including an invalid draft for boundary validation", () => {
    const context = correctionContext();
    for (const value of ["1500", "", "0", "-1", "1.5", "2147483648"]) {
      expect(receiptCorrectionDraft(context, "2000", { 32: value })).toEqual({
        32: value,
      });
    }
  });
  it("does not turn a partial receipt into a full delivery", () => {
    const context = correctionContext();
    context.receipts[0].receivedPieces = 100;
    expect(receiptCorrectionDraft(context, "2000", {})).toEqual({ 32: "100" });
  });
  it("does not guess the split across multiple receipts", () => {
    const context = correctionContext();
    context.receipts.push({
      ...context.receipts[0],
      receiptLineId: 34,
      receivedPieces: 100,
    });
    expect(receiptCorrectionDraft(context, "2000", { 32: "1500" })).toEqual({
      32: "1500",
      34: "100",
    });
  });
  it("does not invent a receipt before receiving", () => {
    expect(
      receiptCorrectionDraft({ shippedPieces: 200, receipts: [] }, "2000", {}),
    ).toEqual({});
  });
});
