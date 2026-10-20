import { and, eq, inArray } from "drizzle-orm";
import { poExceptions } from "@shared/schema/procurement.schema";
import { computePayloadHash } from "./po-exceptions.service";
import type {
  AmendmentPlan,
  AmendmentLine,
} from "./po-quantity-amendment.policy";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";
import { planPurchaseOrderQuantityExceptions } from "./purchase-order-quantity-exceptions.policy";

/** Replace only quantity exceptions whose ordered evidence changed. The old
 * payload remains as history; unrelated decisions are not revoked. */
export async function replacePurchaseOrderQuantityExceptions(
  tx: AmendmentTransaction,
  exceptions: Array<typeof poExceptions.$inferSelect>,
  plan: AmendmentPlan,
  actorId: string,
  at: Date,
  sourceLines: readonly AmendmentLine[],
) {
  const replaced: number[] = [];
  for (const {
    supersededIds,
    replacement,
  } of planPurchaseOrderQuantityExceptions(exceptions, plan, sourceLines)) {
    if (supersededIds.length) {
      await tx
        .update(poExceptions)
        .set({
          status: "dismissed",
          dismissedBy: actorId,
          dismissedAt: at,
          dismissNote:
            "Superseded by the approved PO quantity and current received count.",
          updatedAt: at,
        })
        .where(
          and(
            eq(poExceptions.poId, plan.preview.purchaseOrderId),
            inArray(poExceptions.id, supersededIds),
          ),
        );
      replaced.push(...supersededIds);
    }
    if (!replacement) continue;
    await tx.insert(poExceptions).values({
      ...replacement,
      poId: plan.preview.purchaseOrderId,
      severity: "warn",
      status: "open",
      payloadHash: computePayloadHash(
        plan.preview.purchaseOrderId,
        replacement.kind,
        replacement.payload,
      ),
      detectedBy: "system",
      detectedAt: at,
      updatedAt: at,
    });
  }
  return replaced;
}
