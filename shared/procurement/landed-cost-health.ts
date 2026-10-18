import { z } from "zod";

const count = z.number().int().nonnegative().safe();
export const landedCostHealthSchema = z.object({
  status: z.enum(["healthy", "warning", "critical"]),
  scannedShipments: count,
  critical: count,
  warning: count,
  counts: z.object({
    allocationBlockers: count,
    allocationWarnings: count,
    pendingFinalization: count,
    finalizedNotPushed: count,
    staleProvisionalLots: count,
    // Older servers do not expose these categories during a rolling deploy.
    postingReviewRequired: count.optional().default(0),
    provisionalOtherCosts: count.optional().default(0),
  }),
  items: z.array(z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    severity: z.enum(["critical", "warning"]),
    shipmentId: z.number().int().positive().safe(),
    shipmentNumber: z.string().nullable(),
    shipmentStatus: z.string().min(1),
    detail: z.string().min(1),
    action: z.string().min(1),
    provisionalLotCount: count.optional(),
    missingSnapshotLineIds: z.array(z.number().int().positive().safe()).optional(),
    blockerCount: count.optional(),
    warningCount: count.optional(),
  })),
}).superRefine((value, context) => {
  const expected = value.critical > 0 ? "critical" : value.warning > 0 ? "warning" : "healthy";
  const visibleCritical = value.items.filter(item => item.severity === "critical").length;
  const visibleWarning = value.items.filter(item => item.severity === "warning").length;
  if (visibleCritical > value.critical || visibleWarning > value.warning) context.addIssue({ code: z.ZodIssueCode.custom,
    message: "Cost health evidence exceeds its recorded counts.", path: ["items"] });
  if (value.status !== expected) context.addIssue({ code: z.ZodIssueCode.custom,
    message: "Cost health status conflicts with its evidence counts.", path: ["status"] });
});
export type LandedCostHealth = z.infer<typeof landedCostHealthSchema>;

/** Every cost-health action lands in the costing workspace, not shipment lines. */
export function landedCostHealthHref(item: LandedCostHealth["items"][number]): string {
  const supplier = item.type === "provisional_other_costs" ? "#supplier-cost-review" : "";
  return `/shipments/${item.shipmentId}?tab=allocation${supplier}`;
}
