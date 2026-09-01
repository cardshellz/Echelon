import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_LINES = 500;

const positiveInteger = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const positiveBigintText = z.string().regex(/^[1-9][0-9]*$/);
const evidenceHash = z.string().regex(/^[0-9a-f]{64}$/);
const exactSku = z.string().min(1).max(100).refine((value) => value.trim() === value);

const providerLineSchema = z.object({
  sku: exactSku,
  quantity: positiveInteger,
}).strict();

const catalogVariantSchema = z.object({
  productVariantId: positiveInteger,
  sku: exactSku,
  itemName: z.string().min(1).max(500),
  isActive: z.boolean(),
  requiresShipping: z.boolean(),
  trackInventory: z.boolean(),
}).strict();

const inventoryShipTransactionSchema = z.object({
  inventoryTransactionId: positiveInteger,
  productVariantId: positiveInteger.nullable(),
  fromLocationId: positiveInteger.nullable(),
  quantity: positiveInteger,
  evidenceKind: z.enum(["exact_shipment_item", "legacy_order_item"]),
}).strict();

const wmsLineSchema = z.object({
  wmsShipmentItemId: positiveInteger,
  wmsShipmentId: positiveInteger,
  orderItemId: positiveInteger.nullable(),
  productVariantId: positiveInteger.nullable(),
  sku: exactSku,
  itemName: z.string().min(1).max(500).nullable(),
  quantity: positiveInteger,
  fromLocationId: positiveInteger.nullable(),
  inventoryShipTransactions: z.array(inventoryShipTransactionSchema).max(10),
}).strict();

export const historicalShipStationContentsCorrectionFactsSchema = z.object({
  exceptionId: positiveBigintText,
  decisionHash: evidenceHash,
  providerEvidenceHash: evidenceHash,
  reviewPreviewEvidenceHash: evidenceHash,
  orderNumber: z.string().min(1).max(100).nullable(),
  trackingNumber: z.string().min(1).max(200),
  providerLines: z.array(providerLineSchema).max(MAX_LINES).nullable(),
  wmsLines: z.array(wmsLineSchema).max(MAX_LINES),
  catalogVariants: z.array(catalogVariantSchema).max(MAX_LINES),
}).strict();

export type HistoricalShipStationContentsCorrectionFacts = z.infer<
  typeof historicalShipStationContentsCorrectionFactsSchema
>;

export type HistoricalShipStationContentsCorrectionBlockerCode =
  | "catalog_variant_ambiguous"
  | "catalog_variant_unmatched"
  | "inventory_debit_source_unproven"
  | "inventory_ship_evidence_ambiguous"
  | "inventory_ship_evidence_mismatch"
  | "inventory_restore_location_unproven"
  | "package_line_mapping_required"
  | "provider_contents_unavailable"
  | "wms_variant_conflict"
  | "wms_variant_missing";

export interface HistoricalShipStationContentsCorrectionBlocker {
  readonly code: HistoricalShipStationContentsCorrectionBlockerCode;
  readonly sku: string | null;
  readonly wmsShipmentItemId: number | null;
  readonly message: string;
}

export interface HistoricalShipStationContentsCorrectionRestoration {
  readonly inventoryTransactionId: number;
  readonly wmsShipmentItemId: number;
  readonly warehouseLocationId: number;
  readonly quantity: number;
}

export interface HistoricalShipStationContentsCorrectionPackageLineAdjustment {
  readonly wmsShipmentItemId: number;
  readonly currentQuantity: number;
  readonly proposedQuantity: number;
  readonly quantityDelta: number;
}

export interface HistoricalShipStationContentsCorrectionLinePlan {
  readonly sku: string;
  readonly itemName: string | null;
  readonly productVariantId: number | null;
  readonly providerQuantity: number | null;
  readonly wmsQuantity: number;
  readonly recordedInventoryQuantity: number | null;
  readonly packageQuantityDelta: number | null;
  readonly inventoryQuantityDelta: number | null;
  readonly inventoryAction: "none" | "deduct" | "restore" | "unknown";
  readonly wmsShipmentItemIds: readonly number[];
  readonly packageLineAdjustments: readonly HistoricalShipStationContentsCorrectionPackageLineAdjustment[];
  readonly restorations: readonly HistoricalShipStationContentsCorrectionRestoration[];
  readonly blockers: readonly HistoricalShipStationContentsCorrectionBlocker[];
}

export interface HistoricalShipStationContentsCorrectionPlan {
  readonly contractVersion: 1;
  readonly exceptionId: string;
  readonly decisionHash: string;
  readonly providerEvidenceHash: string;
  readonly reviewPreviewEvidenceHash: string;
  readonly correctionPlanHash: string;
  readonly orderNumber: string | null;
  readonly trackingNumber: string;
  readonly evidenceComplete: boolean;
  readonly packageLineChangeRequired: boolean;
  readonly inventoryPostingRequired: boolean;
  readonly lines: readonly HistoricalShipStationContentsCorrectionLinePlan[];
  readonly blockers: readonly HistoricalShipStationContentsCorrectionBlocker[];
}

export class HistoricalShipStationContentsCorrectionDomainError extends Error {
  constructor(
    readonly code: "INVALID_CORRECTION_FACTS" | "QUANTITY_OVERFLOW",
    message: string,
    readonly context: Readonly<Record<string, unknown>> = Object.freeze({}),
  ) {
    super(message);
    this.name = "HistoricalShipStationContentsCorrectionDomainError";
  }
}

function normalizedSku(value: string): string {
  return value.toUpperCase();
}

function checkedAdd(left: number, right: number, sku: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > POSTGRES_INTEGER_MAX) {
    throw new HistoricalShipStationContentsCorrectionDomainError(
      "QUANTITY_OVERFLOW",
      "Historical contents correction quantity exceeds the PostgreSQL integer boundary",
      Object.freeze({ sku }),
    );
  }
  return result;
}

function blocker(
  code: HistoricalShipStationContentsCorrectionBlockerCode,
  message: string,
  sku: string | null = null,
  wmsShipmentItemId: number | null = null,
): HistoricalShipStationContentsCorrectionBlocker {
  return Object.freeze({ code, sku, wmsShipmentItemId, message });
}

function compareBlockers(
  left: HistoricalShipStationContentsCorrectionBlocker,
  right: HistoricalShipStationContentsCorrectionBlocker,
): number {
  return left.code.localeCompare(right.code)
    || String(left.sku ?? "").localeCompare(String(right.sku ?? ""))
    || (left.wmsShipmentItemId ?? 0) - (right.wmsShipmentItemId ?? 0)
    || left.message.localeCompare(right.message);
}

interface MutableSkuGroup {
  readonly normalizedSku: string;
  readonly displaySku: string;
  providerQuantity: number;
  readonly wmsLines: HistoricalShipStationContentsCorrectionFacts["wmsLines"][number][];
}

function groupLines(
  facts: HistoricalShipStationContentsCorrectionFacts,
): Map<string, MutableSkuGroup> {
  const groups = new Map<string, MutableSkuGroup>();
  for (const line of facts.providerLines ?? []) {
    const key = normalizedSku(line.sku);
    const group = groups.get(key) ?? {
      normalizedSku: key,
      displaySku: key,
      providerQuantity: 0,
      wmsLines: [],
    };
    group.providerQuantity = checkedAdd(group.providerQuantity, line.quantity, line.sku);
    groups.set(key, group);
  }
  for (const line of facts.wmsLines) {
    const key = normalizedSku(line.sku);
    const group = groups.get(key) ?? {
      normalizedSku: key,
      displaySku: key,
      providerQuantity: 0,
      wmsLines: [],
    };
    group.wmsLines.push(line);
    groups.set(key, group);
  }
  return groups;
}

function resolveVariant(
  group: MutableSkuGroup,
  catalogVariants: HistoricalShipStationContentsCorrectionFacts["catalogVariants"],
): Readonly<{
  productVariantId: number | null;
  itemName: string | null;
  blockers: readonly HistoricalShipStationContentsCorrectionBlocker[];
}> {
  const blockers: HistoricalShipStationContentsCorrectionBlocker[] = [];
  const wmsVariantIds = [...new Set(
    group.wmsLines
      .map((line) => line.productVariantId)
      .filter((value): value is number => value !== null),
  )].sort((left, right) => left - right);
  if (group.wmsLines.some((line) => line.productVariantId === null)) {
    blockers.push(blocker(
      "wms_variant_missing",
      "A WMS package line has no canonical product variant.",
      group.displaySku,
      group.wmsLines.find((line) => line.productVariantId === null)?.wmsShipmentItemId ?? null,
    ));
  }
  if (wmsVariantIds.length > 1) {
    blockers.push(blocker(
      "wms_variant_conflict",
      "WMS lines with the same SKU identify multiple product variants.",
      group.displaySku,
    ));
    return Object.freeze({ productVariantId: null, itemName: null, blockers: Object.freeze(blockers) });
  }

  const eligibleCatalog = catalogVariants
    .filter((variant) => (
      normalizedSku(variant.sku) === group.normalizedSku
      && variant.isActive
      && variant.requiresShipping
      && variant.trackInventory
    ))
    .sort((left, right) => left.productVariantId - right.productVariantId);
  if (wmsVariantIds.length === 1) {
    const variant = catalogVariants.find(
      (candidate) => candidate.productVariantId === wmsVariantIds[0],
    );
    if (!variant || normalizedSku(variant.sku) !== group.normalizedSku) {
      blockers.push(blocker(
        "wms_variant_conflict",
        "The WMS product variant no longer matches the persisted package SKU.",
        group.displaySku,
      ));
      return Object.freeze({ productVariantId: null, itemName: null, blockers: Object.freeze(blockers) });
    }
    return Object.freeze({
      productVariantId: wmsVariantIds[0],
      itemName: variant.itemName,
      blockers: Object.freeze(blockers),
    });
  }
  if (eligibleCatalog.length === 0) {
    blockers.push(blocker(
      "catalog_variant_unmatched",
      "ShipStation SKU does not resolve to one active, shippable, inventory-managed catalog variant.",
      group.displaySku,
    ));
    return Object.freeze({ productVariantId: null, itemName: null, blockers: Object.freeze(blockers) });
  }
  if (eligibleCatalog.length > 1) {
    blockers.push(blocker(
      "catalog_variant_ambiguous",
      "ShipStation SKU resolves to more than one active catalog variant.",
      group.displaySku,
    ));
    return Object.freeze({ productVariantId: null, itemName: null, blockers: Object.freeze(blockers) });
  }
  return Object.freeze({
    productVariantId: eligibleCatalog[0].productVariantId,
    itemName: eligibleCatalog[0].itemName,
    blockers: Object.freeze(blockers),
  });
}

function planGroup(
  group: MutableSkuGroup,
  catalogVariants: HistoricalShipStationContentsCorrectionFacts["catalogVariants"],
  providerEvidenceAvailable: boolean,
): HistoricalShipStationContentsCorrectionLinePlan {
  group.wmsLines.sort((left, right) => left.wmsShipmentItemId - right.wmsShipmentItemId);
  const blockers: HistoricalShipStationContentsCorrectionBlocker[] = [];
  const variant = resolveVariant(group, catalogVariants);
  blockers.push(...variant.blockers);

  let wmsQuantity = 0;
  let recordedInventoryQuantity = 0;
  let inventoryEvidenceComplete = true;
  const recordedSegments: HistoricalShipStationContentsCorrectionRestoration[] = [];
  const recordedLineIds = new Set<number>();
  const transactionUseCounts = new Map<number, number>();
  for (const line of group.wmsLines) {
    for (const transaction of line.inventoryShipTransactions) {
      transactionUseCounts.set(
        transaction.inventoryTransactionId,
        (transactionUseCounts.get(transaction.inventoryTransactionId) ?? 0) + 1,
      );
    }
  }
  for (const line of group.wmsLines) {
    wmsQuantity = checkedAdd(wmsQuantity, line.quantity, group.displaySku);
    const transactions = [...line.inventoryShipTransactions]
      .sort((left, right) => left.inventoryTransactionId - right.inventoryTransactionId);
    if (
      transactions.length > 1
      || transactions.some((entry) => (
        (transactionUseCounts.get(entry.inventoryTransactionId) ?? 0) > 1
      ))
    ) {
      inventoryEvidenceComplete = false;
      blockers.push(blocker(
        "inventory_ship_evidence_ambiguous",
        "A WMS package line does not resolve to one unique active inventory shipment posting.",
        group.displaySku,
        line.wmsShipmentItemId,
      ));
      continue;
    }
    const transaction = transactions[0];
    if (!transaction) continue;
    if (
      line.productVariantId === null
      || transaction.productVariantId !== line.productVariantId
      || transaction.quantity !== line.quantity
    ) {
      inventoryEvidenceComplete = false;
      blockers.push(blocker(
        "inventory_ship_evidence_mismatch",
        "The active inventory shipment posting does not match the WMS package line.",
        group.displaySku,
        line.wmsShipmentItemId,
      ));
      continue;
    }
    recordedInventoryQuantity = checkedAdd(
      recordedInventoryQuantity,
      transaction.quantity,
      group.displaySku,
    );
    recordedLineIds.add(line.wmsShipmentItemId);
    if (transaction.fromLocationId !== null) {
      recordedSegments.push(Object.freeze({
        inventoryTransactionId: transaction.inventoryTransactionId,
        wmsShipmentItemId: line.wmsShipmentItemId,
        warehouseLocationId: transaction.fromLocationId,
        quantity: transaction.quantity,
      }));
    }
  }

  const packageQuantityDelta = providerEvidenceAvailable
    ? group.providerQuantity - wmsQuantity
    : null;
  const inventoryQuantityDelta = providerEvidenceAvailable && inventoryEvidenceComplete
    ? group.providerQuantity - recordedInventoryQuantity
    : null;
  if (packageQuantityDelta !== null && packageQuantityDelta > 0) {
    blockers.push(blocker(
      "package_line_mapping_required",
      "ShipStation reports more units than existing WMS source lines can represent; reviewed line lineage is required.",
      group.displaySku,
    ));
  }
  if (inventoryQuantityDelta !== null && inventoryQuantityDelta > 0) {
    blockers.push(blocker(
      "inventory_debit_source_unproven",
      "ShipStation reports units without an existing inventory shipment posting; an exact source location must be selected and revalidated before posting.",
      group.displaySku,
    ));
  }

  const packageLineAdjustments: HistoricalShipStationContentsCorrectionPackageLineAdjustment[] = [];
  if (providerEvidenceAvailable) {
    let retainedProviderQuantity = group.providerQuantity;
    const linesByRetentionPriority = [...group.wmsLines].sort((left, right) => (
      Number(recordedLineIds.has(right.wmsShipmentItemId))
        - Number(recordedLineIds.has(left.wmsShipmentItemId))
      || left.wmsShipmentItemId - right.wmsShipmentItemId
    ));
    for (const line of linesByRetentionPriority) {
      const proposedQuantity = Math.min(line.quantity, retainedProviderQuantity);
      retainedProviderQuantity -= proposedQuantity;
      if (proposedQuantity !== line.quantity) {
        packageLineAdjustments.push(Object.freeze({
          wmsShipmentItemId: line.wmsShipmentItemId,
          currentQuantity: line.quantity,
          proposedQuantity,
          quantityDelta: proposedQuantity - line.quantity,
        }));
      }
    }
    packageLineAdjustments.sort(
      (left, right) => left.wmsShipmentItemId - right.wmsShipmentItemId,
    );
  }

  const restorations: HistoricalShipStationContentsCorrectionRestoration[] = [];
  if (inventoryQuantityDelta !== null && inventoryQuantityDelta < 0) {
    let retainedProviderQuantity = group.providerQuantity;
    for (const segment of recordedSegments) {
      const retained = Math.min(segment.quantity, retainedProviderQuantity);
      retainedProviderQuantity -= retained;
      const quantity = segment.quantity - retained;
      if (quantity > 0) {
        restorations.push(Object.freeze({ ...segment, quantity }));
      }
    }
    const plannedRestorationQuantity = restorations.reduce(
      (total, entry) => checkedAdd(total, entry.quantity, group.displaySku),
      0,
    );
    if (plannedRestorationQuantity !== Math.abs(inventoryQuantityDelta)) {
      blockers.push(blocker(
        "inventory_restore_location_unproven",
        "The original inventory shipment posting does not prove every location needed for restoration.",
        group.displaySku,
      ));
    }
  }

  blockers.sort(compareBlockers);
  return Object.freeze({
    sku: group.displaySku,
    itemName: variant.itemName
      ?? group.wmsLines.find((line) => line.itemName !== null)?.itemName
      ?? null,
    productVariantId: variant.productVariantId,
    providerQuantity: providerEvidenceAvailable ? group.providerQuantity : null,
    wmsQuantity,
    recordedInventoryQuantity: inventoryEvidenceComplete ? recordedInventoryQuantity : null,
    packageQuantityDelta,
    inventoryQuantityDelta,
    inventoryAction: inventoryQuantityDelta === null
      ? "unknown"
      : inventoryQuantityDelta > 0
      ? "deduct"
      : inventoryQuantityDelta < 0
        ? "restore"
        : "none",
    wmsShipmentItemIds: Object.freeze(group.wmsLines.map((line) => line.wmsShipmentItemId)),
    packageLineAdjustments: Object.freeze(packageLineAdjustments),
    restorations: Object.freeze(restorations),
    blockers: Object.freeze(blockers),
  });
}

export function planHistoricalShipStationContentsCorrection(
  rawFacts: HistoricalShipStationContentsCorrectionFacts,
): HistoricalShipStationContentsCorrectionPlan {
  const parsed = historicalShipStationContentsCorrectionFactsSchema.safeParse(rawFacts);
  if (!parsed.success) {
    throw new HistoricalShipStationContentsCorrectionDomainError(
      "INVALID_CORRECTION_FACTS",
      "Historical contents correction facts failed validation",
      Object.freeze({ issues: parsed.error.issues }),
    );
  }
  const facts = parsed.data;
  const globalBlockers: HistoricalShipStationContentsCorrectionBlocker[] = [];
  if (facts.providerLines === null) {
    globalBlockers.push(blocker(
      "provider_contents_unavailable",
      "ShipStation did not return a bounded SKU and quantity list that can support a correction.",
    ));
  }

  const lines = [...groupLines(facts).values()]
    .sort((left, right) => left.normalizedSku.localeCompare(right.normalizedSku))
    .map((group) => planGroup(group, facts.catalogVariants, facts.providerLines !== null));
  const blockers = [
    ...globalBlockers,
    ...lines.flatMap((line) => line.blockers),
  ].sort(compareBlockers);
  const hashProjection = Object.freeze({
    contract: "historical_shipstation_contents_correction_plan_v1",
    contractVersion: 1 as const,
    exceptionId: facts.exceptionId,
    decisionHash: facts.decisionHash,
    providerEvidenceHash: facts.providerEvidenceHash,
    reviewPreviewEvidenceHash: facts.reviewPreviewEvidenceHash,
    orderNumber: facts.orderNumber,
    trackingNumber: facts.trackingNumber,
    providerLines: facts.providerLines === null
      ? null
      : [...facts.providerLines].sort((left, right) => (
          normalizedSku(left.sku).localeCompare(normalizedSku(right.sku))
          || left.sku.localeCompare(right.sku)
          || left.quantity - right.quantity
        )),
    wmsLines: [...facts.wmsLines]
      .map((line) => ({
        ...line,
        inventoryShipTransactions: [...line.inventoryShipTransactions]
          .sort((left, right) => left.inventoryTransactionId - right.inventoryTransactionId),
      }))
      .sort((left, right) => left.wmsShipmentItemId - right.wmsShipmentItemId),
    catalogVariants: [...facts.catalogVariants]
      .sort((left, right) => left.productVariantId - right.productVariantId),
    lines,
    blockers,
  });
  return Object.freeze({
    contractVersion: 1 as const,
    exceptionId: facts.exceptionId,
    decisionHash: facts.decisionHash,
    providerEvidenceHash: facts.providerEvidenceHash,
    reviewPreviewEvidenceHash: facts.reviewPreviewEvidenceHash,
    correctionPlanHash: createHash("sha256")
      .update(canonicalJson(hashProjection), "utf8")
      .digest("hex"),
    orderNumber: facts.orderNumber,
    trackingNumber: facts.trackingNumber,
    evidenceComplete: blockers.length === 0,
    packageLineChangeRequired: lines.some((line) => (
      line.packageQuantityDelta !== null && line.packageQuantityDelta !== 0
    )),
    inventoryPostingRequired: lines.some((line) => (
      line.inventoryQuantityDelta !== null && line.inventoryQuantityDelta !== 0
    )),
    lines: Object.freeze(lines),
    blockers: Object.freeze(blockers),
  });
}
