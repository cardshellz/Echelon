import type { QuantityPublicationScope } from "../domain/quantity-publication-admission";
import { classifyQuantityCatchupFailure, quantityCatchupEscalation, type QuantityCatchupFailureClass } from "../domain/quantity-publication-catchup-parking";
import { logger as platformLogger } from "../../../platform/observability/logger";
import type { ListingSetupIntent, ListingSetupInspectionInput, ListingSetupInspection } from "./listing-setup-intent";
export type { ListingSetupIntent } from "./listing-setup-intent";

export interface QuantityPublicationOutboxClaim {
  outboxId: string; activationRunId: string; publicationTargetId: number;
  productVariantId: number; desiredRevision: string; desiredQuantity: string; leaseToken: string;
  destinationKind: "channel_connection" | "dropship_store_connection";
  channelConnectionId: number | null; dropshipStoreConnectionId: number | null;
  providerKey: string; providerScopeType: "account" | "location";
  externalScopeId: string; externalInventoryItemId: string; externalSku: string | null;
}

/** No provider callback is ever accepted by a caller-owned transaction API. */
export interface QuantityPublicationAdmission {
  inspectListingSetup(input: ListingSetupInspectionInput): Promise<ListingSetupInspection>;
  runListingSetup<T>(input: ListingSetupIntent, work: (validated: Readonly<ListingSetupIntent>) => Promise<T>): Promise<T>;
  run<T>(scope: QuantityPublicationScope, work: () => Promise<T>): Promise<T>;
  runListing<T>(scope: QuantityPublicationScope,
    resolveCurrentPlan: () => Promise<{ outboxId: string; quantity: number }>,
    work: (canonicalQuantity: number | null) => Promise<T>): Promise<T>;
  runListingGroup<T>(scope: QuantityPublicationScope, memberScopes: readonly QuantityPublicationScope[],
    resolveCurrentPlan: (scope: QuantityPublicationScope) => Promise<{ outboxId: string; quantity: number }>,
    work: (canonicalQuantities: ReadonlyMap<string, number> | null) => Promise<T>): Promise<T>;
  runQuantityReducingLifecycle<T>(scope: QuantityPublicationScope, work: () => Promise<T>, memberScopes?: readonly QuantityPublicationScope[]): Promise<T>;
  runOutbox<T>(claim: QuantityPublicationOutboxClaim, work: () => Promise<T>): Promise<T>;
}

export interface QuantityPublicationCatchup {
  catchupId: string;
  revision: string;
  attemptBoundaryId: string;
  scope: QuantityPublicationScope;
}
/** How a failure was persisted: transient returns the attempt count it reached (null: a newer revision superseded it). */
export type QuantityPublicationCatchupRetryClass = Exclude<QuantityCatchupFailureClass, "parked">;
/** What a missing-link refusal became (Channels PR5): settled with an identity_retired receipt, parked to wait for a
 * link, or retried because the item turned out linked (transient) or a lock was busy (paused). */
export type QuantityPublicationCatchupParkOutcome = "settled" | "parked" | "transient" | "paused" | "superseded";
export interface QuantityPublicationCatchupStore {
  listDue(limit: number): Promise<QuantityPublicationCatchup[]>;
  complete(claim: QuantityPublicationCatchup, evidence?: { outboxId: string }): Promise<boolean>;
  settleArchived(claim: QuantityPublicationCatchup): Promise<boolean>;
  fail(claim: QuantityPublicationCatchup, errorCode: string, message: string,
    retryClass?: QuantityPublicationCatchupRetryClass): Promise<number | null | void>;
  park(claim: QuantityPublicationCatchup, errorCode: string, message: string): Promise<QuantityPublicationCatchupParkOutcome>;
}

type CatchupLog = Pick<typeof platformLogger, "debug" | "info" | "warn" | "error">;

/** Rebuilds from CURRENT authoritative data. Stored quantity/listing payloads are not replay input. */
export class QuantityPublicationCatchupService {
  constructor(private readonly store: QuantityPublicationCatchupStore,
    private readonly replan: (scope: QuantityPublicationScope, claim: QuantityPublicationCatchup) => Promise<void | { outboxId: string }>,
    private readonly recoverResponses?: (limit: number) => Promise<unknown>,
    private readonly log: CatchupLog = platformLogger) {}

  async processDue(limit = 25): Promise<{ completed: number; failed: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid catch-up batch size.");
    // The due-work query intentionally excludes unresolved attempts. Recover
    // provable final responses first, so safe follow-up work becomes eligible.
    await this.recoverResponses?.(limit);
    const result = { completed: 0, failed: 0 };
    for (const claim of await this.store.listDue(limit)) {
      try {
        // A provider may have completed after retention, or before a prior
        // worker lost its acknowledgement. Prove that exact revision first:
        // unrelated planning failures must not repeatedly retry delivered work.
        if (await this.store.complete(claim)) {
          result.completed += 1;
          continue;
        }
        // An exact Catalog archive can end local stock duty without claiming
        // provider success. The store proves and audits that disposition.
        if (await this.store.settleArchived(claim)) {
          result.completed += 1;
          continue;
        }
        const evidence = await this.replan(claim.scope, claim);
        if (await this.store.complete(claim, evidence || undefined)) result.completed += 1;
        else {
          await this.recordFailure(claim, "PUBLICATION_CATCHUP_DELIVERY_UNPROVEN", "No exact-scope completed provider attempt or current canonical outbox proves this revision was handed off.", undefined);
          result.failed += 1;
        }
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "PUBLICATION_CATCHUP_FAILED";
        const retryable = error instanceof Error && "retryable" in error ? error.retryable : undefined;
        if (await this.recordFailure(claim, code, error instanceof Error ? error.message : String(error), retryable)) result.completed += 1;
        else result.failed += 1;
      }
    }
    return result;
  }

  /** Persists the failure by its class. Returns true only when a missing-link refusal settled the row instead. */
  private async recordFailure(claim: QuantityPublicationCatchup, code: string, message: string, retryable: unknown): Promise<boolean> {
    const failureClass = classifyQuantityCatchupFailure({ code, retryable });
    const context = { catchup_id: claim.catchupId, revision: claim.revision, error_code: code,
      provider_key: claim.scope.providerKey, connection_id: claim.scope.connectionId,
      external_inventory_item_id: claim.scope.externalInventoryItemId, product_variant_id: claim.scope.productVariantId };
    if (failureClass === "parked") {
      let outcome: QuantityPublicationCatchupParkOutcome;
      try { outcome = await this.store.park(claim, code, message); }
      catch (parkError) {
        // The park proof itself failed (e.g. the saved scope no longer matches its row). Persist that failure by its
        // own class instead of aborting the batch; a missing-link class here would loop, so it falls back to transient.
        const parkCode = parkError instanceof Error && "code" in parkError ? String(parkError.code) : "PUBLICATION_CATCHUP_PARK_FAILED";
        const parkClass = classifyQuantityCatchupFailure({ code: parkCode,
          retryable: parkError instanceof Error && "retryable" in parkError ? parkError.retryable : undefined });
        return this.persist(claim, parkCode, parkError instanceof Error ? parkError.message : String(parkError),
          parkClass === "parked" ? "transient" : parkClass, context);
      }
      // Waiting for a link is expected, not an anomaly (CLAUDE.md section 10): DEBUG; a settlement is a state change.
      if (outcome === "settled") this.log.info("inventory.quantity_catchup.settled_identity_retired", { outcome, ...context });
      else this.log.debug("inventory.quantity_catchup.parked", { outcome, ...context });
      return outcome === "settled";
    }
    return this.persist(claim, code, message, failureClass, context);
  }

  private async persist(claim: QuantityPublicationCatchup, code: string, message: string,
    failureClass: QuantityPublicationCatchupRetryClass, context: Record<string, unknown>): Promise<false> {
    const attempts = await this.store.fail(claim, code, message, failureClass);
    const logged = { ...context, error_code: code };
    if (failureClass === "permanent") {
      this.log.error("inventory.quantity_catchup.requires_review", { outcome: "requires_review", error_class: failureClass, ...logged });
    } else if (failureClass === "transient" && typeof attempts === "number") {
      const level = quantityCatchupEscalation(attempts);
      if (level) this.log[level]("inventory.quantity_catchup.retrying", { outcome: "retrying", error_class: failureClass, attempt_count: attempts, ...logged });
      else this.log.debug("inventory.quantity_catchup.retrying", { outcome: "retrying", error_class: failureClass, attempt_count: attempts, ...logged });
    } else this.log.debug("inventory.quantity_catchup.deferred", { outcome: failureClass, error_class: failureClass, ...logged });
    return false;
  }
}
