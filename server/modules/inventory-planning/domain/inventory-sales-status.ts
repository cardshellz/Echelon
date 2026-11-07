import type { InventoryPublicationTargetHold } from "@shared/types/inventory-channel-exposure";
import type { SalesStatus, SalesStatusChange, SalesStatusScope } from "@shared/types/inventory-sales-status";
import { resolveSalesStatus, salesStatusScopeKey } from "@shared/inventory/sales-status-resolution";

export { levelSetting, resolveSalesStatus, salesStatusScopeKey } from "@shared/inventory/sales-status-resolution";

/**
 * Sales status rules that need no database: what a change does to the stored
 * settings, and how a Stopped setting becomes the hold the publication planner
 * applies. See shared/types/inventory-sales-status.ts for the contract.
 */

/** The stored setting at one scope, as a command sees it before changing it. */
export interface CurrentSalesStatus {
  scopeKey: string;
  scope: SalesStatusScope;
  status: SalesStatus;
  revision: string;
}

export type SalesStatusOperation =
  | { kind: "insert"; scopeKey: string; scope: SalesStatusScope; status: SalesStatus; before: null }
  | { kind: "update"; scopeKey: string; scope: SalesStatusScope; status: SalesStatus; before: CurrentSalesStatus }
  | { kind: "delete"; scopeKey: string; scope: SalesStatusScope; before: CurrentSalesStatus }
  | { kind: "none"; scopeKey: string; scope: SalesStatusScope; before: CurrentSalesStatus | null };

export interface SalesStatusConflict {
  scopeKey: string;
  expectedRevision: string | null;
  currentRevision: string | null;
}

export type SalesStatusPlan =
  | { ok: true; operations: SalesStatusOperation[] }
  | { ok: false; conflicts: SalesStatusConflict[] };

/**
 * Decides each requested change against the current settings. Every change
 * names the revision its operator saw (null for "no setting"); if any scope
 * moved since, the whole command is refused so nobody overwrites a change
 * they have not seen. A scope already in the requested state is left alone.
 * Pure and order-preserving.
 */
export function planSalesStatusChanges(
  current: ReadonlyMap<string, CurrentSalesStatus>,
  changes: readonly SalesStatusChange[],
): SalesStatusPlan {
  const conflicts: SalesStatusConflict[] = [];
  const operations: SalesStatusOperation[] = [];
  for (const change of changes) {
    const scopeKey = salesStatusScopeKey(change.scope);
    const before = current.get(scopeKey) ?? null;
    const currentRevision = before?.revision ?? null;
    if (currentRevision !== change.expectedRevision) {
      conflicts.push({ scopeKey, expectedRevision: change.expectedRevision, currentRevision });
      continue;
    }
    if (change.status === "inherit") {
      operations.push(before
        ? { kind: "delete", scopeKey, scope: change.scope, before }
        : { kind: "none", scopeKey, scope: change.scope, before: null });
    } else if (!before) {
      operations.push({ kind: "insert", scopeKey, scope: change.scope, status: change.status, before: null });
    } else if (before.status === change.status) {
      operations.push({ kind: "none", scopeKey, scope: change.scope, before });
    } else {
      operations.push({ kind: "update", scopeKey, scope: change.scope, status: change.status, before });
    }
  }
  return conflicts.length > 0 ? { ok: false, conflicts } : { ok: true, operations };
}

/** The products whose published stock a set of scopes can change, sorted and unique. */
export function affectedSalesStatusProductIds(
  scopes: readonly SalesStatusScope[],
): number[] {
  return [...new Set(scopes.map((scope) => scope.productId))].sort((left, right) => left - right);
}

/** What the planner needs from a stored setting to explain the zero it publishes. */
export interface SalesStatusHoldSource {
  scopeKey: string;
  scope: Pick<SalesStatusScope, "channelId" | "productVariantId">;
  status: SalesStatus;
  updatedBy: string;
  updatedAt: string;
}

/**
 * A Stopped setting expressed as a publication hold, so the planner zeroes the
 * SKU exactly as it does for any other hold (applyPublicationHold): canonical
 * ATP is kept, every later stage is zero. The reason names the scope, never the
 * free-text note, so it stays within the hold contract's 120 characters.
 */
export function salesStatusHold(source: SalesStatusHoldSource): InventoryPublicationTargetHold {
  const where = source.scope.channelId === null ? "all channels" : "this channel";
  const item = source.scope.productVariantId === null ? "product" : "SKU";
  return {
    reason: `Sales status: stopped on ${where} (${item} setting)`,
    heldAt: source.updatedAt,
    heldBy: source.updatedBy,
  };
}

/**
 * The SKUs a destination of `channelId` must publish at zero because a sales
 * status stops them, each with the hold that explains it. `entries` are every
 * setting for the product and its SKUs.
 */
export function salesStatusStopsForChannel<TEntry extends SalesStatusHoldSource>(input: {
  channelId: number;
  productId: number;
  productVariantIds: readonly number[];
  entries: readonly TEntry[];
}): Array<{ productVariantId: number; hold: InventoryPublicationTargetHold }> {
  if (input.entries.length === 0) return [];
  return [...new Set(input.productVariantIds)].sort((left, right) => left - right).flatMap((productVariantId) => {
    const resolution = resolveSalesStatus({
      channelId: input.channelId,
      productId: input.productId,
      productVariantId,
      entries: input.entries,
    });
    return resolution.status === "stopped" && resolution.source
      ? [{ productVariantId, hold: salesStatusHold(resolution.source) }]
      : [];
  });
}

/**
 * How a failure must be handled. Transient: retry the same command (same
 * idempotency key). Permanent: retrying the same request cannot succeed; the
 * operator must reload or correct it.
 */
export type SalesStatusErrorClass = "transient" | "permanent";

export class SalesStatusError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly classification: SalesStatusErrorClass,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "SalesStatusError";
  }
}
