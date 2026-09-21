import { z } from "zod";
import type { ShipStationLabelCommercialFulfillmentShipment } from "../shipping/package-allocation-label-commercial-fulfillment.service";

const DAY_MS = 24 * 60 * 60 * 1_000;
const PROVIDER_SETTLE_MS = 2 * 60 * 1_000;
export const LABEL_RECONCILIATION_LEASE_MS = 5 * 60 * 1_000;
export const VOID_PAGE_SIZE = 10;
export const ORDER_LABEL_PAGE_SIZE = 100;
const MAX_ORDER_LABEL_PAGES = 5;

/** Label observation is not an order-import DTO. Opaque contents are validated
 * by the existing shipping owner, not by requirements for SKU, cost or address. */
export interface ShipStationLabelSnapshot extends ShipStationLabelCommercialFulfillmentShipment {
  trackingNumber: string;
  carrierCode?: string | null;
  serviceCode?: string | null;
  createDate?: string | null;
  shipDate?: string | null;
  voided?: boolean;
}

export interface LabelScanWindow { start: Date; end: Date; page: number }
export interface LabelScanCheckpoint {
  version: number;
  completedThrough: Date;
  window: LabelScanWindow | null;
  lastSuccessAt: Date | null;
}
export interface LabelScanClaim extends LabelScanCheckpoint { window: LabelScanWindow }
export interface LabelScanRepository {
  readOrCreate(initialThrough: Date, now: Date): Promise<LabelScanCheckpoint>;
  claim(checkpoint: LabelScanCheckpoint, window: LabelScanWindow, now: Date): Promise<LabelScanClaim | null>;
  renew(claim: LabelScanClaim, now: Date): Promise<void>;
  completePage(claim: LabelScanClaim, hasMore: boolean, now: Date): Promise<void>;
  fail(claim: LabelScanClaim, code: string, now: Date): Promise<void>;
}
export interface ShipStationLabelPage {
  shipments: ShipStationLabelSnapshot[];
  page: number;
  pages: number;
  total: number;
}
export interface LabelScanSource {
  isConfigured(): boolean;
  listVoids(window: LabelScanWindow): Promise<ShipStationLabelPage>;
  listOrderLabels(orderId: number, page: number): Promise<ShipStationLabelPage>;
}

export class LabelReconciliationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "LabelReconciliationError"; }
}

/** A completed watermark never advances past an unprocessed page. A day's
 * overlap covers delayed visibility and pagination movement; catch-up windows
 * advance by at most a day even after a long outage. No full-history scan. */
export function planLabelScanWindow(checkpoint: LabelScanCheckpoint, now: Date): LabelScanWindow | null {
  z.date().parse(now);
  z.date().parse(checkpoint.completedThrough);
  if (checkpoint.window) return checkpoint.window;
  const end = new Date(Math.min(now.getTime() - PROVIDER_SETTLE_MS, checkpoint.completedThrough.getTime() + DAY_MS));
  if (end <= checkpoint.completedThrough) return null;
  return {
    start: new Date(checkpoint.completedThrough.getTime() - (checkpoint.lastSuccessAt ? DAY_MS : 0)),
    end, page: 1,
  };
}

export function createShipStationLabelReconciliationService(dependencies: {
  repository: LabelScanRepository;
  source: LabelScanSource;
  processLabels(shipments: ShipStationLabelSnapshot[]): Promise<number>;
  clock: { now(): Date };
}) {
  return {
    async runOnce(): Promise<{ outcome: "disabled" | "idle" | "busy" | "processed"; voids: number; orders: number }> {
      if (!dependencies.source.isConfigured()) return { outcome: "disabled", voids: 0, orders: 0 };
      const now = z.date().parse(dependencies.clock.now());
      const checkpoint = await dependencies.repository.readOrCreate(new Date(now.getTime() - DAY_MS), now);
      const window = planLabelScanWindow(checkpoint, now);
      if (!window) return { outcome: "idle", voids: 0, orders: 0 };
      const claim = await dependencies.repository.claim(checkpoint, window, now);
      if (!claim) return { outcome: "busy", voids: 0, orders: 0 };
      try {
        const page = await dependencies.source.listVoids(claim.window);
        await dependencies.repository.renew(claim, dependencies.clock.now());
        // Persist voids first, even if a subsequent related-order read fails.
        // Existing owner outboxes make replay safe after any partial failure.
        await dependencies.processLabels(page.shipments);
        // Standalone ShipStation labels have no order. Their void still enters
        // label intake, but there is no provider order whose siblings to fetch.
        const orderIds = [...new Set(page.shipments.map(shipment => shipment.orderId)
          .filter((orderId): orderId is number => typeof orderId === "number"))];
        for (const orderId of orderIds) {
          const labels: ShipStationLabelSnapshot[] = [];
          for (let orderPage = 1; ; orderPage++) {
            await dependencies.repository.renew(claim, dependencies.clock.now());
            const related = await dependencies.source.listOrderLabels(orderId, orderPage);
            labels.push(...related.shipments);
            if (related.page >= related.pages) break;
            if (orderPage >= MAX_ORDER_LABEL_PAGES) throw new LabelReconciliationError("SHIPSTATION_ORDER_LABEL_LIMIT");
          }
          if (new Set(labels.map(label => label.shipmentId)).size !== labels.length) {
            throw new LabelReconciliationError("SHIPSTATION_ORDER_LABEL_PAGE_OVERLAP");
          }
          // The order snapshot must still include the exact void just read.
          // Never replace a proven void with a stale active snapshot.
          for (const voided of page.shipments.filter(label => label.orderId === orderId)) {
            if (!labels.some(label => label.shipmentId === voided.shipmentId && label.voidDate)) {
              throw new LabelReconciliationError("SHIPSTATION_VOID_SNAPSHOT_CONFLICT");
            }
          }
          await dependencies.repository.renew(claim, dependencies.clock.now());
          await dependencies.processLabels([
            ...labels.filter(label => Boolean(label.voidDate)),
            ...labels.filter(label => !label.voidDate),
          ]);
        }
        await dependencies.repository.completePage(claim, page.page < page.pages, dependencies.clock.now());
        return { outcome: "processed", voids: page.shipments.length, orders: orderIds.length };
      } catch (error) {
        const code = error instanceof LabelReconciliationError ? error.code : "SHIPSTATION_LABEL_SCAN_FAILED";
        // Do not store provider response bodies, addresses or credentials.
        try { await dependencies.repository.fail(claim, code, dependencies.clock.now()); }
        catch (checkpointError) { throw new AggregateError([error, checkpointError], "Label reconciliation and checkpoint failure recording both failed"); }
        throw error;
      }
    },
  };
}
