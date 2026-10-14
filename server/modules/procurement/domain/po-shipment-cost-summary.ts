import {
  poShipmentCostSummarySchema,
  type PoShipmentCostSummary,
} from "@shared/procurement/po-shipment-cost-summary";
import { z } from "zod";
import {
  costIssueSchema,
  type CostIssue,
} from "@shared/procurement/cost-source-contracts";
import {
  poShipmentCostsSchema,
  type PoShipmentCosts,
} from "@shared/procurement/po-shipment-costs";

const integer = z.number().int().safe();
const id = integer.positive();
const inputSchema = z
  .object({
    poId: id,
    currency: z.string().regex(/^[A-Z]{3}$/),
    poAmountCents: integer,
    shipmentIds: z.array(id),
    charges: z.array(
      z
        .object({
          id,
          shipmentId: id,
          costType: z.string(),
          currency: z.string().nullable(),
          amountCents: integer.nullable(),
          confirmed: z.boolean(),
          issue: z.string().nullable().optional(),
        })
        .strict(),
    ),
    allocations: z.array(
      z
        .object({
          costId: id,
          poId: integer.nonnegative(),
          lineId: id,
          allocatedCents: integer,
        })
        .strict(),
    ),
    lines: z.array(
      z
        .object({
          id,
          quantity: id,
          sourceTotalMills: integer.nullable(),
          sourceQuantity: id.nullable(),
          evidence: z.string().nullable(),
          applicationStatus: z.string().nullable(),
          issue: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export interface PoShipmentCharge {
  id: number;
  shipmentId: number;
  costType: string;
  currency: string | null;
  amountCents: number | null;
  confirmed: boolean;
  issue?: string | null;
}
export interface PoShipmentChargeAllocation {
  costId: number;
  poId: number;
  lineId: number;
  allocatedCents: number;
}
export interface PoShipmentCostLine {
  id: number;
  quantity: number;
  sourceTotalMills: number | null;
  sourceQuantity: number | null;
  evidence: string | null;
  applicationStatus: string | null;
  issue: string | null;
}

function safeAmount(value: bigint): number {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < -BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new RangeError(
      "Shipment cost summary exceeds supported integer precision",
    );
  return Number(value);
}

/** Supplier contractual totals and allocated shipment charges remain distinct.
 * Whole-shipment totals cannot be added to every PO in a consolidated shipment.
 */
export interface PoShipmentCostSummaryInput {
  poId: number;
  currency: string;
  poAmountCents: number;
  shipmentIds: number[];
  charges: PoShipmentCharge[];
  allocations: PoShipmentChargeAllocation[];
  lines: PoShipmentCostLine[];
}

type LineStatus = PoShipmentCosts["lines"][number]["status"];
type EvaluatedCosts = {
  summary: PoShipmentCostSummary;
  lines: Array<{
    lineId: number;
    status: LineStatus;
    allocatedCents: number;
    pendingIssue: CostIssue | null;
  }>;
};

function evaluatePoShipmentCosts(
  input: PoShipmentCostSummaryInput,
): EvaluatedCosts {
  inputSchema.parse(input);
  const costIds = new Set(input.charges.map((charge) => charge.id));
  const lineIds = new Set(input.lines.map((line) => line.id));
  const allocationIds = new Set(
    input.allocations.map(
      (allocation) => `${allocation.costId}:${allocation.lineId}`,
    ),
  );
  if (
    costIds.size !== input.charges.length ||
    lineIds.size !== input.lines.length ||
    allocationIds.size !== input.allocations.length ||
    input.charges.some(
      (charge) => !input.shipmentIds.includes(charge.shipmentId),
    ) ||
    input.allocations.some(
      (allocation) =>
        !costIds.has(allocation.costId) ||
        (allocation.poId === input.poId && !lineIds.has(allocation.lineId)),
    )
  )
    throw new Error("Shipment cost summary has conflicting source identities.");
  let freight = BigInt(0),
    duty = BigInt(0),
    other = BigInt(0),
    estimated = BigInt(0);
  let unallocated = 0,
    unsupported = 0,
    applied = 0,
    review = 0,
    pending = 0;
  const supportedCostIds = new Set<number>();
  const confirmedCostIds = new Set<number>();
  const allocationsByCost = new Map<number, PoShipmentChargeAllocation[]>();
  const allocationsByLine = new Map<number, PoShipmentChargeAllocation[]>();
  const lineStates: EvaluatedCosts["lines"] = [];
  for (const allocation of input.allocations) {
    allocationsByCost.set(allocation.costId, [
      ...(allocationsByCost.get(allocation.costId) ?? []),
      allocation,
    ]);
    allocationsByLine.set(allocation.lineId, [
      ...(allocationsByLine.get(allocation.lineId) ?? []),
      allocation,
    ]);
  }
  for (const charge of input.charges) {
    const allocations = allocationsByCost.get(charge.id) ?? [];
    const total = allocations.reduce(
      (sum, allocation) => sum + BigInt(allocation.allocatedCents),
      BigInt(0),
    );
    if (
      charge.amountCents === null ||
      total !== BigInt(charge.amountCents) ||
      allocations.length === 0
    )
      unallocated++;
    if (charge.currency !== input.currency) {
      unsupported++;
      continue;
    }
    supportedCostIds.add(charge.id);
    if (charge.confirmed && !charge.issue) confirmedCostIds.add(charge.id);
    const amount = allocations
      .filter((allocation) => allocation.poId === input.poId)
      .reduce(
        (sum, allocation) => sum + BigInt(allocation.allocatedCents),
        BigInt(0),
      );
    if (charge.costType === "freight") freight += amount;
    else if (charge.costType === "duty" || charge.costType === "tax")
      duty += amount;
    else other += amount;
    if (!charge.confirmed) estimated += amount;
  }
  for (const line of input.lines) {
    const lineAllocations = allocationsByLine.get(line.id) ?? [];
    const amount = lineAllocations
      .filter((allocation) => supportedCostIds.has(allocation.costId))
      .reduce(
        (sum, allocation) =>
          sum + BigInt(allocation.allocatedCents) * BigInt(100),
        BigInt(0),
      );
    const current =
      line.sourceTotalMills !== null &&
      BigInt(line.sourceTotalMills) === amount &&
      line.sourceQuantity === line.quantity;
    let status: LineStatus;
    if (
      line.issue ||
      line.applicationStatus === "review_required" ||
      line.applicationStatus === "retry_required"
    ) {
      review++;
      status = "review_required";
    } else if (
      current &&
      line.evidence === "confirmed" &&
      line.applicationStatus === "applied" &&
      lineAllocations.length > 0 &&
      lineAllocations.every((allocation) =>
        confirmedCostIds.has(allocation.costId),
      )
    ) {
      applied++;
      status = "applied";
    } else {
      pending++;
      status = "pending";
    }
    lineStates.push({
      lineId: line.id,
      status,
      allocatedCents: safeAmount(amount / BigInt(100)),
      pendingIssue:
        status !== "pending"
          ? null
          : line.evidence === "estimated"
            ? {
                code: "LANDED_CHARGES_UNCONFIRMED",
                message:
                  "The shipment charge amounts are still estimated or awaiting supplier confirmation.",
              }
            : line.applicationStatus === "applied"
              ? {
                  code: "COST_UPDATE_OUTDATED",
                  message:
                    "The last applied cost update is not current for this shipment line's confirmed charges and quantity.",
                }
              : {
                  code: "COST_UPDATE_NOT_RECORDED",
                  message:
                    "No current inventory cost update has been recorded for this shipment line.",
                },
    });
  }
  const total = freight + duty + other;
  const summary = poShipmentCostSummarySchema.parse({
    currency: input.currency,
    shipmentCount: new Set(input.shipmentIds).size,
    chargeCount: input.charges.length,
    freightCents: safeAmount(freight),
    dutyCents: safeAmount(duty),
    otherCents: safeAmount(other),
    totalCents: safeAmount(total),
    poAmountCents: input.poAmountCents,
    combinedCostCents:
      unallocated > 0 || unsupported > 0
        ? null
        : safeAmount(BigInt(input.poAmountCents) + total),
    estimatedCents: safeAmount(estimated),
    unallocatedChargeCount: unallocated,
    unsupportedCurrencyCount: unsupported,
    appliedLines: applied,
    reviewLines: review,
    pendingLines: pending,
    inventoryCosting:
      input.charges.length === 0
        ? "no_costs"
        : review > 0 || input.charges.some((charge) => charge.issue)
          ? "review_required"
          : pending > 0 || unallocated > 0 || unsupported > 0
            ? "pending"
            : "applied",
  });
  return { summary, lines: lineStates };
}

export function buildPoShipmentCostSummary(
  input: PoShipmentCostSummaryInput,
): PoShipmentCostSummary {
  return evaluatePoShipmentCosts(input).summary;
}

const lineDetailSchema = z
  .object({
    lineId: id,
    shipmentId: id,
    shipmentNumber: z.string().nullable(),
    shipmentStatus: z.string(),
    sku: z.string().nullable(),
    applicationId: id.nullable(),
    recordedAt: z.string().datetime({ offset: true }).nullable(),
    sourceIssue: z.unknown(),
    applicationIssues: z.unknown(),
  })
  .strict();
export type PoShipmentCostLineDetail = z.infer<typeof lineDetailSchema>;

function recordedLineIssues(
  detail: PoShipmentCostLineDetail,
  status: LineStatus,
  pendingIssue: CostIssue | null,
): CostIssue[] {
  const issues: CostIssue[] = [];
  let unreadable = false;
  if (detail.sourceIssue != null) {
    const parsed = costIssueSchema.safeParse(detail.sourceIssue);
    if (parsed.success) issues.push(parsed.data);
    else unreadable = true;
  }
  if (detail.applicationId !== null) {
    const parsed = z.array(costIssueSchema).safeParse(detail.applicationIssues);
    if (parsed.success) issues.push(...parsed.data);
    else unreadable = true;
  }
  if (unreadable || (status === "review_required" && issues.length === 0)) {
    issues.push({
      code: "COST_REVIEW_DETAILS_MISSING",
      message:
        "The last cost update needs review, but its recorded reasons are missing or unreadable. Have a purchasing approver review the saved cost record before retrying.",
    });
  }
  if (status === "pending" && pendingIssue !== null && issues.length === 0) {
    issues.push(pendingIssue);
  }
  return [
    ...new Map(
      issues.map((issue) => [`${issue.code}:${issue.message}`, issue]),
    ).values(),
  ];
}

/** One snapshot supplies both card totals and the line-level review evidence. */
export function buildPoShipmentCosts(
  input: PoShipmentCostSummaryInput,
  supplier: {
    freightCents: number;
    dutyCents: number;
  },
  details: PoShipmentCostLineDetail[],
): PoShipmentCosts {
  const validatedSupplier = z
    .object({ freightCents: integer, dutyCents: integer })
    .strict()
    .parse(supplier);
  const validatedDetails = z.array(lineDetailSchema).parse(details);
  const detailIds = new Set(validatedDetails.map((detail) => detail.lineId));
  if (
    detailIds.size !== validatedDetails.length ||
    detailIds.size !== input.lines.length ||
    validatedDetails.some(
      (detail) => !input.shipmentIds.includes(detail.shipmentId),
    ) ||
    input.lines.some((line) => !detailIds.has(line.id))
  ) {
    throw new Error("Shipment cost review has conflicting line identities.");
  }
  const detailsById = new Map(
    validatedDetails.map((detail) => [detail.lineId, detail]),
  );
  const evaluated = evaluatePoShipmentCosts({
    ...input,
    lines: input.lines.map((line) => {
      const detail = detailsById.get(line.id)!;
      const sourceIssue = costIssueSchema.safeParse(detail.sourceIssue);
      const applicationIssues = z
        .array(costIssueSchema)
        .safeParse(detail.applicationIssues);
      const unreadable =
        (detail.sourceIssue != null && !sourceIssue.success) ||
        (detail.applicationId !== null && !applicationIssues.success);
      const recordedIssue = sourceIssue.success
        ? sourceIssue.data.code
        : applicationIssues.success && applicationIssues.data.length > 0
          ? applicationIssues.data[0].code
          : null;
      return {
        ...line,
        issue:
          line.issue ??
          (unreadable ? "COST_REVIEW_DETAILS_MISSING" : recordedIssue),
      };
    }),
  });
  const complete = evaluated.summary.combinedCostCents !== null;
  return poShipmentCostsSchema.parse({
    summary: evaluated.summary,
    supplier: validatedSupplier,
    totals: {
      freightCents: complete
        ? safeAmount(
            BigInt(validatedSupplier.freightCents) +
              BigInt(evaluated.summary.freightCents),
          )
        : null,
      dutyCents: complete
        ? safeAmount(
            BigInt(validatedSupplier.dutyCents) +
              BigInt(evaluated.summary.dutyCents),
          )
        : null,
      combinedCostCents: evaluated.summary.combinedCostCents,
    },
    lines: evaluated.lines.map((line) => {
      const detail = detailsById.get(line.lineId)!;
      return {
        lineId: line.lineId,
        shipmentId: detail.shipmentId,
        shipmentNumber: detail.shipmentNumber,
        shipmentStatus: detail.shipmentStatus,
        sku: detail.sku,
        allocatedCents: line.allocatedCents,
        status: line.status,
        applicationId: detail.applicationId,
        recordedAt: detail.recordedAt,
        issues: recordedLineIssues(detail, line.status, line.pendingIssue),
      };
    }),
  });
}
