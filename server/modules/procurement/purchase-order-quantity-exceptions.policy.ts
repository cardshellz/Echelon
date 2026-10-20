import type { PoException } from "@shared/schema/procurement.schema";
import type { AmendmentPlan } from "./po-quantity-amendment.policy";

type QuantityException = Pick<
  PoException,
  "id" | "kind" | "status" | "payload"
>;

/** A new ordered quantity supersedes the old variance evidence. An ordinary
 * open receiving balance is work remaining, not a newly detected shortage. */
export function planPurchaseOrderQuantityExceptions(
  exceptions: readonly QuantityException[],
  plan: Pick<AmendmentPlan, "preview">,
) {
  return plan.preview.lines
    .filter(
      ({ before, after }) =>
        before.lineType === "product" && before.orderQty !== after.orderQty,
    )
    .map(({ before, after }) => {
      const previous = exceptions.filter(
        (row) =>
          (row.kind === "qty_short" || row.kind === "qty_over") &&
          row.status !== "dismissed" &&
          (row.payload as { lineId?: unknown } | null)?.lineId === before.id,
      );
      const supersededIds = previous.map((row) => row.id);
      const difference = after.receivedQty - after.orderQty;
      const shortageStillApplies =
        difference < 0 &&
        !plan.preview.closedPurchaseOrder &&
        previous.some((row) => row.kind === "qty_short");
      if (difference <= 0 && !shortageStillApplies)
        return { supersededIds, replacement: null };

      const kind =
        difference > 0 ? ("qty_over" as const) : ("qty_short" as const);
      return {
        supersededIds,
        replacement: {
          kind,
          payload: {
            lineId: after.id,
            orderedQty: after.orderQty,
            receivedQty: after.receivedQty,
            ...(difference > 0
              ? { overageQty: difference }
              : { shortageQty: -difference }),
            sku: after.name,
          },
          title:
            `Quantity ${difference > 0 ? "over" : "short"} — ${after.name}`.slice(
              0,
              120,
            ),
          message: `${after.receivedQty} pieces received against ${after.orderQty} ordered. Review receiving if the actual count is incorrect.`,
        },
      };
    });
}
