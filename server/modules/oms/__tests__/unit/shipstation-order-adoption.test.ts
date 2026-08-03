import { describe, expect, it, vi } from "vitest";
import {
  adoptProvenShipStationOrder,
  proveShipStationOrderAdoption,
} from "../../shipstation-order-adoption";

const expected = {
  shipmentId: 14866,
  wmsOrderId: 206425,
  orderNumber: "#61191",
  items: [{ lineItemKey: "wms-item-17466", quantity: 2 }],
} as const;

function exactEvidence(overrides: Record<string, unknown> = {}) {
  return {
    orderId: 770729188,
    orderKey: "echelon-wms-shp-14866",
    orderNumber: "#61191",
    orderStatus: "awaiting_shipment",
    advancedOptions: {
      customField2: "wms_order_id:206425|shipment_id:14866",
    },
    items: [{ lineItemKey: "wms-item-17466", quantity: 2 }],
    ...overrides,
  };
}

function sqlText(query: any): string {
  return (query?.queryChunks ?? [])
    .map((chunk: any) =>
      typeof chunk === "string" ? chunk : chunk?.value?.join?.("") ?? "",
    )
    .join("");
}

describe("proveShipStationOrderAdoption", () => {
  it("accepts only an exact key, metadata, order number, and item signature", () => {
    expect(proveShipStationOrderAdoption(expected, exactEvidence())).toEqual({
      matched: true,
      providerOrderId: 770729188,
      orderKey: "echelon-wms-shp-14866",
    });
  });

  it.each([
    ["order key", { orderKey: "echelon-wms-shp-999" }, "order_key_mismatch"],
    ["order number", { orderNumber: "#61192" }, "order_number_mismatch"],
    [
      "WMS metadata",
      { advancedOptions: { customField2: "wms_order_id:1|shipment_id:14866" } },
      "wms_metadata_mismatch",
    ],
    [
      "item quantity",
      { items: [{ lineItemKey: "wms-item-17466", quantity: 1 }] },
      "item_signature_mismatch",
    ],
    [
      "duplicate item key",
      {
        items: [
          { lineItemKey: "wms-item-17466", quantity: 1 },
          { lineItemKey: "wms-item-17466", quantity: 1 },
        ],
      },
      "item_signature_mismatch",
    ],
    ["provider status", { orderStatus: "cancelled" }, "provider_order_cancelled"],
  ])("rejects a mismatched %s", (_label, overrides, reason) => {
    expect(
      proveShipStationOrderAdoption(expected, exactEvidence(overrides)),
    ).toEqual({ matched: false, reason });
  });
});

describe("adoptProvenShipStationOrder", () => {
  it("links without overwriting a conflict and closes pending or dead handoff debt", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ order_id: 206425 }] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });

    await expect(
      adoptProvenShipStationOrder(
        { execute },
        {
          shipmentId: 14866,
          providerOrderId: 770729188,
          orderKey: "echelon-wms-shp-14866",
        },
      ),
    ).resolves.toEqual({ state: "linked", wmsOrderId: 206425 });

    expect(sqlText(execute.mock.calls[0]![0])).toMatch(
      /shipstation_order_id IS NULL[\s\S]*shipstation_order_id =/,
    );
    expect(sqlText(execute.mock.calls[1]![0])).toMatch(
      /status IN \('pending', 'dead'\)/,
    );
  });

  it("reports a conflicting local provider id instead of overwriting it", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ shipstation_order_id: 770729199, status: "queued" }],
      });

    await expect(
      adoptProvenShipStationOrder(
        { execute },
        {
          shipmentId: 14866,
          providerOrderId: 770729188,
          orderKey: "echelon-wms-shp-14866",
        },
      ),
    ).resolves.toEqual({
      state: "conflict",
      existingProviderOrderId: 770729199,
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});