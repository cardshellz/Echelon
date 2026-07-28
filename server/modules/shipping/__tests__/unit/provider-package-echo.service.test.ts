import { describe, expect, it, vi } from "vitest";

import {
  inspectShipStationProviderPackageEcho,
  reconcileShipStationProviderPackageEcho,
} from "../../provider-package-echo.service";

function queryText(query: any): string {
  return (query?.queryChunks ?? [])
    .map((chunk: any) => {
      if (typeof chunk === "string") return chunk;
      if (Array.isArray(chunk?.value)) return chunk.value.join("");
      return "";
    })
    .join("");
}

const input = {
  providerShipmentId: 448105575,
  trackingNumber: "9400 1502 0621 7792 9280 44",
  expectedWmsOrderId: 206063,
  shipmentItems: [
    { lineItemKey: "wms-item-16492", quantity: 1 },
    { lineItemKey: "wms-item-16493", quantity: 1 },
  ],
  source: "unit_test",
} as const;

const sourceRows = [
  { id: 16492, order_item_id: 110175, qty: 1, order_id: 206063 },
  { id: 16493, order_item_id: 110176, qty: 1, order_id: 206063 },
];

function physicalRows(physicalShipmentId: number) {
  return [
    {
      physical_shipment_id: physicalShipmentId,
      wms_order_item_id: 110175,
      quantity_shipped: 1,
      shipment_item_purpose: "customer_fulfillment",
      legacy_wms_shipment_id: 14383,
    },
    {
      physical_shipment_id: physicalShipmentId,
      wms_order_item_id: 110176,
      quantity_shipped: 1,
      shipment_item_purpose: "customer_fulfillment",
      legacy_wms_shipment_id: 14383,
    },
  ];
}

describe("ShipStation provider package echo", () => {
  it("matches one canonical package only from exact tracking and WMS line quantities", async () => {
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM wms.outbound_shipment_items AS source_item")) {
          return { rows: sourceRows };
        }
        if (text.includes("FROM wms.physical_shipments AS physical")) {
          return { rows: physicalRows(881) };
        }
        throw new Error(`Unexpected query: ${text}`);
      }),
    };

    await expect(inspectShipStationProviderPackageEcho(db, input)).resolves.toEqual({
      status: "matched",
      reason: "exact_tracking_and_line_authority",
      physicalShipmentId: 881,
      wmsOrderId: 206063,
      authoritativeLegacyShipmentIds: [14383],
      shippingProviderLabelId: null,
      linkInserted: false,
    });
  });

  it("rejects a provider quantity that differs from its authoritative WMS shipment item", async () => {
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM wms.outbound_shipment_items AS source_item")) {
          return { rows: sourceRows };
        }
        throw new Error(`Unexpected query: ${text}`);
      }),
    };

    const result = await inspectShipStationProviderPackageEcho(db, {
      ...input,
      shipmentItems: [
        { lineItemKey: "wms-item-16492", quantity: 2 },
        { lineItemKey: "wms-item-16493", quantity: 1 },
      ],
    });

    expect(result).toMatchObject({
      status: "no_match",
      reason: "provider_line_quantity_mismatch",
    });
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("requires operator review when more than one canonical package has the same proof", async () => {
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM wms.outbound_shipment_items AS source_item")) {
          return { rows: sourceRows };
        }
        if (text.includes("FROM wms.physical_shipments AS physical")) {
          return { rows: [...physicalRows(881), ...physicalRows(882)] };
        }
        throw new Error(`Unexpected query: ${text}`);
      }),
    };

    await expect(inspectShipStationProviderPackageEcho(db, input)).resolves.toMatchObject({
      status: "ambiguous",
      reason: "multiple_matching_physical_packages",
      physicalShipmentId: null,
    });
  });

  it("links the provider label idempotently without creating package authority", async () => {
    let insertAttempt = 0;
    const db: any = {
      transaction: async (work: (tx: any) => Promise<unknown>) => work(db),
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM wms.outbound_shipment_items AS source_item")) {
          return { rows: sourceRows };
        }
        if (text.includes("FROM wms.physical_shipments AS physical")) {
          return { rows: physicalRows(881) };
        }
        if (text.includes("FROM wms.shipping_provider_labels")) {
          return { rows: [{ id: 700, label_status: "active" }] };
        }
        if (text.includes("INSERT INTO wms.shipping_provider_label_links")) {
          insertAttempt += 1;
          return { rows: insertAttempt === 1 ? [{ id: 701 }] : [] };
        }
        if (text.includes("UPDATE wms.shipping_provider_labels")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${text}`);
      }),
    };

    await expect(reconcileShipStationProviderPackageEcho(db, input)).resolves.toMatchObject({
      status: "matched",
      physicalShipmentId: 881,
      shippingProviderLabelId: 700,
      linkInserted: true,
    });
    await expect(reconcileShipStationProviderPackageEcho(db, input)).resolves.toMatchObject({
      status: "matched",
      physicalShipmentId: 881,
      shippingProviderLabelId: 700,
      linkInserted: false,
    });

    const allSql = db.execute.mock.calls.map(([query]: [any]) => queryText(query)).join("\n");
    expect(allSql).toContain("ON CONFLICT DO NOTHING");
    expect(allSql).not.toContain("INSERT INTO wms.physical_shipments");
    expect(allSql).not.toContain("INSERT INTO inventory.inventory_transactions");
  });

  it("refuses to link a return label to outbound package authority", async () => {
    const db: any = {
      transaction: async (work: (tx: any) => Promise<unknown>) => work(db),
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM wms.outbound_shipment_items AS source_item")) {
          return { rows: sourceRows };
        }
        if (text.includes("FROM wms.physical_shipments AS physical")) {
          return { rows: physicalRows(881) };
        }
        if (text.includes("FROM wms.shipping_provider_labels")) {
          return {
            rows: [{
              id: 700,
              label_status: "active",
              label_direction: "return",
            }],
          };
        }
        throw new Error(`Unexpected query: ${text}`);
      }),
    };

    await expect(reconcileShipStationProviderPackageEcho(db, input)).resolves.toMatchObject({
      status: "no_match",
      reason: "provider_return_label",
      physicalShipmentId: null,
      linkInserted: false,
    });

    const allSql = db.execute.mock.calls.map(([query]: [any]) => queryText(query)).join("\n");
    expect(allSql).not.toContain("INSERT INTO wms.shipping_provider_label_links");
  });

  it("does not touch provider linkage for non-authoritative ShipStation lines", async () => {
    const db = { execute: vi.fn() };
    const result = await reconcileShipStationProviderPackageEcho(db, {
      ...input,
      shipmentItems: [{ lineItemKey: null, quantity: 1 }],
    });

    expect(result).toMatchObject({
      status: "no_match",
      reason: "provider_lines_not_authoritative",
    });
    expect(db.execute).not.toHaveBeenCalled();
  });
});
