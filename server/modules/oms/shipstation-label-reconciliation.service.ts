import { z } from "zod";
import type { ShipStationLabelCommercialFulfillmentShipment } from "../shipping/package-allocation-label-commercial-fulfillment.service";

const DAY_MS = 24 * 60 * 60 * 1_000;
const PROVIDER_SETTLE_MS = 2 * 60 * 1_000;
export const LABEL_RECONCILIATION_LEASE_MS = 5 * 60 * 1_000;
export const VOID_PAGE_SIZE = 10;
export const ORDER_LABEL_PAGE_SIZE = 100;
const MAX_ORDER_LABEL_PAGES = 5;
const MAX_RECOVERY_JOBS_PER_RUN = 10;
export const MAX_LABEL_RECOVERY_ATTEMPTS = 8;
export interface LabelRecoverySeed { providerLabelId: number; providerOrderId: number | null; trackingNumber: string }
export interface LabelRecoveryClaim extends LabelRecoverySeed { version: number; attempts: number }
export interface LabelRecoveryCompletion {
  state: "complete" | "pending" | "review"; code: string | null; nextAttemptAt: Date | null;
}

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
  completePage(claim: LabelScanClaim, hasMore: boolean, now: Date, discovered?: readonly LabelRecoverySeed[]): Promise<void>;
  fail(claim: LabelScanClaim, code: string, now: Date): Promise<void>;
  claimOrder(now: Date): Promise<LabelRecoveryClaim | null>;
  renewOrder(claim: LabelRecoveryClaim, now: Date): Promise<void>;
  finishOrder(claim: LabelRecoveryClaim, completion: LabelRecoveryCompletion, now: Date): Promise<void>;
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
  getLabel(labelId: number, trackingNumber: string): Promise<ShipStationLabelSnapshot>;
}

export class LabelReconciliationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "LabelReconciliationError"; }
}

export function labelRecoveryFailure(error: unknown, attempts: number, now: Date): LabelRecoveryCompletion {
  z.number().int().min(1).max(MAX_LABEL_RECOVERY_ATTEMPTS).parse(attempts); z.date().parse(now);
  const code = error instanceof LabelReconciliationError ? error.code : "SHIPSTATION_ORDER_RECOVERY_FAILED";
  const permanent = code === "SHIPSTATION_ORDER_LABEL_LIMIT" || code === "SHIPSTATION_LABEL_LOOKUP_LIMIT" || code === "SHIPSTATION_LABEL_PAGE_INVALID";
  if (permanent || attempts >= MAX_LABEL_RECOVERY_ATTEMPTS) return { state: "review", code, nextAttemptAt: null };
  const delay = Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** (attempts - 1));
  return { state: "pending", code, nextAttemptAt: new Date(now.getTime() + delay) };
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
  logger?: { error(event: Readonly<Record<string, unknown>>): void };
}) {
  const logger = dependencies.logger ?? { error: (event: Readonly<Record<string, unknown>>) => console.error(JSON.stringify(event)) };
  async function recoverOrders(): Promise<{ recovered: number; deferred: number; reviewRequired: number }> {
    const result = { recovered: 0, deferred: 0, reviewRequired: 0 };
    // Retain only completed void identities, not up to ten orders of raw
    // shipment contents in the web dyno's heap.
    const completedOrderVoids = new Map<number, ReadonlySet<number>>();
    for (let index = 0; index < MAX_RECOVERY_JOBS_PER_RUN; index++) {
      const job = await dependencies.repository.claimOrder(dependencies.clock.now());
      if (!job) break;
      let completion: LabelRecoveryCompletion;
      try {
        const original = await dependencies.source.getLabel(job.providerLabelId, job.trackingNumber);
        if (original.shipmentId !== job.providerLabelId || original.trackingNumber !== job.trackingNumber
          || (original.orderId ?? null) !== job.providerOrderId || !original.voidDate || original.voided === false) {
          throw new LabelReconciliationError("SHIPSTATION_VOID_SNAPSHOT_CONFLICT");
        }
        await dependencies.repository.renewOrder(job, dependencies.clock.now());
        await dependencies.processLabels([original]);
        if (job.providerOrderId !== null && !completedOrderVoids.get(job.providerOrderId)?.has(job.providerLabelId)) {
          const labels: ShipStationLabelSnapshot[] = [];
          for (let page = 1; ; page++) {
            await dependencies.repository.renewOrder(job, dependencies.clock.now());
            const related = await dependencies.source.listOrderLabels(job.providerOrderId, page);
            labels.push(...related.shipments);
            if (related.page >= related.pages) break;
            if (page >= MAX_ORDER_LABEL_PAGES) throw new LabelReconciliationError("SHIPSTATION_ORDER_LABEL_LIMIT");
          }
          if (new Set(labels.map(label => label.shipmentId)).size !== labels.length) throw new LabelReconciliationError("SHIPSTATION_ORDER_LABEL_PAGE_OVERLAP");
          if (!labels.some(label => label.shipmentId === job.providerLabelId && label.voidDate)) throw new LabelReconciliationError("SHIPSTATION_VOID_SNAPSHOT_CONFLICT");
          await dependencies.repository.renewOrder(job, dependencies.clock.now());
          await dependencies.processLabels([...labels.filter(label => Boolean(label.voidDate)), ...labels.filter(label => !label.voidDate)]);
          completedOrderVoids.set(job.providerOrderId, new Set(labels.filter(label => Boolean(label.voidDate)).map(label => label.shipmentId)));
        }
        completion = { state: "complete", code: null, nextAttemptAt: null };
      } catch (error) {
        // A lost fencing lease belongs to a different attempt; never mark it.
        if (error instanceof LabelReconciliationError && error.code === "SHIPSTATION_LABEL_SCAN_LEASE_LOST") {
          result.deferred++;
          logger.error({ code: error.code, providerLabelId: job.providerLabelId });
          continue;
        }
        completion = labelRecoveryFailure(error, job.attempts, dependencies.clock.now());
      }
      try {
        await dependencies.repository.finishOrder(job, completion, dependencies.clock.now());
      } catch {
        // The uncommitted job remains leased and will be retried after expiry.
        // Do not turn a receipt failure into success, or block unrelated jobs.
        result.deferred++;
        logger.error({ code: 'SHIPSTATION_LABEL_RECOVERY_RECEIPT_FAILED', providerLabelId: job.providerLabelId });
        continue;
      }
      if (completion.state === 'complete') result.recovered++;
      else if (completion.state === 'pending') result.deferred++;
      else {
        result.reviewRequired++;
        logger.error({ code: 'SHIPSTATION_LABEL_RECOVERY_REVIEW_REQUIRED',
          providerOrderId: job.providerOrderId, providerLabelId: job.providerLabelId, reason: completion.code, attempts: job.attempts });
      }
    }
    return result;
  }
  return {
    async runOnce(): Promise<{ outcome: "disabled" | "idle" | "busy" | "processed"; voids: number; orders: number;
      recovered?: number; deferred?: number; reviewRequired?: number }> {
      if (!dependencies.source.isConfigured()) return { outcome: "disabled", voids: 0, orders: 0 };
      const now = z.date().parse(dependencies.clock.now());
      const checkpoint = await dependencies.repository.readOrCreate(new Date(now.getTime() - DAY_MS), now);
      const window = planLabelScanWindow(checkpoint, now);
      if (!window) return { outcome: "idle", voids: 0, orders: 0, ...await recoverOrders() };
      const claim = await dependencies.repository.claim(checkpoint, window, now);
      if (!claim) return { outcome: "busy", voids: 0, orders: 0, ...await recoverOrders() };
      let discoveredVoids = 0;
      let discoveredOrders = 0;
      try {
        const page = await dependencies.source.listVoids(claim.window);
        await dependencies.repository.renew(claim, dependencies.clock.now());
        // Discovery and durable handoff commit together. A failed order no
        // longer prevents unrelated orders or later pages from being found.
        await dependencies.repository.completePage(claim, page.page < page.pages, dependencies.clock.now(),
          page.shipments.map(label => ({ providerLabelId: label.shipmentId, providerOrderId: label.orderId ?? null, trackingNumber: label.trackingNumber })));
        discoveredVoids = page.shipments.length;
        discoveredOrders = new Set(page.shipments.map(label => label.orderId).filter(id => id != null)).size;
      } catch (error) {
        const code = error instanceof LabelReconciliationError ? error.code : "SHIPSTATION_LABEL_SCAN_FAILED";
        // Do not store provider response bodies, addresses or credentials.
        try { await dependencies.repository.fail(claim, code, dependencies.clock.now()); }
        catch (checkpointError) { throw new AggregateError([error, checkpointError], "Label reconciliation and checkpoint failure recording both failed"); }
        // Discovery outages must not prevent already-discovered work recovering.
        // Preserve the scan failure for the scheduler after servicing that lane.
        await recoverOrders();
        throw error;
      }
      return { outcome: 'processed', voids: discoveredVoids, orders: discoveredOrders, ...await recoverOrders() };
    },
  };
}
