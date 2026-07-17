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

const emptyProviderShipment = {
  ...providerShipment,
  shipmentId: 903,
  orderId: 701,
  trackingNumber: "1Z-EMPTY-RESHIP",
  shipmentItems: [],
};

const originalProviderShipment = {
  ...providerShipment,
  shipmentId: 904,
  trackingNumber: "1Z-ORIGINAL-PACKAGE",
  shipmentItems: [{
    sku: "SKU-A",
    name: "Card",
    quantity: 1,
    lineItemKey: "wms-item-501",
  }],
};

const historicalOriginalProviderShipment = {
  ...providerShipment,
  shipmentId: 443917507,
  orderId: 759013579,
  orderKey: "echelon-wms-shp-6584",
  orderNumber: "59834",
  trackingNumber: "9434650206217247896302",
  shipmentItems: [
    { sku: "SKU-A", name: "Card A", quantity: 1, lineItemKey: "wms-item-10464" },
    { sku: "SKU-B", name: "Card B", quantity: 1, lineItemKey: "wms-item-10465" },
  ],
};

const historicalReplacementProviderShipment = {
  ...providerShipment,
  shipmentId: 446350792,
  orderId: 763886876,
  orderKey: "echelon-wms-shp-6584",
  orderNumber: "59834",
  trackingNumber: "1Z16D13WYW56744134",
  shipmentItems: [],
};

const historicalSplitContextRow = {
  exception_id: 77,
  wms_order_id: 204939,
  order_number: "59834",
  authority_shipment_id: 6584,
  candidate_shipment_id: null,
  external_shipment_ref: "446350792",
  tracking_number: "1Z16D13WYW56744134",
  authority_external_fulfillment_id: null,
  authority_tracking_number: "9434650206217247896302",
};

const historicalSplitItemRows = [
  { id: 10464, shipment_id: 6584, order_item_id: 312293, qty: 1 },
  { id: 10465, shipment_id: 6584, order_item_id: 312294, qty: 1 },
  // The original provider package was a valid partial shipment.
  { id: 10466, shipment_id: 6584, order_item_id: 312295, qty: 1 },
  { id: 11013, shipment_id: 7741, order_item_id: 312293, qty: 1 },
  { id: 11014, shipment_id: 7741, order_item_id: 312294, qty: 1 },
];

const contextRow = {
  exception_id: 77,
  wms_order_id: 42,
  order_number: "59030",
  authority_shipment_id: 10,
  candidate_shipment_id: 20,
  external_shipment_ref: "900",
  tracking_number: "1Z-RESHIP",
  authority_external_fulfillment_id: "shipstation_shipment:900",
  authority_tracking_number: "1Z-RESHIP",
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
    getShipmentById: vi.fn(async () => providerShipment),
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
              items: [{
                orderItemId: 101,
                sku: "SKU-A",
                name: "Card",
                quantity: 1,
              }],
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
      items: [{ orderItemId: 101, sku: "SKU-A", quantity: 1 }],
    });

    const contextQuery = queryText(db.execute.mock.calls[0][0]);
    expect(contextQuery).toContain(
      "NULLIF(BTRIM(exception.details->>'orderNumber'), '')",
    );
    expect(contextQuery).not.toContain("provider_order_id");
  });

  it("loads the target exclusively by exact physical shipment id", async () => {
    const exactShipment = {
      ...providerShipment,
      shipmentId: 446104678,
      orderId: 763385590,
      orderNumber: "EB-24-14838-80207",
      trackingNumber: "1Z8X330WYN43653055",
    };
    const staleContext = {
      ...contextRow,
      order_number: "24-14838-80207",
      external_shipment_ref: "446104678",
    };
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [staleContext] };
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
    const provider = shipStation({
      getShipmentById: vi.fn(async () => exactShipment),
      getShipments: vi.fn(async () => []),
    });

    const preview = await getShipStationUnmappedPhysicalPreview(
      db,
      provider,
      { exceptionId: 77 },
    );

    expect(provider.getShipmentById).toHaveBeenCalledWith(446104678);
    expect(provider.getShipments).not.toHaveBeenCalled();
    expect(provider.getOrderByNumber).not.toHaveBeenCalled();
    expect(preview.providerShipment).toEqual(exactShipment);
  });

  it("does not guess a physical shipment from order-level evidence", async () => {
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [contextRow] };
        }
        throw new Error(`Unexpected query: ${text}`);
      }),
    };
    const provider = shipStation({
      getShipmentById: vi.fn(async () => null),
    });

    await expect(getShipStationUnmappedPhysicalPreview(
      db,
      provider,
      { exceptionId: 77 },
    )).rejects.toThrow("ShipStation physical shipment 900 was not found");

    expect(provider.getShipmentById).toHaveBeenCalledWith(900);
    expect(provider.getShipments).not.toHaveBeenCalled();
    expect(provider.getOrderByNumber).not.toHaveBeenCalled();
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
        getShipmentById: vi.fn(async () => supersededProviderShipment),
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
        getShipmentById: vi.fn(async () => supersededProviderShipment),
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

  it("identifies an original package identity overwritten by an empty replacement callback", async () => {
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [{
            ...contextRow,
            candidate_shipment_id: null,
            external_shipment_ref: "903",
            tracking_number: "1Z-EMPTY-RESHIP",
            authority_external_fulfillment_id: "shipstation_shipment:904",
            authority_tracking_number: "1Z-EMPTY-RESHIP",
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
        getShipmentById: vi.fn(async () => emptyProviderShipment),
        getShipments: vi.fn(async () => [originalProviderShipment, emptyProviderShipment]),
      }),
      { exceptionId: 77 },
    );

    expect(preview.providerShipment).toEqual(emptyProviderShipment);
    expect(preview.originalPackageIdentityRepair).toEqual({
      wmsShipmentId: 10,
      providerShipmentId: 904,
      providerOrderId: 700,
      providerOrderKey: "echelon-wms-shp-10",
      currentTrackingNumber: "1Z-EMPTY-RESHIP",
      originalTrackingNumber: "1Z-ORIGINAL-PACKAGE",
    });
  });

  it("recognizes a failed historical partial split as the original package", async () => {
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [historicalSplitContextRow] };
        }
        if (
          text.includes("SELECT id, order_id, status, source, external_fulfillment_id")
          && text.includes("LIMIT 2")
        ) {
          return { rows: [{
            id: 7741,
            order_id: 204939,
            status: "cancelled",
            source: "shipstation_split",
            external_fulfillment_id: "shipstation_shipment:443917507",
            requires_review: true,
            review_reason: "duplicate key value violates unique constraint \"uq_outbound_shipments_shipped_order_tracking\"",
          }] };
        }
        if (
          text.includes("SELECT id, shipment_id, order_item_id, qty")
          && text.includes("ORDER BY shipment_id, id")
        ) {
          return { rows: historicalSplitItemRows };
        }
        if (text.includes("FROM wms.order_items order_item")) {
          return { rows: [] };
        }
        if (text.includes("COUNT(shipment_item.id)::int AS item_count")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${text}`);
      }),
    };
    const provider = shipStation({
      getShipmentById: vi.fn(async () => historicalReplacementProviderShipment),
      getShipments: vi.fn(async () => [
        historicalOriginalProviderShipment,
        historicalReplacementProviderShipment,
      ]),
    });

    const preview = await getShipStationUnmappedPhysicalPreview(
      db,
      provider,
      { exceptionId: 77 },
    );

    expect(provider.getShipmentById).toHaveBeenCalledWith(446350792);
    expect(provider.getShipments).toHaveBeenCalledWith(
      763886876,
      { orderNumber: "59834" },
    );
    expect(preview.providerShipment).toEqual(historicalReplacementProviderShipment);
    expect(preview.originalPackageIdentityRepair).toEqual({
      wmsShipmentId: 6584,
      providerShipmentId: 443917507,
      providerOrderId: 759013579,
      providerOrderKey: "echelon-wms-shp-6584",
      currentTrackingNumber: "9434650206217247896302",
      originalTrackingNumber: "9434650206217247896302",
      historicalSplitGhostShipmentId: 7741,
    });
  });

  it("leaves a historical split in review when copied quantities do not match", async () => {
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [historicalSplitContextRow] };
        }
        if (
          text.includes("SELECT id, order_id, status, source, external_fulfillment_id")
          && text.includes("LIMIT 2")
        ) {
          return { rows: [{
            id: 7741,
            order_id: 204939,
            status: "cancelled",
            source: "shipstation_split",
            external_fulfillment_id: "shipstation_shipment:443917507",
            requires_review: true,
            review_reason: "uq_outbound_shipments_shipped_order_tracking",
          }] };
        }
        if (
          text.includes("SELECT id, shipment_id, order_item_id, qty")
          && text.includes("ORDER BY shipment_id, id")
        ) {
          return {
            rows: historicalSplitItemRows.map((row) => (
              row.id === 11013 ? { ...row, qty: 2 } : row
            )),
          };
        }
        if (text.includes("FROM wms.order_items order_item")) return { rows: [] };
        if (text.includes("COUNT(shipment_item.id)::int AS item_count")) return { rows: [] };
        throw new Error(`Unexpected query: ${text}`);
      }),
    };

    const preview = await getShipStationUnmappedPhysicalPreview(
      db,
      shipStation({
        getShipmentById: vi.fn(async () => historicalReplacementProviderShipment),
        getShipments: vi.fn(async () => [
          historicalOriginalProviderShipment,
          historicalReplacementProviderShipment,
        ]),
      }),
      { exceptionId: 77 },
    );

    expect(preview.originalPackageIdentityRepair).toBeNull();
  });

  it("collapses the failed partial-split child before adopting the later package", async () => {
    const calls: string[] = [];
    const db: any = {
      transaction: async (work: (tx: any) => Promise<unknown>) => work(db),
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        calls.push(text);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [historicalSplitContextRow] };
        }
        if (
          text.includes("SELECT id, order_id, status, source, external_fulfillment_id")
          && text.includes("LIMIT 2")
        ) {
          return { rows: [{
            id: 7741,
            order_id: 204939,
            status: "cancelled",
            source: "shipstation_split",
            external_fulfillment_id: "shipstation_shipment:443917507",
            requires_review: true,
            review_reason: "duplicate key value violates unique constraint \"uq_outbound_shipments_shipped_order_tracking\"",
          }] };
        }
        if (
          text.includes("SELECT id, order_id, status, source, external_fulfillment_id")
          && text.includes("WHERE id")
          && text.includes("FOR UPDATE")
        ) {
          return { rows: [{
            id: 7741,
            order_id: 204939,
            status: "cancelled",
            source: "shipstation_split",
            external_fulfillment_id: "shipstation_shipment:443917507",
            requires_review: true,
            review_reason: "duplicate key value violates unique constraint \"uq_outbound_shipments_shipped_order_tracking\"",
          }] };
        }
        if (
          text.includes("SELECT id, shipment_id, order_item_id, qty")
          && text.includes("ORDER BY shipment_id, id")
        ) {
          return { rows: historicalSplitItemRows };
        }
        if (text.includes("JOIN LATERAL")) {
          return { rows: [{
            order_item_id: 312293,
            sku: "SKU-A",
            product_variant_id: 201,
            from_location_id: 301,
            source_quantity: 1,
          }] };
        }
        if (text.includes("FROM wms.order_items order_item")) {
          return { rows: [{
            id: 312293,
            sku: "SKU-A",
            name: "Card A",
            quantity: 1,
            fulfilled_quantity: 1,
            customer_shipped_quantity: 1,
          }] };
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
            id: 6584,
            status: "shipped",
            order_id: 204939,
            shipment_purpose: "customer_fulfillment",
            has_customer_items: true,
            external_fulfillment_id: null,
            tracking_number: "9434650206217247896302",
            shipstation_order_id: 759013579,
            shipstation_order_key: "echelon-wms-shp-6584",
          }] };
        }
        if (
          text.includes("SELECT id, order_id, status, source, shipment_purpose")
          && text.includes("external_fulfillment_id")
        ) {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO wms.outbound_shipments")) {
          return { rows: [{
            id: 8000,
            order_id: 204939,
            status: "queued",
            source: "shipstation_reship_adopted",
            shipment_purpose: "replacement",
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
      getShipmentById: vi.fn(async () => historicalReplacementProviderShipment),
      getShipments: vi.fn(async () => [
        historicalOriginalProviderShipment,
        historicalReplacementProviderShipment,
      ]),
    });

    const result = await adoptShipStationUnmappedPhysicalAsReship(db, service, {
      exceptionId: 77,
      operator: "ops:test",
      originalShipmentId: 6584,
      reason: "carrier_replacement",
      lineMappings: [{
        evidenceSource: "original_wms",
        orderItemId: 312293,
        quantity: 1,
      }],
    });

    expect(result).toMatchObject({
      changed: true,
      exceptionId: 77,
      candidateShipmentId: 8000,
      originalPackageIdentityRepaired: true,
    });
    expect(service.processShipmentNotification).toHaveBeenCalledWith(
      historicalReplacementProviderShipment,
    );
    const allSql = calls.join("\n");
    expect(allSql).toContain("shipstation_split_ghost_collapsed");
    expect(allSql).toContain("external_fulfillment_id = NULL");
    expect(allSql).toContain("shipstation_shipment:443917507");
    expect(allSql).toContain("shipstation_original_identity_restored");
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

  it("adopts an active empty ShipStation package from operator-confirmed original WMS items", async () => {
    const calls: string[] = [];
    const db: any = {
      transaction: async (work: (tx: any) => Promise<unknown>) => work(db),
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        calls.push(text);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [{
            ...contextRow,
            candidate_shipment_id: null,
            external_shipment_ref: "903",
            tracking_number: "1Z-EMPTY-RESHIP",
            authority_external_fulfillment_id: "shipstation_shipment:904",
            authority_tracking_number: "1Z-EMPTY-RESHIP",
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
            external_fulfillment_id: "shipstation_shipment:904",
            tracking_number: "1Z-EMPTY-RESHIP",
            shipstation_order_id: 700,
            shipstation_order_key: "echelon-wms-shp-10",
          }] };
        }
        if (
          text.includes("SELECT id, qty")
          && text.includes("ORDER BY id")
        ) {
          return { rows: [{ id: 501, qty: 1 }] };
        }
        if (
          text.includes("SELECT id, order_id, status, source, shipment_purpose")
          && text.includes("external_fulfillment_id")
        ) {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO wms.outbound_shipments")) {
          return { rows: [{
            id: 22,
            order_id: 42,
            status: "queued",
            source: "shipstation_reship_adopted",
            shipment_purpose: "replacement",
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
      getShipmentById: vi.fn(async () => emptyProviderShipment),
      getShipments: vi.fn(async () => [originalProviderShipment, emptyProviderShipment]),
    });

    const result = await adoptShipStationUnmappedPhysicalAsReship(db, service, {
      exceptionId: 77,
      operator: "ops:test",
      originalShipmentId: 10,
      reason: "carrier_replacement",
      notes: "Confirmed the carrier replacement contained SKU-A.",
      lineMappings: [{
        evidenceSource: "original_wms",
        orderItemId: 101,
        quantity: 1,
      }],
    });

    expect(result).toMatchObject({
      changed: true,
      exceptionId: 77,
      candidateShipmentId: 22,
      originalPackageIdentityRepaired: true,
    });
    expect(service.processShipmentNotification).toHaveBeenCalledWith(emptyProviderShipment);
    const allSql = calls.join("\n");
    expect(allSql).toContain("replacement_for_order_item_id");
    expect(allSql).toContain("shipstation_original_identity_restored");
  });

  it("records an off-order catalog item as a concession without order-line authority", async () => {
    const calls: string[] = [];
    const db: any = {
      transaction: async (work: (tx: any) => Promise<unknown>) => work(db),
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        calls.push(text);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [{
            ...contextRow,
            candidate_shipment_id: 20,
            external_shipment_ref: "903",
            tracking_number: emptyProviderShipment.trackingNumber,
            authority_external_fulfillment_id: "shipstation_shipment:903",
            authority_tracking_number: emptyProviderShipment.trackingNumber,
          }] };
        }
        if (text.includes("FROM wms.order_items order_item")) {
          return { rows: [orderItemRow] };
        }
        if (text.includes("FROM catalog.product_variants catalog_variant")) {
          return { rows: [{
            product_variant_id: 222,
            sku: "FREE-SKU",
            from_location_id: 333,
          }] };
        }
        if (text.includes("FROM wms.reconciliation_exceptions") && text.includes("FOR UPDATE")) {
          return { rows: [{ id: 77 }] };
        }
        if (text.includes("SELECT id, status, order_id") && text.includes("FROM wms.outbound_shipments")) {
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
            id: 20,
            order_id: 42,
            status: "shipped",
            source: "shipstation_split",
            shipment_purpose: "customer_fulfillment",
          }] };
        }
        if (text.includes("inventory_ship_count")) {
          return { rows: [{ count: 0, inventory_ship_count: 0 }] };
        }
        if (
          text.includes("SELECT id, order_item_id, replacement_for_order_item_id, shipment_item_purpose")
          && text.includes("FROM wms.outbound_shipment_items")
        ) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const service = shipStation({
      getShipmentById: vi.fn(async () => emptyProviderShipment),
    });

    const result = await adoptShipStationUnmappedPhysicalAsReship(db, service, {
      exceptionId: 77,
      operator: "ops:test",
      originalShipmentId: 10,
      reason: "concession",
      lineMappings: [{
        evidenceSource: "catalog",
        productVariantId: 222,
        quantity: 1,
      }],
    });

    expect(result).toMatchObject({
      changed: true,
      exceptionId: 77,
      candidateShipmentId: 20,
    });
    expect(service.processShipmentNotification).toHaveBeenCalledWith(emptyProviderShipment);
    const allSql = calls.join("\n");
    expect(allSql).toContain('"shipmentItemPurpose":"concession"');
    expect(allSql).toContain("shipment_item_purpose, product_variant_id");
    expect(allSql).toContain("inventory_level.variant_qty - inventory_level.reserved_qty");
    expect(allSql).toContain("product_location.is_primary = 1");
  });

  it("requires structured item confirmation when ShipStation omitted package lines", async () => {
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = queryText(query);
        if (text.includes("FROM wms.reconciliation_exceptions exception")) {
          return { rows: [{
            ...contextRow,
            candidate_shipment_id: null,
            external_shipment_ref: "903",
            tracking_number: "1Z-EMPTY-RESHIP",
          }] };
        }
        if (text.includes("FROM wms.order_items order_item")) {
          return { rows: [orderItemRow] };
        }
        throw new Error(`Unexpected query: ${text}`);
      }),
    };
    const service = shipStation({
      getShipmentById: vi.fn(async () => emptyProviderShipment),
    });

    await expect(adoptShipStationUnmappedPhysicalAsReship(db, service, {
      exceptionId: 77,
      operator: "ops:test",
      originalShipmentId: 10,
      reason: "carrier_replacement",
      lineMappings: [],
    })).rejects.toThrow("confirm at least one item that was physically sent");
    expect(db.execute).toHaveBeenCalledTimes(2);
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
      getShipmentById: vi.fn(async () => supersededProviderShipment),
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
      shipStation({ getShipmentById: vi.fn(async () => oversizedProvider) }),
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
      shipStation({ getShipmentById: vi.fn(async () => duplicateLineProvider) }),
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
        getShipmentById: vi.fn(async () => ({
          ...providerShipment,
          voidDate: "2026-07-14T10:00:00Z",
        })),
        getShipments: vi.fn(async () => []),
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
