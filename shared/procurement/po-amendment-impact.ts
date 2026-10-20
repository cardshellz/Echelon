import { z } from "zod";

const id = z.number().int().positive().safe();
const quantity = z.number().int().nonnegative().safe();
const money = z.number().int().safe();
const pair = z.object({ before: money, after: money }).strict();
/** Stable stock-return identities survive the rolled-back preview. Newly
 * generated posting/revision IDs remain only in the durable owner evidence. */
export const poAmendmentReturnedCostSchema = z.object({
  returnId: id, returnLineId: id, returnAllocationId: id,
  costQuantityAllocationId: id, inventoryLotId: id, quantity: id,
  component: z.enum(["product", "packaging", "landed"]),
  beforeMills: money.nonnegative(), afterMills: money.nonnegative(), deltaMills: money,
}).strict().superRefine((value, context) => {
  if (![value.beforeMills, value.afterMills, value.deltaMills].every(Number.isSafeInteger)) return;
  if (BigInt(value.beforeMills) + BigInt(value.deltaMills) !== BigInt(value.afterMills)) {
    context.addIssue({ code: "custom", message: "Returned value does not reconcile exactly." });
  }
});
export type PoAmendmentReturnedCost = z.infer<typeof poAmendmentReturnedCostSchema>;

export const poAmendmentImpactSchema = z
  .object({
    quantities: z.array(
      z
        .object({
          lineId: id,
          name: z.string(),
          ordered: pair,
          received: quantity,
          shipped: quantity,
          invoiced: quantity,
          remainingToReceive: pair,
          remainingToShip: z
            .object({ before: quantity.nullable(), after: quantity.nullable() })
            .strict(),
          remainingToInvoice: pair,
          shipmentCapacityReview: z.string().nullable(),
        })
        .strict(),
    ),
    shipments: z.array(
      z
        .object({
          shipmentId: id,
          shipmentNumber: z.string(),
          status: z.string(),
          chargeCents: money,
          lines: z.array(
            z
              .object({
                lineId: id,
                purchaseOrderId: id.nullable(),
                name: z.string(),
                shippedPieces: quantity,
                allocatedCents: pair,
                landedTotalCents: z
                  .object({ before: money.nullable(), after: money.nullable() })
                  .strict(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    lots: z.array(
      z
        .object({
          lotId: id,
          lotNumber: z.string(),
          onHandUnits: quantity,
          unitCostMills: z
            .object({ before: money.nullable(), after: money.nullable() })
            .strict(),
        })
        .strict(),
    ),
    orderCosts: z.array(
      z
        .object({
          costId: id,
          orderId: id,
          quantity: money,
          totalMills: z
            .object({ before: money.nullable(), after: money.nullable() })
            .strict(),
        })
        .strict(),
    ),
    historicalCosts: z.array(
      z
        .object({
          purchaseOrderLineId: id.nullable(),
          shipmentLineId: id.nullable(),
          component: z.enum(["product", "packaging", "landed"]),
          destination: z.enum(["historical_cogs", "inventory_variance"]),
          totalMills: pair,
        })
        .strict(),
    ),
    applications: z.array(
      z
        .object({
          purchaseOrderLineId: id.nullable(),
          shipmentId: id.nullable(),
          component: z.enum(["product", "packaging", "landed"]),
          shipmentLineId: id.nullable().optional(),
          status: z.enum([
            "applied",
            "review_required",
            "pending_finalization",
          ]),
          lotsUpdated: quantity,
          orderCostsUpdated: quantity,
          orderCostDeltaCents: money,
          returnedCosts: z.array(poAmendmentReturnedCostSchema).min(1).max(10_000).optional(),
          returnedCostDeltaMills: money.optional(),
          // Approval binds the displayed issue, not allocation/application IDs
          // created inside a rolled-back preview. Full evidence remains in the
          // immutable cost application written by the owning service on commit.
          issues: z.array(z.object({ code: z.string(), message: z.string() })),
        })
        .strict().superRefine((value, context) => {
          if ((value.returnedCosts === undefined) !== (value.returnedCostDeltaMills === undefined)) {
            context.addIssue({ code: "custom", message: "Returned value rows and their exact total must be supplied together." });
            return;
          }
          if (!value.returnedCosts || !Number.isSafeInteger(value.returnedCostDeltaMills)
            || value.returnedCosts.some(row => !Number.isSafeInteger(row.deltaMills))) return;
          const identities = value.returnedCosts.map(row => `${row.returnAllocationId}:${row.component}`);
          const total = value.returnedCosts.reduce((sum, row) => sum + BigInt(row.deltaMills), BigInt(0));
          if (new Set(identities).size !== identities.length || value.returnedCosts.some(row => row.component !== value.component)
            || total !== BigInt(value.returnedCostDeltaMills!)) {
            context.addIssue({ code: "custom", message: "Returned value identities, component and total must match this cost application." });
          }
        }),
    ),
  })
  .strict();
export type PoAmendmentImpact = z.infer<typeof poAmendmentImpactSchema>;
