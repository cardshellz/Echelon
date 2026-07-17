import { describe, expect, it, vi } from "vitest";
import { runFulfillmentSweep } from "../../fulfillment-sweeper.scheduler";

describe("fulfillment-sweeper.scheduler", () => {
  it("repushes a missing split shipment directly, including partially shipped orders", async () => {
    const pushShopifyFulfillment = vi.fn(async () => ({
      shopifyFulfillmentId: "gid://shopify/Fulfillment/42",
      alreadyPushed: false,
    }));
    const checkStatus = vi.fn();
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = (query?.queryChunks ?? [])
          .flatMap((chunk: any) => chunk?.value ?? [])
          .join(" ");
        if (text.includes("FROM shipped_channel_shipments")) {
          return {
            rows: [{
              shipment_id: 42,
              order_number: "#split",
              oms_order_id: 200,
              provider: "shopify",
              pending_retry: false,
              dead_retry: false,
            }],
          };
        }
        return { rows: [] };
      }),
      __fulfillmentPush: { pushShopifyFulfillment, checkStatus },
    };

    await runFulfillmentSweep(db);

    expect(pushShopifyFulfillment).toHaveBeenCalledWith(42);
    expect(checkStatus).not.toHaveBeenCalled();
  });

  it("does not duplicate work already pending or dead-lettered", async () => {
    const pushShopifyFulfillment = vi.fn();
    const db = {
      execute: vi.fn(async (query: any) => {
        const text = (query?.queryChunks ?? [])
          .flatMap((chunk: any) => chunk?.value ?? [])
          .join(" ");
        if (text.includes("FROM shipped_channel_shipments")) {
          return {
            rows: [
              { shipment_id: 43, provider: "shopify", pending_retry: true, dead_retry: false },
              { shipment_id: 44, provider: "shopify", pending_retry: false, dead_retry: true },
            ],
          };
        }
        return { rows: [] };
      }),
      __fulfillmentPush: { pushShopifyFulfillment },
    };

    await runFulfillmentSweep(db);

    expect(pushShopifyFulfillment).not.toHaveBeenCalled();
  });

  it("auto-resolves an open extra-package exception after ShipStation voids the label", async () => {
    const getShipmentById = vi.fn(async () => ({
      shipmentId: 446343015,
      voidDate: "2026-07-17T08:51:25.473Z",
    }));
    const execute = vi.fn(async (query: any) => {
      const text = (query?.queryChunks ?? [])
        .flatMap((chunk: any) => chunk?.value ?? [])
        .join(" ");
      if (text.includes("exception.rule = 'ship_notify_no_match'")) {
        return { rows: [] };
      }
      if (text.includes("SELECT exception.id AS exception_id")) {
        return {
          rows: [{ exception_id: 62, external_shipment_ref: "446343015" }],
        };
      }
      if (text.includes("UPDATE wms.reconciliation_exceptions")) {
        return {
          rows: [{ exception_id: 62, external_shipment_ref: "446343015" }],
        };
      }
      if (text.includes("FROM shipped_channel_shipments")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const db = {
      execute,
      __shipStationService: { getShipmentById },
    };

    await runFulfillmentSweep(db);

    expect(getShipmentById).toHaveBeenCalledWith(446343015);
    expect(execute.mock.calls.some(([query]) => (
      (query?.queryChunks ?? [])
        .flatMap((chunk: any) => chunk?.value ?? [])
        .join(" ")
        .includes("provider_physical_shipment_voided")
    ))).toBe(true);
  });
});
