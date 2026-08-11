import { describe, expect, it, vi } from "vitest";
import { createExpectedWmsReturn } from "../../expected-return-commands";

const NOW = new Date("2026-08-11T16:00:00.000Z");

function qtext(query: any): string {
  return (query?.queryChunks ?? [])
    .flatMap((chunk: any) => {
      if (chunk == null) return [];
      if (typeof chunk === "string") return [chunk];
      if (Array.isArray(chunk.value)) return chunk.value;
      if (chunk.value !== undefined) return [String(chunk.value)];
      return [];
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function input() {
  return {
    orderId: 41,
    source: "returns_admin",
    sourceEventKey: "manual-return:test-key",
    reason: "buyer_return",
    notes: "Opened by ops",
    items: [{
      orderItemId: 51,
      omsOrderLineId: 61,
      externalLineItemId: "line-71",
      sku: "SKU-1",
      expectedQuantity: 2,
      restockPolicy: "return",
    }],
    now: NOW,
  };
}

describe("createExpectedWmsReturn", () => {
  it("creates an expected WMS return and its items", async () => {
    const execute = vi.fn(async (query: any) => {
      const text = qtext(query);
      if (text.includes("INSERT INTO wms.returns")) return { rows: [{ id: 801 }] };
      if (text.includes("INSERT INTO wms.return_items")) return { rows: [{ id: 901 }] };
      throw new Error(`Unexpected SQL: ${text}`);
    });

    const result = await createExpectedWmsReturn({ execute }, input());

    expect(result).toEqual({
      returnId: 801,
      created: true,
      items: [{ id: 901, orderItemId: 51, created: true }],
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("resolves an idempotent replay without duplicating rows", async () => {
    const execute = vi.fn(async (query: any) => {
      const text = qtext(query);
      if (text.includes("INSERT INTO wms.returns")) return { rows: [] };
      if (text.includes("FROM wms.returns")) return { rows: [{ id: 801 }] };
      if (text.includes("INSERT INTO wms.return_items")) return { rows: [] };
      if (text.includes("FROM wms.return_items")) return { rows: [{ id: 901 }] };
      throw new Error(`Unexpected SQL: ${text}`);
    });

    const result = await createExpectedWmsReturn({ execute }, input());

    expect(result).toEqual({
      returnId: 801,
      created: false,
      items: [{ id: 901, orderItemId: 51, created: false }],
    });
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("rejects duplicate order items before issuing SQL", async () => {
    const execute = vi.fn();
    const duplicate = input();
    duplicate.items.push({ ...duplicate.items[0] });

    await expect(createExpectedWmsReturn({ execute }, duplicate)).rejects.toThrow(
      "duplicate orderItemId 51",
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
