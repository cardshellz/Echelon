import { canonicalJson } from "@shared/utils/canonical-json";
import type { OrderEditQuoteInput } from "@shared/order-edits/order-edit.contract";

type ValidatedEditPlan = Pick<
  OrderEditQuoteInput,
  "changes" | "additions" | "discountCodes"
>;

/** Compare validated edit content independently of parser/JSON object-key order. */
export function sameOrderEditPlan(
  left: ValidatedEditPlan,
  right: ValidatedEditPlan,
): boolean {
  const identity = (plan: ValidatedEditPlan): string =>
    canonicalJson({
      changes: plan.changes,
      additions: plan.additions,
      // Preserve the existing distinction: legacy omission must not rewrite request identity.
      ...(plan.discountCodes === undefined
        ? {}
        : { discountCodes: plan.discountCodes }),
    });
  return identity(left) === identity(right);
}
