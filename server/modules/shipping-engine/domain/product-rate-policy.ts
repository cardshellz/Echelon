import { startedPoundsFromGrams } from "./rate-selection";

export type ProductRateRuleKind =
  | "restriction"
  | "base_charge"
  | "adjustment"
  | "threshold";

export type ProductRateRuleAction =
  | "block"
  | "free"
  | "fixed"
  | "fixed_band"
  | "base_plus_per_started_pound"
  | "surcharge"
  | "free_threshold";

export type ProductRateMeasurementScope =
  | "order"
  | "matched_items"
  | "each_item"
  | "carton";

export interface ProductRateDestinationScope {
  country: string;
  regions: readonly string[];
  postalPrefixes: readonly {
    region: string;
    prefixes: readonly string[];
  }[];
}

export interface ProductRateRuleBand {
  minMeasure: number;
  maxMeasure: number | null;
  rateCents: number;
}

export interface ProductRateRule {
  id: number;
  name: string;
  kind: ProductRateRuleKind;
  action: ProductRateRuleAction;
  measurementScope: ProductRateMeasurementScope;
  destinationScope: ProductRateDestinationScope;
  rateCents: number | null;
  perStartedPoundCents: number | null;
  thresholdCents: number | null;
  memberVariantIds: readonly number[];
  bands: readonly ProductRateRuleBand[];
  isActive: boolean;
}

export interface ProductRateLine {
  sku: string | null;
  productVariantId: number | null;
  quantity: number;
  unitWeightGrams: number | null;
  unitPriceCents: number | null;
}

export interface ProductRatePolicyInput {
  destination: {
    country: string;
    region: string;
    postalCode: string;
  };
  lines: readonly ProductRateLine[];
  rules: readonly ProductRateRule[];
  defaultRateForWeightGrams: (weightGrams: number) => number | null;
}

export interface ProductRateTraceStep {
  kind: "restriction" | "base_charge" | "threshold" | "adjustment" | "default";
  ruleId: number | null;
  label: string;
  amountCents: number;
  skus: string[];
}

export type ProductRatePolicyResult =
  | {
      ok: true;
      totalCents: number;
      trace: ProductRateTraceStep[];
    }
  | {
      ok: false;
      code: "BLOCKED" | "INVALID_INPUT" | "INVALID_POLICY" | "NO_RATE";
      message: string;
      ruleId: number | null;
      trace: ProductRateTraceStep[];
    };

interface ChargeBucket {
  rule: ProductRateRule | null;
  lineIndexes: number[];
  amountCents: number;
}

const ACTIONS_BY_KIND: Record<ProductRateRuleKind, readonly ProductRateRuleAction[]> = {
  restriction: ["block"],
  base_charge: ["free", "fixed", "fixed_band", "base_plus_per_started_pound"],
  adjustment: ["surcharge"],
  threshold: ["free_threshold"],
};

/**
 * Evaluate product-aware charges after the destination rate table has been
 * selected. Restriction rules run first; each line may belong to at most one
 * product base-charge rule; unmatched lines use the destination default.
 */
export function evaluateProductRatePolicy(
  input: ProductRatePolicyInput,
): ProductRatePolicyResult {
  const trace: ProductRateTraceStep[] = [];
  const inputErrors = validateProductRateLines(input.lines);
  if (inputErrors.length > 0) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: inputErrors[0],
      ruleId: null,
      trace,
    };
  }
  const validationErrors = validateProductRateRules(input.rules);
  if (validationErrors.length > 0) {
    return {
      ok: false,
      code: "INVALID_POLICY",
      message: validationErrors[0],
      ruleId: null,
      trace,
    };
  }
  const rules = input.rules.filter((rule) =>
    rule.isActive && destinationMatches(rule.destinationScope, input.destination));

  for (const rule of rules.filter((item) => item.kind === "restriction")) {
    const matches = matchingLineIndexes(rule, input.lines);
    if (matches.length === 0) continue;
    trace.push(traceStep("restriction", rule, 0, matches, input.lines));
    return {
      ok: false,
      code: "BLOCKED",
      message: `${rule.name} blocks this shipment destination.`,
      ruleId: rule.id,
      trace,
    };
  }

  const baseRules = rules.filter((rule) => rule.kind === "base_charge");
  const bucketsByRule = new Map<number, ChargeBucket>();
  const fallbackIndexes: number[] = [];
  const freeLineIndexes = new Set<number>();

  for (const threshold of rules.filter((rule) => rule.kind === "threshold")) {
    const thresholdIndexes = matchingLineIndexes(threshold, input.lines);
    if (thresholdIndexes.length === 0) continue;
    const subtotal = totalSubtotal(input.lines, thresholdIndexes);
    if (subtotal === null) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        message: `${threshold.name} cannot be evaluated because a matching item price is missing or invalid.`,
        ruleId: threshold.id,
        trace,
      };
    }
    if (subtotal < threshold.thresholdCents!) continue;
    thresholdIndexes.forEach((index) => freeLineIndexes.add(index));
    trace.push(traceStep("threshold", threshold, 0, thresholdIndexes, input.lines));
  }

  input.lines.forEach((line, lineIndex) => {
    if (freeLineIndexes.has(lineIndex)) return;
    const matches = baseRules.filter((rule) => lineMatches(rule, line));
    const rule = matches[0];
    if (!rule) {
      fallbackIndexes.push(lineIndex);
      return;
    }
    const bucket = bucketsByRule.get(rule.id) ?? {
      rule,
      lineIndexes: [],
      amountCents: 0,
    };
    bucket.lineIndexes.push(lineIndex);
    bucketsByRule.set(rule.id, bucket);
  });

  for (const [lineIndex, line] of input.lines.entries()) {
    const matches = baseRules.filter((rule) => lineMatches(rule, line));
    if (matches.length <= 1) continue;
    return {
      ok: false,
      code: "INVALID_POLICY",
      message: `${lineLabel(line, lineIndex)} matches multiple base-charge rules: ${matches.map((rule) => rule.name).join(", ")}.`,
      ruleId: null,
      trace,
    };
  }

  const buckets: ChargeBucket[] = [];
  if (fallbackIndexes.length > 0) {
    const fallbackWeight = totalWeight(input.lines, fallbackIndexes);
    if (fallbackWeight === null) {
      return {
        ok: false,
        code: "NO_RATE",
        message: "A product using destination-default pricing is missing a valid catalog or channel weight.",
        ruleId: null,
        trace,
      };
    }
    const fallbackRate = input.defaultRateForWeightGrams(fallbackWeight);
    if (fallbackRate === null || !isMoney(fallbackRate)) {
      return {
        ok: false,
        code: "NO_RATE",
        message: "The default destination schedule does not cover the unmatched items.",
        ruleId: null,
        trace,
      };
    }
    buckets.push({ rule: null, lineIndexes: fallbackIndexes, amountCents: fallbackRate });
  }

  for (const bucket of bucketsByRule.values()) {
    const amount = calculateRuleCharge(bucket.rule!, input.lines, bucket.lineIndexes);
    if (amount === null) {
      return {
        ok: false,
        code: "NO_RATE",
        message: `${bucket.rule!.name} does not cover the matched item weight.`,
        ruleId: bucket.rule!.id,
        trace,
      };
    }
    buckets.push({ ...bucket, amountCents: amount });
  }

  for (const bucket of buckets) {
    trace.push(bucket.rule === null
      ? {
          kind: "default",
          ruleId: null,
          label: "Destination default",
          amountCents: bucket.amountCents,
          skus: skusForIndexes(bucket.lineIndexes, input.lines),
        }
      : traceStep("base_charge", bucket.rule, bucket.amountCents, bucket.lineIndexes, input.lines));
  }

  let totalCents = buckets.reduce((sum, bucket) => sum + bucket.amountCents, 0);
  for (const adjustment of rules.filter((rule) => rule.kind === "adjustment")) {
    const indexes = matchingLineIndexes(adjustment, input.lines);
    if (indexes.length === 0) continue;
    const amount = calculateRuleCharge(adjustment, input.lines, indexes);
    if (amount === null) {
      return {
        ok: false,
        code: "INVALID_POLICY",
        message: `${adjustment.name} has an invalid surcharge configuration.`,
        ruleId: adjustment.id,
        trace,
      };
    }
    totalCents += amount;
    trace.push(traceStep("adjustment", adjustment, amount, indexes, input.lines));
  }

  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    return {
      ok: false,
      code: "INVALID_POLICY",
      message: "The product policy produced an invalid shipping charge.",
      ruleId: null,
      trace,
    };
  }
  return { ok: true, totalCents, trace };
}

/** Activation-time validation. Runtime repeats it and fails closed. */
export function validateProductRateRules(
  rules: readonly ProductRateRule[],
): string[] {
  const errors: string[] = [];
  for (const rule of rules) {
    if (rule.name.trim() === "") errors.push(`Rule ${rule.id} needs a name.`);
    if (!isValidDestinationScope(rule.destinationScope)) {
      errors.push(`${rule.name}: select a valid destination scope.`);
    }
    if (!ACTIONS_BY_KIND[rule.kind].includes(rule.action)) {
      errors.push(`${rule.name}: ${rule.action} is not valid for ${rule.kind}.`);
    }
    if (rule.measurementScope === "carton") {
      errors.push(`${rule.name}: carton measurement is unavailable until cartonization is connected.`);
    }
    if (rule.memberVariantIds.length === 0 && rule.kind !== "threshold") {
      errors.push(`${rule.name}: select at least one product variant.`);
    }
    if ((rule.action === "fixed" || rule.action === "surcharge") && !isMoney(rule.rateCents)) {
      errors.push(`${rule.name}: enter a fixed amount in cents.`);
    }
    if (
      rule.action === "base_plus_per_started_pound"
      && (!isMoney(rule.rateCents) || !isMoney(rule.perStartedPoundCents))
    ) {
      errors.push(`${rule.name}: enter both base and per-started-pound amounts.`);
    }
    if (rule.action === "free_threshold" && !isMoney(rule.thresholdCents)) {
      errors.push(`${rule.name}: enter a threshold in cents.`);
    }
    if (rule.action === "fixed_band") {
      errors.push(...validateBands(rule));
    }
  }

  const baseRules = rules.filter((rule) =>
    rule.isActive
    && rule.kind === "base_charge"
    && isValidDestinationScope(rule.destinationScope));
  for (let leftIndex = 0; leftIndex < baseRules.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < baseRules.length; rightIndex += 1) {
      const left = baseRules[leftIndex];
      const right = baseRules[rightIndex];
      if (!destinationScopesOverlap(left.destinationScope, right.destinationScope)) continue;
      const leftMembers = new Set(left.memberVariantIds);
      const overlappingVariant = right.memberVariantIds.find((id) => leftMembers.has(id));
      if (overlappingVariant !== undefined) {
        errors.push(`${left.name} and ${right.name} both price variant ${overlappingVariant} in an overlapping destination.`);
      }
    }
  }
  return [...new Set(errors)];
}

export function destinationMatches(
  scope: unknown,
  destination: { country: string; region: string; postalCode: string },
): boolean {
  if (!isValidDestinationScope(scope)) return false;
  const country = destination.country.trim().toUpperCase();
  const region = destination.region.trim().toUpperCase();
  const postal = destination.postalCode.trim().toUpperCase();
  if (scope.country.trim().toUpperCase() !== country) return false;
  if (scope.regions.map(normalize).includes(region)) return true;
  return scope.postalPrefixes.some((entry) =>
    normalize(entry.region) === region
    && entry.prefixes.some((prefix) => postal.startsWith(prefix.trim().toUpperCase())));
}

function destinationScopesOverlap(
  left: ProductRateDestinationScope,
  right: ProductRateDestinationScope,
): boolean {
  if (normalize(left.country) !== normalize(right.country)) return false;
  const leftRegions = new Set(left.regions.map(normalize));
  const rightRegions = new Set(right.regions.map(normalize));
  if ([...leftRegions].some((region) => rightRegions.has(region))) return true;
  if (right.postalPrefixes.some((entry) => leftRegions.has(normalize(entry.region)))) return true;
  if (left.postalPrefixes.some((entry) => rightRegions.has(normalize(entry.region)))) return true;
  return left.postalPrefixes.some((leftEntry) =>
    right.postalPrefixes.some((rightEntry) =>
      normalize(leftEntry.region) === normalize(rightEntry.region)
      && leftEntry.prefixes.some((leftPrefix) =>
        rightEntry.prefixes.some((rightPrefix) =>
          prefixesOverlap(leftPrefix, rightPrefix)))));
}

function matchingLineIndexes(
  rule: ProductRateRule,
  lines: readonly ProductRateLine[],
): number[] {
  return lines.flatMap((line, index) => lineMatches(rule, line) ? [index] : []);
}

function lineMatches(rule: ProductRateRule, line: ProductRateLine): boolean {
  return line.productVariantId !== null && rule.memberVariantIds.includes(line.productVariantId);
}

function calculateRuleCharge(
  rule: ProductRateRule,
  lines: readonly ProductRateLine[],
  indexes: readonly number[],
): number | null {
  if (rule.action === "free") return 0;
  if (rule.action === "fixed" || rule.action === "surcharge") {
    if (!isMoney(rule.rateCents)) return null;
    return rule.measurementScope === "each_item"
      ? safeMultiply(rule.rateCents, totalQuantity(lines, indexes))
      : rule.rateCents;
  }
  if (rule.action === "fixed_band") {
    if (rule.measurementScope === "each_item") {
      let total = 0;
      for (const index of indexes) {
        const line = lines[index];
        if (!isWeight(line.unitWeightGrams)) return null;
        const rate = rateForBand(rule.bands, line.unitWeightGrams);
        if (rate === null) return null;
        const lineTotal = safeMultiply(rate, line.quantity);
        if (lineTotal === null) return null;
        total += lineTotal;
        if (!Number.isSafeInteger(total)) return null;
      }
      return total;
    }
    const weight = totalWeight(lines, indexes);
    return weight === null ? null : rateForBand(rule.bands, weight);
  }
  if (rule.action === "base_plus_per_started_pound") {
    if (!isMoney(rule.rateCents) || !isMoney(rule.perStartedPoundCents)) return null;
    if (rule.measurementScope === "each_item") {
      let total = 0;
      for (const index of indexes) {
        const line = lines[index];
        if (!isWeight(line.unitWeightGrams)) return null;
        const pounds = startedPoundsFromGrams(line.unitWeightGrams);
        if (pounds === null) return null;
        const unitCharge = rule.rateCents + rule.perStartedPoundCents * pounds;
        const lineCharge = safeMultiply(unitCharge, line.quantity);
        if (lineCharge === null) return null;
        total += lineCharge;
        if (!Number.isSafeInteger(total)) return null;
      }
      return total;
    }
    const weight = totalWeight(lines, indexes);
    if (weight === null) return null;
    const pounds = startedPoundsFromGrams(weight);
    if (pounds === null) return null;
    const total = rule.rateCents + rule.perStartedPoundCents * pounds;
    return Number.isSafeInteger(total) ? total : null;
  }
  return null;
}

function validateBands(rule: ProductRateRule): string[] {
  if (rule.bands.length === 0) return [`${rule.name}: add at least one weight band.`];
  const sorted = [...rule.bands].sort((a, b) => a.minMeasure - b.minMeasure);
  const errors: string[] = [];
  let expectedMinimum = 0;
  sorted.forEach((band, index) => {
    if (!Number.isSafeInteger(band.minMeasure) || band.minMeasure !== expectedMinimum) {
      errors.push(`${rule.name}: weight bands must be gapless and begin at zero grams.`);
    }
    if (!isMoney(band.rateCents)) errors.push(`${rule.name}: every weight band needs a valid rate.`);
    if (band.maxMeasure === null) {
      if (index !== sorted.length - 1) errors.push(`${rule.name}: only the final weight band can be open-ended.`);
      return;
    }
    if (!Number.isSafeInteger(band.maxMeasure) || band.maxMeasure < band.minMeasure) {
      errors.push(`${rule.name}: a weight band has an invalid maximum.`);
      return;
    }
    expectedMinimum = band.maxMeasure + 1;
  });
  if (sorted[sorted.length - 1].maxMeasure !== null) {
    errors.push(`${rule.name}: the final weight band must be open-ended.`);
  }
  return errors;
}

function rateForBand(bands: readonly ProductRateRuleBand[], measure: number): number | null {
  const band = bands.find((candidate) =>
    candidate.minMeasure <= measure
    && (candidate.maxMeasure === null || candidate.maxMeasure >= measure));
  return band && isMoney(band.rateCents) ? band.rateCents : null;
}

function totalWeight(lines: readonly ProductRateLine[], indexes: readonly number[]): number | null {
  let total = 0;
  for (const index of indexes) {
    const line = lines[index];
    if (!isWeight(line.unitWeightGrams)) return null;
    const lineWeight = safeMultiply(line.unitWeightGrams, line.quantity);
    if (lineWeight === null) return null;
    total += lineWeight;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function totalSubtotal(lines: readonly ProductRateLine[], indexes: readonly number[]): number | null {
  let total = 0;
  for (const index of indexes) {
    const line = lines[index];
    if (!isMoney(line.unitPriceCents)) return null;
    const lineTotal = safeMultiply(line.unitPriceCents, line.quantity);
    if (lineTotal === null) return null;
    total += lineTotal;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function totalQuantity(lines: readonly ProductRateLine[], indexes: readonly number[]): number {
  return indexes.reduce((sum, index) => sum + lines[index].quantity, 0);
}

function safeMultiply(left: number, right: number): number | null {
  const result = left * right;
  return Number.isSafeInteger(result) ? result : null;
}

function isMoney(value: number | null | undefined): value is number {
  return Number.isSafeInteger(value) && value! >= 0;
}

function isWeight(value: number | null | undefined): value is number {
  return Number.isSafeInteger(value) && value! > 0;
}

function lineLabel(line: ProductRateLine, index: number): string {
  return line.sku?.trim() || `Line ${index + 1}`;
}

function traceStep(
  kind: ProductRateTraceStep["kind"],
  rule: ProductRateRule,
  amountCents: number,
  indexes: readonly number[],
  lines: readonly ProductRateLine[],
): ProductRateTraceStep {
  return {
    kind,
    ruleId: rule.id,
    label: rule.name,
    amountCents,
    skus: skusForIndexes(indexes, lines),
  };
}

function skusForIndexes(
  indexes: readonly number[],
  lines: readonly ProductRateLine[],
): string[] {
  return [...new Set(indexes.map((index) => lines[index].sku?.trim() || `line-${index + 1}`))];
}

function normalize(value: string): string {
  return value.trim().toUpperCase();
}

function prefixesOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

function isValidDestinationScope(scope: unknown): scope is ProductRateDestinationScope {
  if (scope === null || typeof scope !== "object") return false;
  const candidate = scope as Partial<ProductRateDestinationScope>;
  return typeof candidate.country === "string"
    && /^[A-Z]{2}$/.test(normalize(candidate.country))
    && Array.isArray(candidate.regions)
    && Array.isArray(candidate.postalPrefixes)
    && candidate.regions.every((region: unknown) =>
      typeof region === "string" && /^[A-Z]{2}$/.test(normalize(region)))
    && candidate.postalPrefixes.every((entry: unknown) => {
      if (entry === null || typeof entry !== "object") return false;
      const postalEntry = entry as { region?: unknown; prefixes?: unknown };
      return typeof postalEntry.region === "string"
        && /^[A-Z]{2}$/.test(normalize(postalEntry.region))
        && Array.isArray(postalEntry.prefixes)
        && postalEntry.prefixes.length > 0
        && postalEntry.prefixes.every((prefix: unknown) =>
          typeof prefix === "string" && /^\d{1,5}$/.test(prefix.trim()));
    })
    && (candidate.regions.length > 0 || candidate.postalPrefixes.length > 0);
}

function validateProductRateLines(lines: readonly ProductRateLine[]): string[] {
  const errors: string[] = [];
  lines.forEach((line, index) => {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      errors.push(`${lineLabel(line, index)} needs a positive whole-number quantity.`);
    }
    if (
      line.productVariantId !== null
      && (!Number.isSafeInteger(line.productVariantId) || line.productVariantId <= 0)
    ) {
      errors.push(`${lineLabel(line, index)} has an invalid product variant identifier.`);
    }
    if (line.unitWeightGrams !== null && !isWeight(line.unitWeightGrams)) {
      errors.push(`${lineLabel(line, index)} has an invalid unit weight.`);
    }
    if (line.unitPriceCents !== null && !isMoney(line.unitPriceCents)) {
      errors.push(`${lineLabel(line, index)} has an invalid unit price.`);
    }
  });
  return errors;
}
