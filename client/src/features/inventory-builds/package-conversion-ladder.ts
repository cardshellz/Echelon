import {
  transformationAdminModelSchema,
  transformationAdminVariantSchema,
  type TransformationAdminModel,
  type TransformationAdminVariant,
} from "@shared/types/inventory-availability-admin";
import {
  deriveLosslessPath,
  variantDisplayName,
  type PathDraft,
} from "@/pages/supply-transformations-model";

export type PackageDirection = "none" | "break_down" | "build_up" | "reversible";

export type PackageLadderRow = {
  lower: TransformationAdminVariant;
  upper: TransformationAdminVariant;
  direction: PackageDirection | null;
  issue: string | null;
  equation: string;
};

export type PackageLadder = {
  rows: PackageLadderRow[];
  issues: string[];
  unmanagedPaths: PathDraft[];
};

// Matches create/updateTransformationModelDraftRequestSchema's path limit.
const MAX_MODEL_PATHS = 500;
const DIRECTIONS: readonly PackageDirection[] = ["none", "break_down", "build_up", "reversible"];

/** A ladder is a projection, never a replacement for the complete directed graph. */
export function buildPackageLadder(
  variants: readonly TransformationAdminVariant[],
  paths: readonly PathDraft[],
): PackageLadder {
  const issues = catalogIssues(variants);
  if (issues.length > 0) return { rows: [], issues, unmanagedPaths: [...paths] };

  const sorted = variants.filter((variant) => variant.isActive)
    .sort((left, right) => left.unitsPerVariant - right.unitsPerVariant || left.id - right.id);
  const rows: PackageLadderRow[] = [];
  const representedPairs = new Set<string>();
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const lower = sorted[index]!;
    const upper = sorted[index + 1]!;
    const buildUp = deriveLosslessPath(1, lower, upper);
    const pairPaths = paths.filter((path) => isPair(path, lower.id, upper.id));
    const issue = pairIssue(pairPaths, lower, upper);
    // Unsupported pairs remain visible in the full graph, not disguised as None.
    if (issue === null) {
      representedPairs.add(pairKey(lower.id, upper.id));
      representedPairs.add(pairKey(upper.id, lower.id));
    }
    rows.push({
      lower,
      upper,
      direction: issue === null ? pairDirection(pairPaths, lower.id) : null,
      issue,
      equation: `${buildUp.inputQty} ${variantDisplayName(lower)} = ${buildUp.outputQty} ${variantDisplayName(upper)}`,
    });
  }
  return {
    rows,
    issues,
    unmanagedPaths: paths.filter((path) =>
      !representedPairs.has(pairKey(path.sourceVariantId, path.destinationVariantId))),
  };
}

export function updatePackageLadderDirection(input: {
  variants: readonly TransformationAdminVariant[];
  paths: readonly PathDraft[];
  lowerVariantId: number;
  upperVariantId: number;
  direction: PackageDirection;
  nextRowId: number;
}): { paths: PathDraft[]; nextRowId: number } {
  if (!DIRECTIONS.includes(input.direction)) throw new Error("Select a supported package direction.");
  const ladder = buildPackageLadder(input.variants, input.paths);
  if (ladder.issues.length > 0) throw new Error(ladder.issues[0]);
  const row = ladder.rows.find((candidate) =>
    candidate.lower.id === input.lowerVariantId && candidate.upper.id === input.upperVariantId);
  if (!row) throw new Error("Only adjacent active package variants can be edited in this ladder.");
  if (row.issue !== null) throw new Error(row.issue);
  validateRowIds(input.paths, input.nextRowId);

  const wantsBuildUp = input.direction === "build_up" || input.direction === "reversible";
  const wantsBreakDown = input.direction === "break_down" || input.direction === "reversible";
  // Retain every untouched object and the relative order of existing paths.
  const paths = input.paths.filter((path) => {
    if (!isPair(path, row.lower.id, row.upper.id)) return true;
    return path.sourceVariantId === row.lower.id ? wantsBuildUp : wantsBreakDown;
  });
  let nextRowId = input.nextRowId;
  if (wantsBuildUp && !paths.some((path) =>
    path.sourceVariantId === row.lower.id && path.destinationVariantId === row.upper.id)) {
    paths.push(deriveLosslessPath(nextRowId++, row.lower, row.upper));
  }
  if (wantsBreakDown && !paths.some((path) =>
    path.sourceVariantId === row.upper.id && path.destinationVariantId === row.lower.id)) {
    paths.push(deriveLosslessPath(nextRowId++, row.upper, row.lower));
  }
  if (paths.length > MAX_MODEL_PATHS) throw new Error(`A model cannot contain more than ${MAX_MODEL_PATHS} paths.`);
  return { paths, nextRowId };
}

/**
 * Full-definition saves re-snapshot recipes and catalog units on the server.
 * This editor cannot pin recipe snapshots, so any bindings make saving unsafe,
 * even when their current values appear unchanged. It must not drop bindings.
 */
export function packageLadderModelEditIssues(
  variants: readonly TransformationAdminVariant[],
  model: TransformationAdminModel | null,
): string[] {
  const issues = catalogIssues(variants);
  if (model === null) return issues;
  const parsed = transformationAdminModelSchema.safeParse(model);
  if (!parsed.success) return [...issues, "The existing model has an invalid shape; review it in Supply & Transformations."];
  if (model.bindings.length > 0) {
    issues.push("This model contains recipe bindings. The simplified ladder cannot save it without re-snapshotting recipe authority; use Supply & Transformations.");
  }
  if (model.validationState !== "valid") issues.push("The existing model is invalid; resolve its validation blockers in Supply & Transformations.");
  if (model.lifecycleStatus === "retired") issues.push("A retired model cannot be edited in the package ladder.");
  if (model.buildToPromiseEnabled && model.bindings.length === 0) {
    issues.push("Build-to-promise is enabled without recipe authority; review the existing model before editing.");
  }
  if (model.paths.length > MAX_MODEL_PATHS) issues.push("The existing model exceeds the supported path limit.");
  if (variants.some((variant) => variant.productId !== model.productId)) {
    issues.push("The catalog variants do not belong to the existing model product.");
  }
  if (issues.length > 0) return issues;

  const byId = new Map(variants.map((variant) => [variant.id, variant]));
  const pairs = new Set<string>();
  for (const path of model.paths) {
    const identity = pairKey(path.sourceVariantId, path.destinationVariantId);
    const source = byId.get(path.sourceVariantId);
    const destination = byId.get(path.destinationVariantId);
    if (pairs.has(identity)) issues.push(`The existing model repeats directed path ${identity}; review it before editing.`);
    pairs.add(identity);
    if (!source?.isActive || !destination?.isActive
      || source.productId !== model.productId || destination.productId !== model.productId
      || source.id === destination.id) {
      issues.push(`Path ${identity} does not reference two distinct active variants of this product.`);
      continue;
    }
    if (source.unitsPerVariant !== path.sourceUnitsPerVariant
      || destination.unitsPerVariant !== path.destinationUnitsPerVariant) {
      issues.push(`Path ${identity} has catalog unit snapshot drift; the ladder cannot silently refresh it.`);
    }
    if ((path.operationType === "break_pack" && source.unitsPerVariant <= destination.unitsPerVariant)
      || (path.operationType === "assemble_pack" && source.unitsPerVariant >= destination.unitsPerVariant)
      || path.transformationRecipeBindingKey !== null) {
      issues.push(`Path ${identity} has unsupported or inconsistent authority; review it before editing.`);
    }
    if (path.authorityState === "allowed"
      && BigInt(path.inputQty) * BigInt(path.sourceUnitsPerVariant)
        !== BigInt(path.outputQty) * BigInt(path.destinationUnitsPerVariant)) {
      issues.push(`Path ${identity} does not conserve base units; the ladder cannot change its authority.`);
    }
  }
  return issues;
}

function catalogIssues(variants: readonly TransformationAdminVariant[]): string[] {
  if (variants.some((variant) => !transformationAdminVariantSchema.safeParse(variant).success)) {
    return ["Package variants require valid identifiers and positive exact integer unit counts within the supported database range."];
  }
  if (new Set(variants.map((variant) => variant.id)).size !== variants.length) {
    return ["Duplicate variant identities prevent a safe package ladder."];
  }
  if (new Set(variants.map((variant) => variant.productId)).size > 1) {
    return ["A package ladder can contain variants from only one product."];
  }
  const active = variants.filter((variant) => variant.isActive);
  if (new Set(active.map((variant) => variant.unitsPerVariant)).size !== active.length) {
    return ["Equal-size active variants make package adjacency ambiguous; use explicit directed paths in Supply & Transformations."];
  }
  return [];
}

function pairIssue(
  paths: readonly PathDraft[],
  lower: TransformationAdminVariant,
  upper: TransformationAdminVariant,
): string | null {
  if (new Set(paths.map((path) => pairKey(path.sourceVariantId, path.destinationVariantId))).size !== paths.length) {
    return "Duplicate directed paths cannot be represented by this control; use Supply & Transformations.";
  }
  for (const path of paths) {
    if (path.authorityState !== "allowed") {
      return "An explicit blocked path is not None. Preserve or edit blocked authority in Supply & Transformations.";
    }
    if (path.recipeId !== null || path.recipeBindingKey !== null || path.operationType === "directed_conversion") {
      return "This pair has custom recipe or directed authority; use Supply & Transformations.";
    }
    const expected = path.sourceVariantId === lower.id
      ? deriveLosslessPath(path.rowId, lower, upper)
      : deriveLosslessPath(path.rowId, upper, lower);
    if (path.operationType !== expected.operationType
      || path.inputQty !== expected.inputQty || path.outputQty !== expected.outputQty) {
      return "This pair has custom quantities or operation semantics; the ladder will not normalize them. Use Supply & Transformations.";
    }
  }
  return null;
}

function pairDirection(paths: readonly PathDraft[], lowerVariantId: number): PackageDirection {
  const buildUp = paths.some((path) => path.sourceVariantId === lowerVariantId);
  const breakDown = paths.some((path) => path.destinationVariantId === lowerVariantId);
  if (buildUp && breakDown) return "reversible";
  if (buildUp) return "build_up";
  if (breakDown) return "break_down";
  return "none";
}

function isPair(path: PathDraft, lowerId: number, upperId: number): boolean {
  return (path.sourceVariantId === lowerId && path.destinationVariantId === upperId)
    || (path.sourceVariantId === upperId && path.destinationVariantId === lowerId);
}

function pairKey(sourceId: number, destinationId: number): string {
  return `${sourceId}:${destinationId}`;
}

function validateRowIds(paths: readonly PathDraft[], nextRowId: number): void {
  if (paths.some((path) => !Number.isSafeInteger(path.rowId) || path.rowId < 1)
    || new Set(paths.map((path) => path.rowId)).size !== paths.length
    || !Number.isSafeInteger(nextRowId) || nextRowId < 1
    || nextRowId > Number.MAX_SAFE_INTEGER - 2
    || paths.some((path) => path.rowId >= nextRowId)) {
    throw new Error("Path row identities are invalid or the next row identity is not unique.");
  }
}
