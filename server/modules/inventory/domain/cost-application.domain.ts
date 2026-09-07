import { z } from "zod";
import {
  costApplicationEvidenceSchema,
  costComponentAmountsSchema,
  costComponentSchema,
  costMillsSchema,
  costReadinessSchema,
  costSourceRevisionSchema,
  type CostApplicationEvidence,
  type CostComponent,
  type CostComponentAmounts,
  type CostIssue,
  type CostReadiness,
  type CostSourceRevision,
} from "@shared/procurement/cost-source-contracts";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const positiveInteger = z.number().int().positive().safe();
const nonnegativeInteger = z.number().int().nonnegative().safe();

export class CostApplicationDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "CostApplicationDomainError";
  }
}

function parseContract<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new CostApplicationDomainError("INVALID_COST_CONTRACT", "Cost input does not match its explicit contract", {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return result.data;
}

function toSafeInteger(value: bigint, field: string, code = "COST_AMOUNT_OVERFLOW"): number {
  if (value < -MAX_SAFE_INTEGER || value > MAX_SAFE_INTEGER) {
    throw new CostApplicationDomainError(code, `${field} exceeds the supported safe integer range`, { field });
  }
  return Number(value);
}

function signedRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const magnitude = numerator < ZERO ? -numerator : numerator;
  const rounded = magnitude / denominator + (magnitude % denominator * TWO >= denominator ? ONE : ZERO);
  return numerator < ZERO ? -rounded : rounded;
}

const costIntervalInputSchema = z.object({
  totalMills: costMillsSchema,
  basePieces: positiveInteger,
  startBasePiece: nonnegativeInteger,
  quantityBasePieces: nonnegativeInteger,
}).strict();

export type CostBasePieceInterval = z.infer<typeof costIntervalInputSchema>;
export type CostIntervalAllocation = {
  allocatedMills: number;
  startBasePiece: number;
  quantityBasePieces: number;
  /** Exact unrounded proportional value, including the sub-mill residual. */
  exact: { numerator: string; denominator: string; remainderNumerator: string };
};

/**
 * Assign value to an immutable interval within one source quantity. Cumulative
 * magnitude truncation makes adjacent intervals add to the exact source total,
 * independent of arrival order or how an interval is split. Credits are the
 * exact sign reversal of charges. Never derive the offset from current on-hand
 * stock: the physical owner must retain the original source interval.
 */
export function allocateCostByBasePieceInterval(input: CostBasePieceInterval): CostIntervalAllocation {
  const parsed = parseContract(costIntervalInputSchema, input);
  const total = BigInt(parsed.totalMills);
  const denominator = BigInt(parsed.basePieces);
  const start = BigInt(parsed.startBasePiece);
  const quantity = BigInt(parsed.quantityBasePieces);
  const end = start + quantity;
  if (end > denominator) {
    throw new CostApplicationDomainError("COST_INTERVAL_OUT_OF_BOUNDS", "Cost interval exceeds the captured source quantity", {
      startBasePiece: parsed.startBasePiece,
      quantityBasePieces: parsed.quantityBasePieces,
      basePieces: parsed.basePieces,
    });
  }
  const magnitude = total < ZERO ? -total : total;
  const allocatedMagnitude = magnitude * end / denominator - magnitude * start / denominator;
  const allocated = total < ZERO ? -allocatedMagnitude : allocatedMagnitude;
  const numerator = total * quantity;
  return {
    allocatedMills: toSafeInteger(allocated, "allocatedMills"),
    startBasePiece: parsed.startBasePiece,
    quantityBasePieces: parsed.quantityBasePieces,
    exact: {
      numerator: numerator.toString(),
      denominator: denominator.toString(),
      remainderNumerator: (numerator - allocated * denominator).toString(),
    },
  };
}

const frozenLotInputSchema = z.object({
  totalMills: costMillsSchema,
  basePieces: positiveInteger,
  startBasePiece: nonnegativeInteger,
  lotQuantity: positiveInteger,
  unitsPerVariantSnapshot: positiveInteger,
}).strict();

export type FrozenLotCostInput = z.infer<typeof frozenLotInputSchema>;
export type FrozenLotCostProjection = CostIntervalAllocation & {
  lotQuantity: number;
  unitsPerVariantSnapshot: number;
  unitMills: number;
  /** allocatedMills = unitMills * lotQuantity + remainderMills, exactly. */
  remainderMills: number;
};

/** A uniform legacy lot price is a projection; its remainder is not disposable. */
export function projectCostForFrozenLot(input: FrozenLotCostInput): FrozenLotCostProjection {
  const parsed = parseContract(frozenLotInputSchema, input);
  const quantityBasePieces = toSafeInteger(
    BigInt(parsed.lotQuantity) * BigInt(parsed.unitsPerVariantSnapshot),
    "quantityBasePieces",
    "COST_QUANTITY_OVERFLOW",
  );
  const interval = allocateCostByBasePieceInterval({
    totalMills: parsed.totalMills,
    basePieces: parsed.basePieces,
    startBasePiece: parsed.startBasePiece,
    quantityBasePieces,
  });
  const quantity = BigInt(parsed.lotQuantity);
  const allocated = BigInt(interval.allocatedMills);
  const unit = signedRoundHalfUp(allocated, quantity);
  return {
    ...interval,
    lotQuantity: parsed.lotQuantity,
    unitsPerVariantSnapshot: parsed.unitsPerVariantSnapshot,
    unitMills: toSafeInteger(unit, "unitMills"),
    remainderMills: toSafeInteger(allocated - unit * quantity, "remainderMills"),
  };
}

/** Recover exact normalized quote economics instead of multiplying a rounded price. */
export function exactCostTotalFromUnitAndRemainder(input: {
  unitMills: number;
  basePieces: number;
  remainderMills: number;
}): number {
  const parsed = parseContract(z.object({
    unitMills: costMillsSchema,
    basePieces: positiveInteger,
    remainderMills: costMillsSchema,
  }).strict(), input);
  return toSafeInteger(
    BigInt(parsed.unitMills) * BigInt(parsed.basePieces) + BigInt(parsed.remainderMills),
    "totalMills",
  );
}

export type CostUnitLayer = CostComponentAmounts & { qty: number; totalMills: number };

/**
 * For new physical lots, at most four uniform layers conserve all three exact
 * extended components. Unlike the existing nonnegative build allocator, this
 * projection retains signed credits. A posting owner must separately decide
 * whether it can represent a negative layer; it must not clamp the source.
 */
export function allocateSignedCostLayers(totals: CostComponentAmounts, outputQty: number): CostUnitLayer[] {
  const parsed = parseContract(costComponentAmountsSchema, totals);
  const quantity = BigInt(parseContract(positiveInteger, outputQty));
  const values = [parsed.productMills, parsed.packagingMills, parsed.landedMills].map((value) => BigInt(value));
  const bases = values.map((value) => value / quantity);
  const remainders = values.map((value) => Number((value < ZERO ? -value : value) % quantity));
  const signs = values.map((value) => value < ZERO ? -ONE : ONE);
  const boundaries = [...new Set([0, ...remainders, outputQty])].sort((left, right) => left - right);
  const layers: CostUnitLayer[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const components = bases.map((base, componentIndex) => base + (start < remainders[componentIndex] ? signs[componentIndex] : ZERO));
    layers.push({
      qty: end - start,
      productMills: toSafeInteger(components[0], "productMills"),
      packagingMills: toSafeInteger(components[1], "packagingMills"),
      landedMills: toSafeInteger(components[2], "landedMills"),
      totalMills: toSafeInteger(components[0] + components[1] + components[2], "totalMills"),
    });
  }
  return layers;
}

/** Replacing product authority cannot silently overwrite packaging or freight. */
export function replaceCostComponent(input: {
  current: CostComponentAmounts;
  component: CostComponent;
  unitMills: number;
}): CostComponentAmounts & { totalMills: number } {
  const parsed = parseContract(z.object({
    current: costComponentAmountsSchema,
    component: costComponentSchema,
    unitMills: costMillsSchema,
  }).strict(), input);
  const next: CostComponentAmounts = {
    productMills: parsed.component === "product" ? parsed.unitMills : parsed.current.productMills,
    packagingMills: parsed.component === "packaging" ? parsed.unitMills : parsed.current.packagingMills,
    landedMills: parsed.component === "landed" ? parsed.unitMills : parsed.current.landedMills,
  };
  return {
    ...next,
    totalMills: toSafeInteger(BigInt(next.productMills) + BigInt(next.packagingMills) + BigInt(next.landedMills), "totalMills"),
  };
}

export type CostLineageEvidence = "proven" | "missing" | "conflicting";

/**
 * Readiness is a projection of supplied evidence, not authorization to post.
 * `proven` must cover the entire affected lot/consumption graph. An applied
 * estimate remains estimated; closure and an old application are not evidence
 * that the current confirmed revision reached inventory and COGS.
 */
export function deriveCostReadiness(input: {
  source: CostSourceRevision;
  application: CostApplicationEvidence | null;
  lineage: CostLineageEvidence;
}): CostReadiness {
  const parsed = parseContract(z.object({
    source: costSourceRevisionSchema,
    application: costApplicationEvidenceSchema.nullable(),
    lineage: z.enum(["proven", "missing", "conflicting"]),
  }).strict(), input);
  const { source, application, lineage } = parsed;
  const issues: CostIssue[] = source.issue === null ? [] : [source.issue];
  const currentRevisionApplied = application?.state === "applied"
    && application.component === source.component
    && application.sourceRevision === source.revision
    && application.sourceFingerprint === source.fingerprint;
  let needsReview = source.evidence === "review_required";
  const addReview = (code: string, message: string): void => {
    issues.push({ code, message });
    needsReview = true;
  };
  if (source.currency !== "USD") {
    addReview("COST_CURRENCY_REVIEW_REQUIRED", source.currency === null
      ? "Source currency is unknown; establish it before applying cost."
      : `The current inventory owner supports USD; preserve ${source.currency} evidence until conversion is explicitly supported.`);
  }
  if (lineage !== "proven") {
    addReview("COST_LINEAGE_REVIEW_REQUIRED", lineage === "missing"
      ? "The complete source-to-lot contribution graph has not been established."
      : "Conflicting source-to-lot contribution evidence requires review.");
  }
  if (source.component !== "landed" && source.packagingTreatment === "unknown") {
    addReview("COST_PACKAGING_TREATMENT_UNKNOWN", "Establish whether the source product amount includes packaging before replacing a component.");
  }
  if (source.component !== "landed" && source.packagingTreatment === "included_in_product") {
    addReview("COST_PACKAGING_DECOMPOSITION_REQUIRED", "Preserve the inclusive source amount and establish component treatment before changing product or packaging.");
  }
  if (source.totalMills !== null && source.totalMills < 0) {
    addReview("COST_NEGATIVE_COMPONENT_UNSUPPORTED", "Preserve the signed source credit; the current inventory owner cannot apply a net negative component.");
  }
  if (application !== null && application.component !== source.component) {
    addReview("COST_APPLICATION_COMPONENT_MISMATCH", "Application evidence belongs to a different cost component.");
  }
  const applicationIsCurrent = application !== null
    && application.sourceRevision === source.revision
    && application.sourceFingerprint === source.fingerprint;
  if (applicationIsCurrent && application?.state === "review_required") {
    needsReview = true;
    if (application.issue !== null) issues.push(application.issue);
  }
  let state: CostReadiness["state"];
  if (needsReview) state = "review_required";
  else if (source.evidence === "unknown") state = "awaiting_source";
  else if (applicationIsCurrent && application?.state === "retry_required") {
    state = "retry_required";
    if (application.issue !== null) issues.push(application.issue);
  } else if (source.evidence === "estimated") state = "estimated";
  else if (currentRevisionApplied) state = "applied";
  else state = "ready_to_apply";

  return parseContract(costReadinessSchema, {
    state,
    sourceEvidence: source.evidence,
    applicationState: application?.state ?? "not_requested",
    currentRevisionApplied,
    issues,
  });
}
