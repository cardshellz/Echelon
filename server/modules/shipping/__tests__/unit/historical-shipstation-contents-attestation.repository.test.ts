import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  HistoricalShipStationContentsAttestationRepositoryError,
  PgHistoricalShipStationContentsAttestationRepository,
} from "../../historical-shipstation-contents-attestation.repository";

function repositoryWith(input: Readonly<{
  readonly query?: (text: string) => Promise<{ rows: Record<string, unknown>[] }>;
  readonly release?: (error?: Error) => void;
  readonly connectError?: Error;
}> = {}) {
  const query = vi.fn(input.query ?? (async () => ({ rows: [] })));
  const release = vi.fn(input.release ?? (() => undefined));
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn(async () => {
    if (input.connectError) throw input.connectError;
    return client;
  });
  const pool = { connect } as unknown as Pool;
  return {
    repository: new PgHistoricalShipStationContentsAttestationRepository(pool),
    query,
    release,
    connect,
  };
}

describe("historical ShipStation contents attestation repository transaction", () => {
  it("loads recognizable order, shipment, tracking, and item context in one read snapshot", async () => {
    const harness = repositoryWith({
      query: async (text) => {
        if (text === "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY") {
          return { rows: [] };
        }
        if (text === "COMMIT") return { rows: [] };
        if (text.includes("label.provider_label_id") && text.includes("FOR UPDATE") === false) {
          return {
            rows: [{
              shipping_provider_label_id: "51",
              provider_label_id: "44001",
              tracking_number: "9400111899223856928499",
            }],
          };
        }
        if (text.includes("COUNT(DISTINCT link.physical_shipment_id)")) {
          return {
            rows: [{
              shipping_provider_label_id: "51",
              physical_shipment_count: "0",
              legacy_wms_shipment_count: "1",
            }],
          };
        }
        if (text.includes("'legacy_wms_shipment'::text AS source_kind")) {
          return {
            rows: [{
              shipping_provider_label_id: "51",
              source_kind: "legacy_wms_shipment",
              linked_package_id: "88",
              wms_shipment_item_id: "7001",
              sku: "SKU-A",
              quantity: "2",
            }],
          };
        }
        if (text.includes("NULLIF(BTRIM(label.provider_order_id)")) {
          return {
            rows: [{
              tracking_number: "9400111899223856928499",
              provider_order_id: "700100200",
            }],
          };
        }
        if (text.includes("link.physical_shipment_id::text AS physical_shipment_id")) {
          return {
            rows: [{ physical_shipment_id: null, legacy_wms_shipment_id: "88" }],
          };
        }
        if (text.includes("WITH links AS MATERIALIZED")) {
          return { rows: [{ wms_order_id: "301", order_number: "#1001" }] };
        }
        if (text.includes("AS item_name")) {
          return { rows: [{ wms_shipment_item_id: "7001", item_name: "Card Shell" }] };
        }
        throw new Error(`Unexpected test query: ${text}`);
      },
    });

    await expect(harness.repository.loadReviewSnapshot("51")).resolves.toEqual({
      candidate: {
        shippingProviderLabelId: "51",
        providerShipmentId: 44_001,
        expectedContents: {
          kind: "available",
          source: "legacy_wms_shipment",
          lines: [{ wmsShipmentItemId: 7_001, sku: "SKU-A", quantity: 2 }],
        },
      },
      reviewContext: {
        trackingNumber: "9400111899223856928499",
        shipStationOrderId: "700100200",
        wmsOrders: [{ wmsOrderId: 301, orderNumber: "#1001" }],
        linkedShipments: [{ source: "legacy_wms_shipment", shipmentId: "88" }],
        linePresentations: [{ wmsShipmentItemId: 7_001, itemName: "Card Shell" }],
      },
    });
    expect(harness.release).toHaveBeenCalledWith(undefined);
  });

  it("rolls back and preserves the application failure", async () => {
    const harness = repositoryWith();
    const primary = new Error("classified application failure");

    const promise = harness.repository.withSerializableTransaction(async () => {
      throw primary;
    });

    await expect(promise).rejects.toBe(primary);
    expect(harness.query.mock.calls.map(([text]) => text)).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE",
      "ROLLBACK",
    ]);
    expect(harness.release).toHaveBeenCalledWith(primary);
  });

  it("preserves primary, rollback, and release failures in one classified cleanup error", async () => {
    const primary = new Error("primary");
    const rollback = new Error("rollback");
    const release = new Error("release");
    const harness = repositoryWith({
      query: async (text) => {
        if (text === "ROLLBACK") throw rollback;
        return { rows: [] };
      },
      release: () => {
        throw release;
      },
    });

    const promise = harness.repository.withSerializableTransaction(async () => {
      throw primary;
    });

    await expect(promise).rejects.toMatchObject({ code: "TRANSACTION_CLEANUP_FAILED" });
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(HistoricalShipStationContentsAttestationRepositoryError);
      const cause = (error as Error & { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(AggregateError);
      expect((cause as AggregateError).errors).toEqual([primary, rollback, release]);
    });
    expect(harness.release).toHaveBeenCalledWith(rollback);
  });

  it("classifies pool connection failures without opening a transaction", async () => {
    const connectError = Object.assign(new Error("connect failed"), { code: "08006" });
    const harness = repositoryWith({ connectError });

    await expect(harness.repository.withSerializableTransaction(async () => "unused"))
      .rejects.toMatchObject({
        code: "DATABASE_ERROR",
        context: { postgresCode: "08006", constraint: null },
      });
    expect(harness.query).not.toHaveBeenCalled();
    expect(harness.release).not.toHaveBeenCalled();
  });
});
