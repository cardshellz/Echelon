import { eq } from "drizzle-orm";
import { omsOrderLines } from "@shared/schema";

import {
  deriveOmsLineAuthority,
  type OmsLineAuthorityState,
} from "./oms-line-authority";
import { recordOmsLineAuthorityEvent } from "./oms-line-authority-ledger";

export interface ShopifyLineReadinessSnapshot {
  externalLineItemId: string | number;
  quantity: number;
  fulfillableQuantity: number;
}

export interface ReconcileShopifyLineReadinessInput {
  db: any;
  omsOrderId: number;
  financialStatus: string | null | undefined;
  sourceEventId: string;
  lineItems: ShopifyLineReadinessSnapshot[];
  now?: Date;
}

export interface ReconcileShopifyLineReadinessResult {
  checkedLines: number;
  matchedLines: number;
  advancedLines: number;
  advancedQuantity: number;
  missingLines: number;
  quantityMismatches: number;
  protectedLines: number;
  nonShippableLines: number;
  wmsSyncRequired: boolean;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(
      `Shopify readiness ${field} must be a positive integer (got ${String(value)})`,
    );
  }
  return normalized;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(
      `Shopify readiness ${field} must be a non-negative integer (got ${String(value)})`,
    );
  }
  return normalized;
}

function normalizeExternalLineItemId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (normalized.length === 0) {
    throw new Error("Shopify readiness externalLineItemId is required");
  }
  return normalized;
}

function authorityPatch(state: OmsLineAuthorityState) {
  return {
    channelObservedQuantity: state.channelObservedQuantity,
    paidQuantity: state.paidQuantity,
    authorityFulfillableQuantity: state.authorityFulfillableQuantity,
    authorizationStatus: state.authorizationStatus,
    authorizedAt: state.authorizedAt,
    authorizedByEventId: state.authorizedByEventId,
    authoritySourceTopic: state.authoritySourceTopic,
    authoritySourceInboxId: state.authoritySourceInboxId,
  };
}

export async function reconcileShopifyLineReadiness(
  input: ReconcileShopifyLineReadinessInput,
): Promise<ReconcileShopifyLineReadinessResult> {
  const omsOrderId = requirePositiveInteger(input.omsOrderId, "omsOrderId");
  const sourceEventId = String(input.sourceEventId ?? "").trim();
  if (sourceEventId.length === 0) {
    throw new Error("Shopify readiness sourceEventId is required");
  }

  const snapshots = input.lineItems.map((line, index) => ({
    externalLineItemId: normalizeExternalLineItemId(line.externalLineItemId),
    quantity: requireNonNegativeInteger(
      line.quantity,
      `lineItems[${index}].quantity`,
    ),
    fulfillableQuantity: requireNonNegativeInteger(
      line.fulfillableQuantity,
      `lineItems[${index}].fulfillableQuantity`,
    ),
  }));
  const uniqueLineIds = new Set(
    snapshots.map((line) => line.externalLineItemId),
  );
  if (uniqueLineIds.size !== snapshots.length) {
    throw new Error(
      "Shopify readiness snapshot contains duplicate external line item ids",
    );
  }

  const now = input.now ?? new Date();

  return input.db.transaction(async (tx: any) => {
    const lockedLines = await tx
      .select()
      .from(omsOrderLines)
      .where(eq(omsOrderLines.orderId, omsOrderId))
      .for("update");
    const linesByExternalId = new Map(
      lockedLines.map((line: any) => [
        String(line.externalLineItemId ?? ""),
        line,
      ]),
    );

    const result: ReconcileShopifyLineReadinessResult = {
      checkedLines: snapshots.length,
      matchedLines: 0,
      advancedLines: 0,
      advancedQuantity: 0,
      missingLines: 0,
      quantityMismatches: 0,
      protectedLines: 0,
      nonShippableLines: 0,
      wmsSyncRequired: false,
    };

    for (const snapshot of snapshots) {
      const line: any = linesByExternalId.get(snapshot.externalLineItemId);
      if (!line) {
        result.missingLines++;
        continue;
      }
      result.matchedLines++;

      const currentQuantity = requireNonNegativeInteger(
        line.quantity,
        "line.quantity",
      );
      if (currentQuantity !== snapshot.quantity) {
        result.quantityMismatches++;
        continue;
      }
      if (line.requiresShipping === false) {
        result.nonShippableLines++;
        continue;
      }

      const cancelledQuantity = requireNonNegativeInteger(
        line.cancelledQuantity ?? 0,
        "line.cancelledQuantity",
      );
      const refundedQuantity = requireNonNegativeInteger(
        line.refundedQuantity ?? 0,
        "line.refundedQuantity",
      );
      const authorizationStatus = String(line.authorizationStatus ?? "");
      if (
        cancelledQuantity > 0 ||
        refundedQuantity > 0 ||
        (authorizationStatus !== "seen" && authorizationStatus !== "authorized")
      ) {
        result.protectedLines++;
        continue;
      }

      const previousAuthority = requireNonNegativeInteger(
        line.authorityFulfillableQuantity ?? 0,
        "line.authorityFulfillableQuantity",
      );
      const paidQuantity = requireNonNegativeInteger(
        line.paidQuantity ?? 0,
        "line.paidQuantity",
      );
      const wmsMaterializedQuantity = requireNonNegativeInteger(
        line.wmsMaterializedQuantity ?? 0,
        "line.wmsMaterializedQuantity",
      );
      const authority = deriveOmsLineAuthority({
        sourceTopic: "shopify/reconcile",
        sourceEventId,
        financialStatus: input.financialStatus,
        quantity: snapshot.quantity,
        fulfillableQuantity: snapshot.fulfillableQuantity,
        previous: line,
        now,
      });

      if (authority.authorityFulfillableQuantity > previousAuthority) {
        await tx
          .update(omsOrderLines)
          .set({
            ...authorityPatch(authority),
            fulfillableQuantity: snapshot.fulfillableQuantity,
            updatedAt: now,
          })
          .where(eq(omsOrderLines.id, line.id));

        await recordOmsLineAuthorityEvent({
          db: tx,
          orderId: omsOrderId,
          orderLineId: Number(line.id),
          eventType: "line_updated",
          sourceEventId,
          previous: line,
          authority,
          cancelledQuantity,
          refundedQuantity,
        });

        result.advancedLines++;
        result.advancedQuantity +=
          authority.authorityFulfillableQuantity - previousAuthority;
      }

      const effectiveAuthority = Math.max(
        previousAuthority,
        authority.authorityFulfillableQuantity,
      );
      const providerReadyQuantity = Math.min(
        paidQuantity,
        snapshot.fulfillableQuantity,
      );
      if (
        providerReadyQuantity > wmsMaterializedQuantity &&
        effectiveAuthority >= providerReadyQuantity
      ) {
        result.wmsSyncRequired = true;
      }
    }

    return result;
  });
}
