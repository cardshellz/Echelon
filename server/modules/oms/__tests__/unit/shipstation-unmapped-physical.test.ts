import { describe, expect, it, vi } from "vitest";

import {
  SHIPSTATION_UNMAPPED_PHYSICAL_RULE,
  buildShipStationUnmappedPhysicalIdempotencyKey,
  buildShipStationUnmappedPhysicalSummary,
  isExactShipStationPhysicalShipmentReplay,
  recordShipStationUnmappedPhysicalException,
  resolveShipStationUnmappedPhysicalExceptionForExactReplay,
  resolveShipStationUnmappedPhysicalExceptionForProviderEcho,
  resolveShipStationUnmappedPhysicalExceptionForReturnLabel,
  resolveShipStationUnmappedPhysicalExceptionForVoidedLabel,
  shipStationShipmentRefFromExternalFulfillmentId,
} from "../../shipstation-unmapped-physical";

function sqlText(query: any): string {
  return (query?.queryChunks ?? [])
    .map((chunk: any) => {
      if (typeof chunk === "string") return chunk;
      if (Array.isArray(chunk?.value)) return chunk.value.join("");
      return "";
    })
    .join("");
}

describe("ShipStation unmapped physical shipment evidence", () => {
  it("uses the provider physical shipment as the durable exception identity", () => {
    expect(buildShipStationUnmappedPhysicalIdempotencyKey({
      shipmentId: 443121354,
      orderId: 123,
      orderKey: "echelon-wms-shp-6061",
      trackingNumber: "9400",
    })).toBe(
      `shipstation_notify:${SHIPSTATION_UNMAPPED_PHYSICAL_RULE}:shipment:443121354`,
    );
    expect(shipStationShipmentRefFromExternalFulfillmentId(
      "shipstation_shipment:443121354",
    )).toBe("443121354");
    expect(shipStationShipmentRefFromExternalFulfillmentId("gid://shopify/1")).toBeNull();
  });

  it("proves an exact replay only from package and normalized tracking identity", () => {
    const exact = {
      shipment: {
        shipmentId: 440619985,
        trackingNumber: "9434 6502-0621 7239 8854 13",
        voidDate: null,
        isReturnLabel: false,
      },
      currentPhysicalShipmentRef: "shipstation_shipment:440619985",
      currentTrackingNumber: "9434650206217239885413",
    };

    expect(isExactShipStationPhysicalShipmentReplay(exact)).toBe(true);
    expect(isExactShipStationPhysicalShipmentReplay({
      ...exact,
      shipment: { ...exact.shipment, shipmentId: 440619986 },
    })).toBe(false);
    expect(isExactShipStationPhysicalShipmentReplay({
      ...exact,
      shipment: { ...exact.shipment, trackingNumber: "9434650206217239885999" },
    })).toBe(false);
    expect(isExactShipStationPhysicalShipmentReplay({
      ...exact,
      shipment: {
        ...exact.shipment,
        voidDate: "2026-07-18T00:00:00.000Z",
      },
    })).toBe(false);
    expect(isExactShipStationPhysicalShipmentReplay({
      ...exact,
      shipment: { ...exact.shipment, isReturnLabel: true },
    })).toBe(false);
  });

  it("fails closed when package or tracking evidence is missing or malformed", () => {
    expect(isExactShipStationPhysicalShipmentReplay({
      shipment: {
        shipmentId: 440619985,
        trackingNumber: "",
      },
      currentPhysicalShipmentRef: "shipstation_shipment:440619985",
      currentTrackingNumber: "9434650206217239885413",
    })).toBe(false);
  });

  it("explains the blocked decision in operational English", () => {
    expect(buildShipStationUnmappedPhysicalSummary({
      shipmentId: 446104678,
      orderNumber: "EB-24-14838-80207",
      trackingNumber: "1Z8X330WYN43653055",
    })).toBe(
      "ShipStation reported another package for order EB-24-14838-80207 " +
      "with tracking 1Z8X330WYN43653055. Echelon did not change fulfillment " +
      "or inventory because it could not determine whether the package was " +
      "an intentional replacement or a duplicate.",
    );
  });

  it("records blocked fulfillment and inventory evidence as one open review exception", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));

    await recordShipStationUnmappedPhysicalException({ execute }, {
      shipment: {
        shipmentId: 443121354,
        orderId: 99,
        orderKey: "echelon-wms-shp-6061",
        orderNumber: "#59030",
        trackingNumber: "9400",
        shipmentItems: [{ lineItemKey: null, sku: "SKU-A", quantity: 1 }],
      },
      wmsOrderId: 1234,
      wmsShipmentId: 6061,
      blockedReason: "test_block",
    });

    expect(execute).toHaveBeenCalledOnce();
    const statement = sqlText(execute.mock.calls[0][0]);
    expect(statement).toContain("INSERT INTO wms.reconciliation_exceptions");
    expect(statement).toContain("existing.status IN ('resolved', 'ignored')");
    expect(statement).toContain("ON CONFLICT (idempotency_key)");
    expect(statement).toContain("occurrence_count = wms.reconciliation_exceptions.occurrence_count + 1");
    expect(statement).toContain("summary = EXCLUDED.summary");
  });


  it("does not create an outbound split exception for a provider-declared return label", async () => {
    const execute = vi.fn();

    await recordShipStationUnmappedPhysicalException({ execute }, {
      shipment: {
        shipmentId: 448076377,
        orderId: 765185209,
        orderKey: "echelon-wms-shp-10374",
        orderNumber: "#60580",
        trackingNumber: "9434650206217258521132",
        isReturnLabel: true,
      },
      wmsOrderId: 205770,
      wmsShipmentId: 10374,
      blockedReason: "distinct_physical_shipment_after_terminal_fulfillment",
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it("resolves a return label without changing outbound shipment, inventory, or channel authority", async () => {
    const execute = vi.fn(async () => ({ rows: [{ id: 572 }] }));

    const changed = await resolveShipStationUnmappedPhysicalExceptionForReturnLabel(
      { execute },
      {
        shipment: {
          shipmentId: 448076377,
          orderId: 765185209,
          orderKey: "echelon-wms-shp-10374",
          orderNumber: "#60580",
          trackingNumber: "9434650206217258521132",
          isReturnLabel: true,
        },
        resolvedBy: "ops:test",
      },
    );

    expect(changed).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    const statement = sqlText(execute.mock.calls[0][0]);
    expect(statement).toContain("classification = 'provider_return_label'");
    expect(statement).toContain("status = 'resolved'");
    expect(statement).toContain("resolve_return_label");
    expect(statement).toContain("fulfillmentMutationBlocked");
    expect(statement).not.toContain("wms.outbound_shipments");
    expect(statement).not.toContain("inventory.inventory_transactions");
  });

  it("resolves only the matching open exception for an exact package replay", async () => {
    const execute = vi.fn(async () => ({ rows: [{ id: 328 }] }));

    const changed = await resolveShipStationUnmappedPhysicalExceptionForExactReplay(
      { execute },
      {
        shipment: {
          shipmentId: 440619985,
          orderId: 742250001,
          orderKey: "echelon-wms-shp-4126",
          orderNumber: "#59175",
          trackingNumber: "9434650206217239885413",
          shipmentItems: [
            { lineItemKey: "wms-item-8502", sku: "SPORTS-CARD", quantity: 1 },
          ],
        },
        wmsOrderId: 204249,
        wmsShipmentId: 4126,
        currentPhysicalShipmentRef: "shipstation_shipment:440619985",
        currentTrackingNumber: "9434650206217239885413",
        resolvedBy: "system:shipstation_webhook",
      },
    );

    expect(changed).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    const statement = sqlText(execute.mock.calls[0][0]);
    expect(statement).toContain("classification = 'provider_package_echo'");
    expect(statement).toContain("status = 'resolved'");
    expect(statement).toContain("resolve_exact_provider_package_replay");
    expect(statement).toContain("wms_shipment_id");
    expect(statement).toContain("external_shipment_ref");
    expect(statement).not.toContain("UPDATE wms.outbound_shipments");
    expect(statement).not.toContain("inventory.inventory_transactions");
  });

  it("resolves an exact historical provider echo from legacy shipment authority", async () => {
    const execute = vi.fn(async () => ({ rows: [{ id: 328 }] }));

    const changed = await resolveShipStationUnmappedPhysicalExceptionForProviderEcho(
      { execute },
      {
        shipment: {
          shipmentId: 440619985,
          orderId: 742250001,
          orderKey: "echelon-wms-shp-4126",
          orderNumber: "#59175",
          trackingNumber: "9434650206217239885413",
        },
        wmsOrderId: 204249,
        physicalShipmentId: null,
        authoritativeLegacyShipmentIds: [4126],
        candidateShipmentId: 4126,
        resolvedBy: "ops:test",
      },
    );

    expect(changed).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    const statement = sqlText(execute.mock.calls[0][0]);
    expect(statement).toContain("classification = 'provider_package_echo'");
    expect(statement).toContain("status = 'resolved'");
    expect(statement).toContain("link_provider_package_echo");
    expect(statement).not.toContain("UPDATE wms.outbound_shipments");
    expect(statement).not.toContain("inventory.inventory_transactions");
  });

  it("closes the exact exception when a later provider event proves the label was voided", async () => {
    const execute = vi.fn(async () => ({ rows: [{ id: 62 }] }));

    const changed = await resolveShipStationUnmappedPhysicalExceptionForVoidedLabel(
      { execute },
      {
        shipment: {
          shipmentId: 446343015,
          orderId: 763878471,
          orderKey: "echelon-wms-shp-4209",
          orderNumber: "#59384",
          trackingNumber: "9434650106151107463789",
          voidDate: "2026-07-17T08:51:25.473Z",
        },
        resolvedBy: "system:shipstation_webhook",
      },
    );

    expect(changed).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    const statement = sqlText(execute.mock.calls[0][0]);
    expect(statement).toContain("UPDATE wms.reconciliation_exceptions");
    expect(statement).toContain("classification = 'provider_voided_label'");
    expect(statement).toContain("status = 'resolved'");
    expect(statement).toContain("status IN ('open', 'acknowledged')");
    expect(statement).not.toContain("wms.outbound_shipments");
    expect(statement).not.toContain("inventory.inventory_transactions");
  });

  it("does nothing when the provider evidence does not contain a valid void timestamp", async () => {
    const execute = vi.fn();

    const changed = await resolveShipStationUnmappedPhysicalExceptionForVoidedLabel(
      { execute },
      {
        shipment: {
          shipmentId: 446343015,
          orderId: 763878471,
          orderKey: "echelon-wms-shp-4209",
          trackingNumber: "9434650106151107463789",
          voidDate: "not-a-date",
        },
        resolvedBy: "system:shipstation_webhook",
      },
    );

    expect(changed).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});
