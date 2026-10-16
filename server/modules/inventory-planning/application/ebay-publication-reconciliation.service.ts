import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { InventoryPublicationTransportError, type AbsoluteInventoryReadRequest, type InventoryPublicationTransportRegistry } from "./inventory-publication-transport";
import { ebayReconciliationCommandKey } from "../domain/ebay-automatic-publication-recovery";
import { QuantityPublicationAdmissionError, type QuantityPublicationScope } from "../domain/quantity-publication-admission";
import { InventoryAvailabilityRuntimePublicationError } from "./inventory-availability-runtime-publication.service";

export const EBAY_RECONCILIATION_INTERVAL_MS = 15 * 60_000;
export const EBAY_RECONCILIATION_LEASE_MS = 2 * 60_000;
export interface EbayPublicationReconciliationStatus {
  state: "pending" | "verified" | "needs_attention";
  checkedAt: string | null; nextCheckAt: string; code: string | null; message: string | null;
}
export interface EbayReconciliationClaim {
  watchId: string; revision: string; cycle: string; leaseToken: string; attempts: number;
  productId: number; connectionId: number; accountId: string; scopes: QuantityPublicationScope[];
}
export interface EbayReconciliationTarget extends AbsoluteInventoryReadRequest {
  outboxId: string; publicationTargetId: number; publicationTargetRevision: string;
  desiredRevision: string; desiredQuantity: string;
}
export interface EbayReconciliationObservation {
  target: EbayReconciliationTarget; observedQuantity: number; quantityConsistent: boolean; providerResponseHash: string; observedAt: Date;
}
export interface EbayReconciliationStockResult { current: boolean; repaired: boolean; checkedAt: Date; outboxIds: string[] }
export interface EbayPublicationReconciliationStore {
  claimDue(limit: number, now: Date, leaseToken: string): Promise<EbayReconciliationClaim[]>;
  renew(claim: EbayReconciliationClaim, now: Date): Promise<void>;
  plan(claim: EbayReconciliationClaim, now: Date): Promise<EbayReconciliationTarget[]>;
  recordStock(claim: EbayReconciliationClaim, observations: readonly EbayReconciliationObservation[], now: Date): Promise<EbayReconciliationStockResult>;
  finish(claim: EbayReconciliationClaim, stock: EbayReconciliationStockResult, contentJobId: string, now: Date): Promise<void>;
  fail(claim: EbayReconciliationClaim, failure: { code: string; message: string; commandConsumed: boolean; contentJobId?: string }, now: Date): Promise<void>;
  readStatuses(syncJobIds: readonly string[]): Promise<Record<string, EbayPublicationReconciliationStatus>>;
}
export type RefreshRecoveredEbayContent = (input: {
  productId: number; connectionId: number; accountId: string; commandKey: string;
}) => Promise<{ jobId: string }>;

/** Only a durable channel admission rejection permits a new cycle command key.
 * Transport/DB uncertainty must replay the same key to recover its saved result. */
export class EbayPublicationContentRefreshRejectedError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "EbayPublicationContentRefreshRejectedError"; }
}

/** Recurring reconciliation never expires an unknown remote effect. Each pass
 * observes current authority and repairs only through the canonical publisher. */
export class EbayPublicationReconciliationService {
  constructor(private readonly store: EbayPublicationReconciliationStore,
    private readonly adapters: Pick<InventoryPublicationTransportRegistry, "get">,
    private readonly refreshContent: RefreshRecoveredEbayContent,
    private readonly clock: () => Date = () => new Date(), private readonly tokenFactory: () => string = randomUUID) {}

  async processDue(limit = 10): Promise<{ checked: number; repaired: number; blocked: number }> {
    z.number().int().min(1).max(100).parse(limit);
    const result = { checked: 0, repaired: 0, blocked: 0 };
    for (let index = 0; index < limit; index += 1) {
      // Lease just before processing. Sequential remote reads must not consume
      // the lease of a later member of a preclaimed batch.
      const [claim] = await this.store.claimDue(1, this.now(), z.string().uuid().parse(this.tokenFactory()));
      if (!claim) break;
      let stock: EbayReconciliationStockResult | undefined;
      let failure: unknown;
      let contentJobId: string | undefined;
      try {
        const targets = await this.store.plan(claim, this.now());
        const observations: EbayReconciliationObservation[] = [];
        for (const target of targets) {
          await this.store.renew(claim, this.now());
          const adapter = this.adapters.get(target.destination.kind, "ebay");
          if (!adapter || !adapter.supportedScopeTypes.includes(target.providerScopeType)) {
            throw new QuantityPublicationAdmissionError("PUBLICATION_READBACK_UNSUPPORTED", "No exact eBay stock readback is configured.");
          }
          const observed = await adapter.readAbsolute(target);
          z.number().int().nonnegative().safe().parse(observed.observedQuantity);
          z.boolean().optional().parse(observed.quantityConsistent);
          observations.push({ target, observedQuantity: observed.observedQuantity, quantityConsistent: observed.quantityConsistent !== false,
            providerResponseHash: createHash("sha256").update(canonicalJson(observed.providerResponse)).digest("hex"), observedAt: this.now() });
        }
        stock = await this.store.recordStock(claim, observations, this.now());
        if (!stock.current) throw new QuantityPublicationAdmissionError("PUBLICATION_RECONCILIATION_PLAN_CHANGED",
          "Canonical stock changed during the read. The saved check will use its current revision.");
      } catch (error) { failure = error; }
      // A new stock writer may itself have lost a response. The channel Sync
      // owns automatic recovery, so failed stock checks cannot prevent enqueue.
      // An exact mapping mismatch is different: never follow another identity.
      if (!(failure instanceof QuantityPublicationAdmissionError && failure.code === "PUBLICATION_RECONCILIATION_SCOPE_CHANGED")) {
        try {
          await this.store.renew(claim, this.now());
          const content = await this.refreshContent({ productId: claim.productId, connectionId: claim.connectionId,
            accountId: claim.accountId, commandKey: ebayReconciliationCommandKey(claim.watchId, claim.cycle) });
          contentJobId = z.string().uuid().parse(content.jobId);
        } catch (error) { failure = error; }
      }
      try {
        if (!failure && stock?.current && contentJobId) {
          await this.store.finish(claim, stock, contentJobId, this.now());
          result.checked += 1;
          if (stock.repaired) result.repaired += 1;
          continue;
        }
      } catch (error) {
        // finish may have committed before a connection was lost. Its lease
        // compare-and-set prevents a failure report rewinding that newer cycle.
        failure = error;
      }
      const diagnostic = publicReconciliationFailure(failure);
      try {
        await this.store.fail(claim, { ...diagnostic,
          commandConsumed: contentJobId !== undefined || failure instanceof EbayPublicationContentRefreshRejectedError,
          ...(contentJobId ? { contentJobId } : {}) }, this.now());
      } catch {
        console.error(JSON.stringify({ event: "ebay_publication_reconciliation_persistence_failed", watchId: claim.watchId,
          code: "PUBLICATION_RECONCILIATION_PERSISTENCE_FAILED" }));
      }
      result.blocked += 1;
    }
    return result;
  }
  private now(): Date { return new Date(z.date().parse(this.clock())); }
}

function publicReconciliationFailure(error: unknown): { code: string; message: string } {
  if (error instanceof QuantityPublicationAdmissionError || error instanceof InventoryPublicationTransportError
    || error instanceof InventoryAvailabilityRuntimePublicationError || error instanceof EbayPublicationContentRefreshRejectedError) {
    return { code: error.code.slice(0, 100), message: error.message.slice(0, 1000) };
  }
  return { code: "PUBLICATION_RECONCILIATION_FAILED", message: "The saved stock check could not finish. It will retry automatically; historical request outcomes remain unknown." };
}
