import {
  purchasePipelineStages,
  type PurchasePipelineCost,
  type PurchasePipelineRow,
} from "@shared/procurement/purchase-pipeline";

export type PipelineMoneySummary = {
  currency: string | null;
  knownMills: string;
  confirmedMills: string;
  estimatedMills: string;
  confirmedComponents: number;
  estimatedComponents: number;
  missingComponents: number;
};

export type PipelinePurchaseGroup = {
  id: number;
  poNumber: string;
  vendorName: string;
  rows: PurchasePipelineRow[];
  lineCount: number;
  knownPieces: string;
  unknownQuantity: boolean;
  stages: PurchasePipelineRow["stage"][];
  costs: PipelineMoneySummary[];
};

export type PipelinePurchaseFilters = {
  search: string;
  bucket: "all" | PurchasePipelineRow["arrivalBucket"];
  stage: "all" | PurchasePipelineRow["stage"];
};

// The API boundary validates rows with purchasePipelineSchema. These helpers
// only project that validated DTO; they never recalculate receipt or cost evidence.
export function summarizePipelineCosts(
  rows: readonly PurchasePipelineRow[],
  component?: PurchasePipelineCost["component"],
): PipelineMoneySummary[] {
  const summaries = new Map<string | null, PipelineMoneySummary>();
  for (const row of rows) {
    const summary = summaries.get(row.currency) ?? {
      currency: row.currency,
      knownMills: "0",
      confirmedMills: "0",
      estimatedMills: "0",
      confirmedComponents: 0,
      estimatedComponents: 0,
      missingComponents: 0,
    };
    for (const cost of row.costs) {
      if (component !== undefined && cost.component !== component) continue;
      if (cost.amountMills === null || (cost.evidence !== "confirmed" && cost.evidence !== "estimated")) {
        summary.missingComponents++;
        continue;
      }
      const amount = BigInt(cost.amountMills);
      summary.knownMills = (BigInt(summary.knownMills) + amount).toString();
      if (cost.evidence === "confirmed") {
        summary.confirmedComponents++;
        summary.confirmedMills = (BigInt(summary.confirmedMills) + amount).toString();
      } else {
        summary.estimatedComponents++;
        summary.estimatedMills = (BigInt(summary.estimatedMills) + amount).toString();
      }
    }
    summaries.set(row.currency, summary);
  }
  // Stable currency ordering also keeps independently filtered views predictable.
  return [...summaries.values()].sort((left, right) => {
    if (left.currency === right.currency) return 0;
    if (left.currency === null) return 1;
    if (right.currency === null) return -1;
    return left.currency < right.currency ? -1 : 1;
  });
}

export function groupPipelinePurchases(rows: readonly PurchasePipelineRow[]): PipelinePurchaseGroup[] {
  const purchases = new Map<number, PurchasePipelineRow[]>();
  for (const row of rows) {
    const purchaseRows = purchases.get(row.purchaseOrderId) ?? [];
    purchaseRows.push(row);
    purchases.set(row.purchaseOrderId, purchaseRows);
  }
  return [...purchases.entries()]
    .sort(([left], [right]) => left - right)
    .map(([id, purchaseRows]) => {
      const first = purchaseRows[0];
      const stages = new Set(purchaseRows.map((row) => row.stage));
      // orderedPieces and remainingPieces repeat for every stage slice of a
      // line. Only quantityPieces is additive across the pipeline rows.
      const knownPieces = purchaseRows.reduce(
        (sum, row) => sum + (row.quantityPieces === null ? BigInt(0) : BigInt(row.quantityPieces)),
        BigInt(0),
      );
      return {
        id,
        poNumber: first.poNumber,
        vendorName: first.vendorName,
        rows: purchaseRows,
        lineCount: new Set(purchaseRows.map((row) => row.purchaseOrderLineId)).size,
        knownPieces: knownPieces.toString(),
        unknownQuantity: purchaseRows.some((row) => row.quantityPieces === null),
        stages: purchasePipelineStages.filter((stage) => stages.has(stage)),
        costs: summarizePipelineCosts(purchaseRows),
      };
    });
}

export function filterPipelinePurchases(
  groups: readonly PipelinePurchaseGroup[],
  filters: PipelinePurchaseFilters,
): PipelinePurchaseGroup[] {
  const search = filters.search.trim().toLocaleLowerCase("en-US");
  return groups.filter((group) => {
    // The same slice must satisfy both filters. A late supplier slice cannot
    // make a different, on-time shipment match "overdue + in transit".
    const matchingSlice = group.rows.some((row) =>
      (filters.bucket === "all" || row.arrivalBucket === filters.bucket)
      && (filters.stage === "all" || row.stage === filters.stage),
    );
    if (!matchingSlice) return false;
    if (!search) return true;
    return group.rows.some((row) => [
      row.poNumber, row.vendorName, row.sku, row.productName, row.shipmentNumber,
    ].some((value) => value?.toLocaleLowerCase("en-US").includes(search)));
  });
}

// Individual amounts have a 100-character API limit. Exact aggregation across
// the bounded pipeline can add digits, so presentation allows that headroom.
const MAX_PRESENTATION_INTEGER_LENGTH = 128;
const MILLS_PER_CURRENCY_UNIT = BigInt(10_000);

function parsePresentationInteger(value: string, signed: boolean): bigint {
  const pattern = signed ? /^-?(0|[1-9]\d*)$/ : /^(0|[1-9]\d*)$/;
  if (typeof value !== "string" || value.length > MAX_PRESENTATION_INTEGER_LENGTH || !pattern.test(value)) {
    throw new TypeError("Expected an exact, canonical integer string for pipeline presentation.");
  }
  return BigInt(value);
}

export function formatPipelinePieces(value: string): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
    .format(parsePresentationInteger(value, false));
}

/** Round the exact aggregate once; no monetary value passes through Number. */
export function formatPipelineCurrency(mills: string, currency: string | null): string {
  const amount = parsePresentationInteger(mills, true);
  if (currency !== null && (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))) {
    throw new TypeError("Expected a three-letter currency code or an unknown currency.");
  }
  const formatter = new Intl.NumberFormat("en-US", currency === null
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { style: "currency", currency, currencyDisplay: currency === "USD" ? "symbol" : "code" });
  const minorDigits = formatter.resolvedOptions().maximumFractionDigits;
  if (typeof minorDigits !== "number" || !Number.isInteger(minorDigits) || minorDigits < 0) {
    throw new RangeError("The currency formatter did not provide a valid minor-unit precision.");
  }
  const minorUnits = BigInt(`1${"0".repeat(minorDigits)}`);
  const absolute = amount < BigInt(0) ? -amount : amount;
  // Half-up on the magnitude also rounds negative halfway values away from zero.
  const rounded = (absolute * minorUnits + MILLS_PER_CURRENCY_UNIT / BigInt(2)) / MILLS_PER_CURRENCY_UNIT;
  const whole = rounded / minorUnits;
  const fraction = (rounded % minorUnits).toString().padStart(minorDigits, "0");
  const negative = amount < BigInt(0) && rounded !== BigInt(0);
  // BigInt has no negative zero. Use the formatter's negative pattern for a
  // sub-unit negative amount, then replace its one integer digit with zero.
  const parts = formatter.formatToParts(negative ? (whole === BigInt(0) ? BigInt(-1) : -whole) : whole);
  const formatted = parts.map((part) => {
    if (part.type === "fraction") return fraction;
    if (part.type === "integer" && negative && whole === BigInt(0)) return "0";
    return part.value;
  }).join("");
  return currency === null ? `${formatted} currency unknown` : formatted;
}
