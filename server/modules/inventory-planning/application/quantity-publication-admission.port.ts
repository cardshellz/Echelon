import type { QuantityPublicationScope } from "../domain/quantity-publication-admission";

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
export interface QuantityPublicationCatchupStore {
  listDue(limit: number): Promise<QuantityPublicationCatchup[]>;
  complete(claim: QuantityPublicationCatchup, evidence?: { outboxId: string }): Promise<boolean>;
  fail(claim: QuantityPublicationCatchup, errorCode: string, message: string): Promise<void>;
}

/** Rebuilds from CURRENT authoritative data. Stored quantity/listing payloads are not replay input. */
export class QuantityPublicationCatchupService {
  constructor(private readonly store: QuantityPublicationCatchupStore,
    private readonly replan: (scope: QuantityPublicationScope, claim: QuantityPublicationCatchup) => Promise<void | { outboxId: string }>) {}

  async processDue(limit = 25): Promise<{ completed: number; failed: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid catch-up batch size.");
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
        const evidence = await this.replan(claim.scope, claim);
        if (await this.store.complete(claim, evidence || undefined)) result.completed += 1;
        else {
          await this.store.fail(claim, "PUBLICATION_CATCHUP_DELIVERY_UNPROVEN", "No exact-scope completed provider attempt or current canonical outbox proves this revision was handed off.");
          result.failed += 1;
        }
      } catch (error) {
        await this.store.fail(claim, error instanceof Error && "code" in error ? String(error.code) : "PUBLICATION_CATCHUP_FAILED",
          error instanceof Error ? error.message : String(error));
        result.failed += 1;
      }
    }
    return result;
  }
}
