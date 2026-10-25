import { eq } from "drizzle-orm";
import { omsOrderLines } from "@shared/schema";

import {
  deriveOmsLineAuthority,
  type OmsLineAuthorityState,
} from "./oms-line-authority";
import { recordOmsLineAuthorityEvent } from "./oms-line-authority-ledger";
import { guardOrderEditShopifyIngress } from "../order-edits/infrastructure/order-edit-ingress-guard";

export interface ShopifyLineReadinessSnapshot {
  externalLineItemId: string | number;
  quantity: number;
  currentQuantity?: number | null;
  fulfillableQuantity: number;
}

export interface ReconcileShopifyLineReadinessInput {
  db: any;
  omsOrderId: number;
  financialStatus: string | null | undefined;
  sourceEventId: string;
  lineItems: ShopifyLineReadinessSnapshot[];
  now?: Date;
  channelUpdatedAt?: Date | string | null;
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
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(
      `Shopify readiness ${field} must be a positive integer (got ${String(value)})`,
    );
  }
  return normalized;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
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
    channelCurrentQuantity: state.channelCurrentQuantity,
    channelQuantityUpdatedAt: state.channelQuantityUpdatedAt,
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
  if (input.channelUpdatedAt == null || !Number.isFinite(new Date(input.channelUpdatedAt).getTime()))
    throw new Error("Channel quantity reconciliation requires the native order version.");

  const snapshots = input.lineItems.map((line, index) => {
    if (line.currentQuantity == null)
      throw new Error("Shopify readiness requires the native current quantity for every line.");
    return {
      externalLineItemId: normalizeExternalLineItemId(line.externalLineItemId),
      quantity: requireNonNegativeInteger(
        line.quantity,
        `lineItems[${index}].quantity`,
      ),
      currentQuantity: requireNonNegativeInteger(
        line.currentQuantity,
        `lineItems[${index}].currentQuantity`,
      ),
      fulfillableQuantity: requireNonNegativeInteger(
        line.fulfillableQuantity,
        `lineItems[${index}].fulfillableQuantity`,
      ),
    };
  });
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
    if ((await guardOrderEditShopifyIngress(tx,omsOrderId,null,now)).skipLines) return {
      checkedLines:snapshots.length,matchedLines:0,advancedLines:0,advancedQuantity:0,missingLines:0,quantityMismatches:0,
      protectedLines:snapshots.length,nonShippableLines:0,wmsSyncRequired:false,
    };
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
      if (line.authorizationStatus === "review") {
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
        currentQuantity: snapshot.currentQuantity,
        channelUpdatedAt: input.channelUpdatedAt,
        fulfillableQuantity: snapshot.fulfillableQuantity,
        previous: line,
        now,
      });
      if (authority.staleChannelObservation) continue;

      const quantityChanged = authority.authorityFulfillableQuantity !== previousAuthority;
      const channelObservationChanged = line.channelCurrentQuantity !== authority.channelCurrentQuantity
          || new Date(line.channelQuantityUpdatedAt ?? 0).getTime() !== authority.channelQuantityUpdatedAt?.getTime();
      if (quantityChanged || channelObservationChanged) {
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

        if (authority.authorityFulfillableQuantity > previousAuthority) {
          result.advancedLines++;
          result.advancedQuantity += authority.authorityFulfillableQuantity - previousAuthority;
        }
        result.wmsSyncRequired = true;
      }

      const effectiveAuthority = authority.authorityFulfillableQuantity;
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
