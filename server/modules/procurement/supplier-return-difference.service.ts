import { sql } from "drizzle-orm";
import { db } from "../../db";
import { canonicalJson } from "@shared/utils/canonical-json";
import { supplierReturnCreditReviewInputSchema, supplierReturnCreditReviewSchema } from "@shared/procurement/supplier-return-credit";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { assertSupplierReturnAuthority } from "./supplier-return.service";
import { SupplierReturnError } from "./supplier-return.errors";
import type { SupplierReturnTransaction } from "./supplier-return.repository";
import { readSupplierReturnEntitlementReview, recordSupplierReturnCreditReview } from "./supplier-return-credit-review.service";

export async function recordSupplierReturnDifferenceReview(tx: SupplierReturnTransaction, input: {
  entitlementId: number; raw: unknown; actorId: string; at: Date; commandKey: string;
}) {
  const parsed = supplierReturnCreditReviewInputSchema.safeParse(input.raw);
  if (!parsed.success) throw new SupplierReturnError("SUPPLIER_RETURN_REVIEW_INPUT_INVALID", "Review the credit attribution, evidence and reason.", 422);
  if (!(input.at instanceof Date) || !Number.isFinite(input.at.getTime())) throw new Error("Supplier return review requires a valid injected clock");
  // This is the same fence used by physical return, cost revisions and credit
  // approval/void. Validate current source and current authority only after it.
  await lockInventoryCostGraph(tx);
  await assertSupplierReturnAuthority(tx, input.actorId, "record");
  const before = await readSupplierReturnEntitlementReview(tx, input.entitlementId);
  const result = supplierReturnCreditReviewSchema.parse(await recordSupplierReturnCreditReview(tx, { ...input, raw: parsed.data }));
  await tx.execute(sql`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
    VALUES(${input.at},'AUDIT',${input.actorId},'procurement.supplier_return.review_credit_difference',${`supplier-return-entitlement:${input.entitlementId}`},
      ${canonicalJson({ before, after: result })}::jsonb,${canonicalJson({ commandKey: input.commandKey, request: parsed.data })}::jsonb)`);
  return result;
}

export function createSupplierReturnDifferenceReader(database: Pick<typeof db, "transaction"> = db) {
  return {
    read(entitlementId: number, actorId: string) {
      return database.transaction(async tx => {
        await assertSupplierReturnAuthority(tx, actorId, "read");
        return supplierReturnCreditReviewSchema.parse(await readSupplierReturnEntitlementReview(tx, entitlementId));
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}
export const supplierReturnDifferenceReader = createSupplierReturnDifferenceReader();
