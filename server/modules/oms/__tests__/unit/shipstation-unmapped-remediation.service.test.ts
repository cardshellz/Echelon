import { describe, expect, it, vi } from "vitest";

import {
  adoptShipStationUnmappedPhysicalAsReship,
  getShipStationUnmappedPhysicalPreview,
} from "../../shipstation-unmapped-remediation.service";

function queryText(query: any): string {
  return (query?.queryChunks ?? [])
    .map((chunk: any) => {
      if (typeof chunk === "string") return chunk;
      if (Array.isArray(chunk?.value)) return chunk.value.join("");
      return "";
    })
    .join("");
}

const providerShipment = {
  shipmentId: 900,
  orderId: 700,
  orderKey: "echelon-wms-shp-10",
  orderNumber: "59030",
  trackingNumber: "1Z-RESHIP",
  carrierCode: "ups",
  serviceCode: "ups_ground",
  shipDate: "2026-07-13T12:00:00Z",
  voidDate: null,
  shipmentItems: [{ sku: "SKU-A", name: "Card", quantity: 1, lineItemKey: null }],
};

const supersededProviderShipment = {
  ...providerShipment,
  shipmentId: 900,
  trackingNumber: "1Z-SUPERSEDED",
  voidDate: "2026-07-13T12:05:00Z",
};

const activeProviderShipment = {
  ...providerShipment,
  shipmentId: 901,
  trackingNumber: "1Z-ACTIVE-RESHIP",
};

const contextRow = {
  exception_id: 77,
  wms_order_id: 42,
  order_number: "59030",
  authority_shipment_id: 10,
  candidate_shipment_id: 20,
  external_shipment_ref: "900",
  provider_order_id: 700,
  provider_order_key: "echelon-wms-shp-10",
  tracking_number: "1Z-RESHIP",
};

const crossedContextRow = {
  ...contextRow,
  tracking_number: "1Z-ACTIVE-RESHIP",
};

const orderItemRow = {
  id: 101,
  sku: "SKU-A",
  name: "Card",
  quantity: 1,
  fulfilled_quantity: 1,
  customer_shipped_quantity: 1,
};

function shipStation(overrides: Record<string, unknown> = {}) {
  return {
    getShipments: vi.fn(async () => [providerShipment]),
    getOrderByNumber: vi.fn(),
    processShipmentNotification: vi.fn(async () => ({ processed: true })),
    ...overrides,
  } as any;
}

describe("ShipStation unmapped physical remediation", () => {
  it("loads current ShipStation and WMS evidence before reship adoption", async () => {
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [contextRow] };
        }
        if (text.includes("FROM wms.order_items order_item")) {
          return { rows: [orderItemRow] };
        }
        if (text.includes("COUNT(shipment_item.id)::int AS item_count")) {
          return {
            rows: [{
              id: 10,
              status: "shipped",
              source: "oms",
              shipment_purpose: "customer_fulfillment",
              tracking_number: "1Z-ORIGINAL",
              external_fulfillment_id: "shipstation_shipment:800",
              created_at: "2026-07-10T12:00:00Z",
              item_count: 1,
            }],
          };
        }
        throw new Error(`Unexpected query: ${text}`);
      }),
    };

    const preview = await getShipStationUnmappedPhysicalPreview(
      db,
      shipStation(),
      { exceptionId: 77 },
    );

    expect(preview.providerShipment).toEqual(providerShipment);
    expect(preview.orderItems[0]).toMatchObject({
      id: 101,
      customerShippedQuantity: 1,
      remainingQuantity: 0,
    });
    expect(preview.shipments[0]).toMatchObject({
      id: 10,
      externalShipmentRef: "800",
    });
  });

  it("recovers a unique active package when legacy WMS rows crossed provider identity and tracking", async () => {
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [crossedContextRow] };
        }
        if (
          text.includes("SELECT id, order_id, status, tracking_number")
          && text.includes("LIMIT 2")
        ) {
          return { rows: [{
            id: 21,
            order_id: 42,
            status: "voided",
            tracking_number: "1Z-ACTIVE-RESHIP",
          }] };
        }
        if (text.includes("FROM wms.order_items order_item")) {
          return { rows: [orderItemRow] };
        }
        if (text.includes("COUNT(shipment_item.id)::int AS item_count")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${text}`);
      }),
    };

    const preview = await getShipStationUnmappedPhysicalPreview(
      db,
      shipStation({
        getShipments: vi.fn(async () => [
          supersededProviderShipment,
          activeProviderShipment,
        ]),
      }),
      { exceptionId: 77 },
    );

    expect(preview.providerShipment).toEqual(activeProviderShipment);
    expect(preview.externalShipmentRef).toBe("901");
    expect(preview.candidateShipmentId).toBe(21);
    expect(preview.providerIdentityRepair).toEqual({
      supersededCandidateShipmentId: 20,
      supersededProviderShipmentId: 900,
      supersededTrackingNumber: "1Z-SUPERSEDED",
      supersededVoidDate: "2026-07-13T12:05:00.000Z",
      activeCandidateShipmentId: 21,
      activeProviderShipmentId: 901,
      activeTrackingNumber: "1Z-ACTIVE-RESHIP",
    });
  });

  it("does not recover an active package when provider evidence is ambiguous", async () => {
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [crossedContextRow] };
        }
        if (text.includes("FROM wms.order_items order_item")) {
          return { rows: [orderItemRow] };
        }
        if (text.includes("COUNT(shipment_item.id)::int AS item_count")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${text}`);
      }),
    };
    const duplicateActive = { ...activeProviderShipment, shipmentId: 902 };

    const preview = await getShipStationUnmappedPhysicalPreview(
      db,
      shipStation({
        getShipments: vi.fn(async () => [
          supersededProviderShipment,
          activeProviderShipment,
          duplicateActive,
        ]),
      }),
      { exceptionId: 77 },
    );

    expect(preview.providerShipment).toEqual(supersededProviderShipment);
    expect(preview.providerIdentityRepair).toBeNull();
  });

  it("adopts a classified reship with replacement lineage and no direct fulfillment link", async () => {
    const calls: string[] = [];
    const db: any = {
      transaction: async (work: (tx: any) => Promise<unknown>) => work(db),
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        calls.push(text);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [contextRow] };
        }
        if (text.includes("JOIN LATERAL")) {
          return {
            rows: [{
              order_item_id: 101,
              sku: "SKU-A",
              product_variant_id: 201,
              from_location_id: 301,
              source_quantity: 1,
            }],
          };
        }
        if (text.includes("FROM wms.order_items order_item")) {
          return { rows: [orderItemRow] };
        }
        if (
          text.includes("FROM wms.reconciliation_exceptions") &&
          text.includes("FOR UPDATE")
        ) {
          return { rows: [{ id: 77 }] };
        }
        if (
          text.includes("SELECT id, status, order_id") &&
          text.includes("FROM wms.outbound_shipments")
        ) {
          return { rows: [{
            id: 10,
            status: "shipped",
            order_id: 42,
            shipment_purpose: "customer_fulfillment",
            has_customer_items: true,
          }] };
        }
        if (
          text.includes("SELECT id, order_id, status, source, shipment_purpose") &&
          text.includes("external_fulfillment_id")
        ) {
          return {
            rows: [{
              id: 20,
              order_id: 42,
              status: "shipped",
              source: "shipstation_split",
              shipment_purpose: "customer_fulfillment",
            }],
          };
        }
        if (text.includes("COUNT(*)::int AS count")) return { rows: [{ count: 0 }] };
        if (
          text.includes("SELECT id, order_item_id, replacement_for_order_item_id") &&
          text.includes("FROM wms.outbound_shipment_items")
        ) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const service = shipStation();

    const result = await adoptShipStationUnmappedPhysicalAsReship(db, service, {
      exceptionId: 77,
      operator: "ops:test",
      originalShipmentId: 10,
      reason: "lost",
      notes: "Carrier confirmed the original package was lost.",
      lineMappings: [{ providerItemIndex: 0, orderItemId: 101, quantity: 1 }],
    });

    expect(result).toMatchObject({
      changed: true,
      exceptionId: 77,
      candidateShipmentId: 20,
    });
    expect(service.processShipmentNotification).toHaveBeenCalledWith(providerShipment);
    const allSql = calls.join("\n");
    expect(allSql).toContain("status = 'lost'");
    expect(allSql).toContain("replacement_for_order_item_id");
    expect(allSql).toContain("order_item_id, replacement_for_order_item_id");
    expect(allSql).toContain("UPDATE wms.reconciliation_exceptions");
  });

  it("atomically repairs crossed legacy identities before adopting the active reship", async () => {
    const calls: string[] = [];
    const db: any = {
      transaction: async (work: (tx: any) => Promise<unknown>) => work(db),
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        calls.push(text);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [crossedContextRow] };
        }
        if (
          text.includes("SELECT id, order_id, status, tracking_number")
          && text.includes("LIMIT 2")
        ) {
          return { rows: [{
            id: 21,
            order_id: 42,
            status: "voided",
            tracking_number: "1Z-ACTIVE-RESHIP",
          }] };
        }
        if (text.includes("JOIN LATERAL")) {
          return { rows: [{
            order_item_id: 101,
            sku: "SKU-A",
            product_variant_id: 201,
            from_location_id: 301,
            source_quantity: 1,
          }] };
        }
        if (text.includes("FROM wms.order_items order_item")) {
          return { rows: [orderItemRow] };
        }
        if (
          text.includes("FROM wms.reconciliation_exceptions")
          && text.includes("FOR UPDATE")
        ) {
          return { rows: [{ id: 77 }] };
        }
        if (
          text.includes("SELECT id, status, order_id")
          && text.includes("FROM wms.outbound_shipments")
        ) {
          return { rows: [{
            id: 10,
            status: "shipped",
            order_id: 42,
            shipment_purpose: "customer_fulfillment",
            has_customer_items: true,
          }] };
        }
        if (
          text.includes("SELECT id, order_id, status, source, shipment_purpose")
          && text.includes("external_fulfillment_id")
        ) {
          return { rows: [{
            id: 21,
            order_id: 42,
            status: "voided",
            source: "shipstation_split",
            shipment_purpose: "customer_fulfillment",
          }] };
        }
        if (text.includes("COUNT(*)") && text.includes("inventory_ship_count")) {
          return { rows: [{ count: 0, inventory_ship_count: 0 }] };
        }
        if (
          text.includes("SELECT id, order_id, external_fulfillment_id, tracking_number")
          && text.includes("FOR UPDATE")
        ) {
          return { rows: [{
            id: 20,
            order_id: 42,
            external_fulfillment_id: "shipstation_shipment:900",
            tracking_number: "1Z-ACTIVE-RESHIP",
          }] };
        }
        if (
          text.includes("SELECT id, order_item_id, replacement_for_order_item_id")
          && text.includes("FROM wms.outbound_shipment_items")
        ) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const service = shipStation({
      getShipments: vi.fn(async () => [
        supersededProviderShipment,
        activeProviderShipment,
      ]),
    });

    const result = await adoptShipStationUnmappedPhysicalAsReship(db, service, {
      exceptionId: 77,
      operator: "ops:test",
      originalShipmentId: 10,
      reason: "lost",
      notes: "Confirmed active replacement package.",
      lineMappings: [{ providerItemIndex: 0, orderItemId: 101, quantity: 1 }],
    });

    expect(result).toMatchObject({
      changed: true,
      exceptionId: 77,
      candidateShipmentId: 21,
      providerIdentityRepaired: true,
    });
    expect(service.processShipmentNotification).toHaveBeenCalledWith(activeProviderShipment);
    const allSql = calls.join("\n");
    expect(allSql).toContain("shipstation_superseded_label_reconciled");
    expect(allSql).toContain("status = 'queued'");
    expect(allSql).toContain("voided_at = NULL");
    expect(calls.filter((text) => (
      text.includes("COUNT(*)") && text.includes("inventory_ship_count")
    ))).toHaveLength(2);
  });

  it("refuses a replacement quantity beyond the original package quantity", async () => {
    const calls: string[] = [];
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        calls.push(text);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [contextRow] };
        }
        if (text.includes("JOIN LATERAL")) {
          return {
            rows: [{
              order_item_id: 101,
              sku: "SKU-A",
              product_variant_id: 201,
              from_location_id: 301,
              source_quantity: 1,
            }],
          };
        }
        if (text.includes("FROM wms.order_items order_item")) {
          return { rows: [orderItemRow] };
        }
        return { rows: [] };
      }),
    };
    const oversizedProvider = {
      ...providerShipment,
      shipmentItems: [{ sku: "SKU-A", quantity: 2, lineItemKey: null }],
    };

    await expect(adoptShipStationUnmappedPhysicalAsReship(
      db,
      shipStation({ getShipments: vi.fn(async () => [oversizedProvider]) }),
      {
        exceptionId: 77,
        operator: "ops:test",
        originalShipmentId: 10,
        reason: "lost",
        lineMappings: [{ providerItemIndex: 0, orderItemId: 101, quantity: 2 }],
      },
    )).rejects.toThrow("replacement quantity for SKU SKU-A exceeds the original shipment");
    expect(calls.join("\n")).not.toMatch(/INSERT INTO|UPDATE /);
  });

  it("refuses duplicate package lines whose combined quantity exceeds the original", async () => {
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [contextRow] };
        }
        if (text.includes("JOIN LATERAL")) {
          return {
            rows: [{
              order_item_id: 101,
              sku: "SKU-A",
              product_variant_id: 201,
              from_location_id: 301,
              source_quantity: 1,
            }],
          };
        }
        if (text.includes("FROM wms.order_items order_item")) {
          return { rows: [{ ...orderItemRow, quantity: 2 }] };
        }
        return { rows: [] };
      }),
    };
    const duplicateLineProvider = {
      ...providerShipment,
      shipmentItems: [
        { sku: "SKU-A", quantity: 1, lineItemKey: null },
        { sku: "SKU-A", quantity: 1, lineItemKey: null },
      ],
    };

    await expect(adoptShipStationUnmappedPhysicalAsReship(
      db,
      shipStation({ getShipments: vi.fn(async () => [duplicateLineProvider]) }),
      {
        exceptionId: 77,
        operator: "ops:test",
        originalShipmentId: 10,
        reason: "lost",
        lineMappings: [
          { providerItemIndex: 0, orderItemId: 101, quantity: 1 },
          { providerItemIndex: 1, orderItemId: 101, quantity: 1 },
        ],
      },
    )).rejects.toThrow("replacement quantity for SKU SKU-A exceeds the original shipment");
  });

  it("refuses to adopt a voided ShipStation package", async () => {
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [contextRow] };
        }
        throw new Error(`Unexpected query: ${text}`);
      }),
    };

    await expect(adoptShipStationUnmappedPhysicalAsReship(
      db,
      shipStation({
        getShipments: vi.fn(async () => [{
          ...providerShipment,
          voidDate: "2026-07-14T10:00:00Z",
        }]),
      }),
      {
        exceptionId: 77,
        operator: "ops:test",
        originalShipmentId: 10,
        reason: "lost",
        lineMappings: [{ providerItemIndex: 0, orderItemId: 101, quantity: 1 }],
      },
    )).rejects.toThrow("voided ShipStation shipment cannot be adopted");
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});
