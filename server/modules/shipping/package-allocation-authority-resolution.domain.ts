import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import {
  declaredPackageLifecycleInputSchema,
  projectDeclaredPackageLifecycle,
  type DeclaredPackageLifecycleInput,
  type DeclaredPackageLifecycleProjection,
} from "./declared-package-lifecycle.domain";
import {
  packageAllocationGroupActionSchema,
  packageAllocationGroupPreviousPlanSchema,
  planPackageAllocationGroup,
  type PackageAllocationGroupAction,
  type PackageAllocationGroupPackageInput,
  type PackageAllocationGroupPlannerInput,
  type PackageAllocationGroupPlannerResultV1,
} from "./package-allocation-group.domain";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_SOURCE_LINES = 500;
const MAX_PACKAGES = 200;
const MAX_ACTIONS = 500;

const positivePostgresInteger = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const groupVersion = z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX);
const boundedIdentifier = (field: string, maximum: number) => z.string({
  required_error: `${field} is required`,
})
  .trim()
  .min(1, `${field} must not be blank`)
  .max(maximum, `${field} exceeds ${maximum} characters`);

const resolutionSourceSchema = z.object({
  wmsShipmentItemId: positivePostgresInteger,
  sourceQuantity: positivePostgresInteger,
}).strict();

const observedPackageSchema = z.object({
  evidenceKey: boundedIdentifier("packages.evidenceKey", 300),
  lifecycle: declaredPackageLifecycleInputSchema,
}).strict();

export const packageAllocationAuthorityResolutionInputSchema = z.object({
  contractVersion: z.literal(1),
  authorityMode: z.literal("shadow_only"),
  groupKey: z.string().uuid().transform((value) => value.toLowerCase()),
  expectedGroupVersion: groupVersion,
  previousPlan: packageAllocationGroupPreviousPlanSchema.nullable(),
  sourceLines: z.array(resolutionSourceSchema).min(1).max(MAX_SOURCE_LINES),
  packages: z.array(observedPackageSchema).min(1).max(MAX_PACKAGES),
  actions: z.array(packageAllocationGroupActionSchema).max(MAX_ACTIONS),
}).strict();

export type PackageAllocationAuthorityResolutionInput = z.input<
  typeof packageAllocationAuthorityResolutionInputSchema
>;

export type PackageAllocationAuthorityResolutionErrorCode =
  | "AMBIGUOUS_PRIMARY_PACKAGE"
  | "DUPLICATE_EVIDENCE_KEY"
  | "INVALID_AUTHORITY_RESOLUTION_INPUT"
  | "PACKAGE_ROLE_UNRESOLVED"
  | "UNSAFE_AUTHORITY_QUANTITY";

export class PackageAllocationAuthorityResolutionError extends Error {
  readonly code: PackageAllocationAuthorityResolutionErrorCode;
  readonly context: Readonly<Record<string, unknown>>;
  override readonly cause?: unknown;

  constructor(
    code: PackageAllocationAuthorityResolutionErrorCode,
    message: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message);
    this.name = "PackageAllocationAuthorityResolutionError";
    this.code = code;
    this.context = Object.freeze({ ...context });
    this.cause = cause;
  }
}

export type PackageAllocationAuthorityResolutionReviewCode =
  | "package_contents_unavailable"
  | "replacement_action_required";

export interface PackageAllocationAuthorityResolutionReviewV1 {
  readonly code: PackageAllocationAuthorityResolutionReviewCode;
  readonly packageKeys: readonly string[];
}

export interface PackageAllocationAuthorityResolutionResultV1 {
  readonly contractVersion: 1;
  readonly authority: "shadow_only";
  readonly outcome: "proposed" | "review" | "unchanged";
  readonly scopeHash: string;
  readonly reviews: readonly PackageAllocationAuthorityResolutionReviewV1[];
  readonly plannerInput: PackageAllocationGroupPlannerInput;
  readonly plannerResult: PackageAllocationGroupPlannerResultV1;
}

interface ProjectedObservedPackage {
  readonly evidenceKey: string;
  readonly packageKey: string;
  readonly lifecycle: DeclaredPackageLifecycleInput;
  readonly projection: DeclaredPackageLifecycleProjection;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function checkedAdd(
  left: number,
  right: number,
  context: Record<string, unknown>,
): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total > POSTGRES_INTEGER_MAX) {
    throw new PackageAllocationAuthorityResolutionError(
      "UNSAFE_AUTHORITY_QUANTITY",
      "Resolved physical-consumption authority exceeds the PostgreSQL integer range",
      context,
    );
  }
  return total;
}

function duplicateText(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function sanitizedIssues(error: z.ZodError): readonly Readonly<{
  code: string;
  path: readonly (string | number)[];
  message: string;
}>[] {
  return Object.freeze(error.issues.map((issue) => Object.freeze({
    code: issue.code,
    path: Object.freeze([...issue.path]),
    message: issue.message,
  })));
}

export function packageAllocationPackageKey(
  provider: string,
  providerPhysicalShipmentId: string,
): string {
  const parsed = z.object({
    provider: boundedIdentifier("provider", 40).transform((value) => value.toLowerCase()),
    providerPhysicalShipmentId: boundedIdentifier("providerPhysicalShipmentId", 200),
  }).strict().safeParse({ provider, providerPhysicalShipmentId });
  if (!parsed.success) {
    throw new PackageAllocationAuthorityResolutionError(
      "INVALID_AUTHORITY_RESOLUTION_INPUT",
      "Provider package identity is invalid",
      { issues: sanitizedIssues(parsed.error) },
    );
  }
  return `package:v1:${sha256(canonicalJson(parsed.data))}`;
}

function projectedPackages(
  packages: readonly z.infer<typeof observedPackageSchema>[],
): readonly ProjectedObservedPackage[] {
  const duplicateEvidenceKey = duplicateText(packages.map((pkg) => pkg.evidenceKey));
  if (duplicateEvidenceKey !== null) {
    throw new PackageAllocationAuthorityResolutionError(
      "DUPLICATE_EVIDENCE_KEY",
      "Observed package evidence keys must be unique",
      { evidenceKey: duplicateEvidenceKey },
    );
  }
  const projected = packages.map((pkg) => {
    const projection = projectDeclaredPackageLifecycle(pkg.lifecycle);
    return deepFreeze({
      evidenceKey: pkg.evidenceKey,
      packageKey: packageAllocationPackageKey(
        projection.provider,
        projection.providerPhysicalShipmentId,
      ),
      lifecycle: pkg.lifecycle,
      projection,
    });
  }).sort((left, right) => compareText(left.packageKey, right.packageKey));
  const duplicatePackageKey = duplicateText(projected.map((pkg) => pkg.packageKey));
  if (duplicatePackageKey !== null) {
    throw new PackageAllocationAuthorityResolutionError(
      "DUPLICATE_EVIDENCE_KEY",
      "Observed evidence contains the same provider package more than once",
      { packageKey: duplicatePackageKey },
    );
  }
  return Object.freeze(projected);
}

function observationTime(pkg: ProjectedObservedPackage): string | null {
  return pkg.projection.labelFirstObservedAt;
}

function overlaps(
  left: ProjectedObservedPackage,
  right: ProjectedObservedPackage,
): boolean {
  if (left.projection.authoritativeContents === null
      || right.projection.authoritativeContents === null) return false;
  const leftIds = new Set(
    left.projection.authoritativeContents.map((line) => line.wmsShipmentItemId),
  );
  return right.projection.authoritativeContents.some(
    (line) => leftIds.has(line.wmsShipmentItemId),
  );
}

function scopeHash(
  groupKey: string,
  sources: readonly z.infer<typeof resolutionSourceSchema>[],
  packages: readonly ProjectedObservedPackage[],
): string {
  return sha256(canonicalJson({
    contractVersion: 1,
    groupKey,
    sources: [...sources].sort(
      (left, right) => left.wmsShipmentItemId - right.wmsShipmentItemId,
    ),
    packages: packages.map((pkg) => ({
      evidenceKey: pkg.evidenceKey,
      packageKey: pkg.packageKey,
      lifecycleEvidenceHash: pkg.projection.evidenceHash,
    })),
  }));
}

function membershipEvidenceKey(
  observedScopeHash: string,
  pkg: ProjectedObservedPackage,
): string {
  return `membership:v1:${sha256(canonicalJson({
    scopeHash: observedScopeHash,
    packageKey: pkg.packageKey,
    lifecycleEvidenceHash: pkg.projection.evidenceHash,
  }))}`;
}

function authorityFor(
  previous: NonNullable<PackageAllocationGroupPlannerInput["previousPlan"]>["sourceEvidence"][number] | undefined,
  resolvedQuantity: number | null,
): Readonly<{
  physicalConsumptionAuthorityQuantity: number | null;
  authorityVersion: number;
}> {
  const previousQuantity = previous?.physicalConsumptionAuthorityQuantity ?? null;
  const previousVersion = previous?.authorityVersion ?? 0;
  if (previousQuantity !== null
      && (resolvedQuantity === null || resolvedQuantity < previousQuantity)) {
    return Object.freeze({
      physicalConsumptionAuthorityQuantity: previousQuantity,
      authorityVersion: previousVersion,
    });
  }
  if (resolvedQuantity === previousQuantity) {
    return Object.freeze({
      physicalConsumptionAuthorityQuantity: resolvedQuantity,
      authorityVersion: previousVersion,
    });
  }
  if (previousVersion === POSTGRES_INTEGER_MAX) {
    throw new PackageAllocationAuthorityResolutionError(
      "UNSAFE_AUTHORITY_QUANTITY",
      "Physical-consumption authority version is exhausted",
    );
  }
  return Object.freeze({
    physicalConsumptionAuthorityQuantity: resolvedQuantity,
    authorityVersion: previousVersion + 1,
  });
}

function resolverReview(
  code: PackageAllocationAuthorityResolutionReviewCode,
  packageKeys: readonly string[],
): PackageAllocationAuthorityResolutionReviewV1 {
  return deepFreeze({
    code,
    packageKeys: [...new Set(packageKeys)].sort(compareText),
  });
}

/**
 * Converts one complete, transaction-locked observed package set into the
 * existing inert group planner contract. The future repository adapter owns
 * completeness and actor authentication; this pure resolver never performs a
 * write or turns an effect intent executable.
 */
export function resolvePackageAllocationAuthority(
  rawInput: PackageAllocationAuthorityResolutionInput,
): PackageAllocationAuthorityResolutionResultV1 {
  const parsed = packageAllocationAuthorityResolutionInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new PackageAllocationAuthorityResolutionError(
      "INVALID_AUTHORITY_RESOLUTION_INPUT",
      "Package-allocation authority resolution input failed validation",
      { issues: sanitizedIssues(parsed.error) },
    );
  }
  const input = parsed.data;
  const packages = projectedPackages(input.packages);
  const observedScopeHash = scopeHash(input.groupKey, input.sourceLines, packages);
  const roles = new Map<string, PackageAllocationGroupPackageInput["allocationRole"]>();
  for (const prior of input.previousPlan?.packageEvidence ?? []) {
    roles.set(prior.packageKey, prior.allocationRole);
  }

  const transferTargets = new Set(
    input.actions.flatMap((action) => action.kind === "transfer_awaiting_allocation"
      ? action.targets.map((target) => target.packageKey)
      : []),
  );
  if (input.previousPlan === null) {
    const observed = packages.filter((pkg) => observationTime(pkg) !== null);
    if (observed.length === 0) {
      throw new PackageAllocationAuthorityResolutionError(
        "PACKAGE_ROLE_UNRESOLVED",
        "No observed outbound package can establish the initial primary role",
      );
    }
    const earliestTime = observed.map((pkg) => observationTime(pkg) as string).sort(compareText)[0];
    const earliest = observed.filter((pkg) => observationTime(pkg) === earliestTime);
    if (earliest.length !== 1) {
      throw new PackageAllocationAuthorityResolutionError(
        "AMBIGUOUS_PRIMARY_PACKAGE",
        "Multiple packages share the earliest observed label time",
        { packageKeys: earliest.map((pkg) => pkg.packageKey).sort(compareText) },
      );
    }
    roles.set(earliest[0].packageKey, "primary");
  }

  const reviews: PackageAllocationAuthorityResolutionReviewV1[] = [];
  const primaryPackages = (): readonly ProjectedObservedPackage[] => packages.filter(
    (pkg) => roles.get(pkg.packageKey) === "primary",
  );
  for (const pkg of packages) {
    if (roles.has(pkg.packageKey)) continue;
    if (transferTargets.has(pkg.packageKey)) {
      roles.set(pkg.packageKey, "replacement_candidate");
      continue;
    }
    if (pkg.projection.authoritativeContents === null) {
      roles.set(pkg.packageKey, "additional_dispatch");
      reviews.push(resolverReview("package_contents_unavailable", [pkg.packageKey]));
      continue;
    }
    const replaceableSources = primaryPackages().filter((primary) => (
      primary.projection.labelStatus === "voided"
      && primary.projection.correctionStatus === "awaiting_relabel"
      && primary.projection.carrierStatus === "not_confirmed"
      && overlaps(primary, pkg)
    ));
    if (replaceableSources.length > 0) {
      roles.set(pkg.packageKey, "replacement_candidate");
      reviews.push(resolverReview("replacement_action_required", [
        ...replaceableSources.map((primary) => primary.packageKey),
        pkg.packageKey,
      ]));
    } else {
      roles.set(pkg.packageKey, "additional_dispatch");
    }
  }

  const sourceIds = new Set(input.sourceLines.map((line) => line.wmsShipmentItemId));
  const plannerPackages: readonly PackageAllocationGroupPackageInput[] = Object.freeze(
    packages.map((pkg) => {
      const contents = pkg.projection.authoritativeContents;
      const membershipProven = contents !== null
        && contents.every((line) => sourceIds.has(line.wmsShipmentItemId));
      return deepFreeze({
        packageKey: pkg.packageKey,
        allocationRole: roles.get(pkg.packageKey)!,
        membership: membershipProven
          ? {
              status: "proven" as const,
              evidenceKey: membershipEvidenceKey(observedScopeHash, pkg),
            }
          : { status: "unproven" as const, evidenceKey: null },
        lifecycle: pkg.lifecycle,
      });
    }).sort((left, right) => compareText(left.packageKey, right.packageKey)),
  );

  const previousSourceById = new Map(
    (input.previousPlan?.sourceEvidence ?? []).map((source) => [
      source.wmsShipmentItemId,
      source,
    ]),
  );
  const upperQuantityBySource = new Map<number, number>();
  for (const pkg of packages) {
    for (const line of pkg.projection.authoritativeContents ?? []) {
      if (!sourceIds.has(line.wmsShipmentItemId)) continue;
      upperQuantityBySource.set(
        line.wmsShipmentItemId,
        checkedAdd(
          upperQuantityBySource.get(line.wmsShipmentItemId) ?? 0,
          line.quantity,
          { wmsShipmentItemId: line.wmsShipmentItemId },
        ),
      );
    }
  }
  const provisionalSources = input.sourceLines.map((source) => {
    const previous = previousSourceById.get(source.wmsShipmentItemId);
    const quantity = upperQuantityBySource.get(source.wmsShipmentItemId) ?? null;
    const authority = authorityFor(previous, quantity);
    return deepFreeze({ ...source, ...authority });
  });
  const provisionalInput: PackageAllocationGroupPlannerInput = deepFreeze({
    contractVersion: 1 as const,
    authorityMode: "shadow_only" as const,
    groupKey: input.groupKey,
    expectedGroupVersion: input.expectedGroupVersion,
    previousPlan: input.previousPlan,
    sourceLines: provisionalSources,
    packages: plannerPackages,
    actions: input.actions as readonly PackageAllocationGroupAction[],
  });
  const provisionalPlan = planPackageAllocationGroup(provisionalInput);

  const primaryDeclaredBySource = new Map<number, number>();
  for (const pkg of packages) {
    if (roles.get(pkg.packageKey) !== "primary") continue;
    const membership = plannerPackages.find(
      (candidate) => candidate.packageKey === pkg.packageKey,
    )?.membership;
    if (membership?.status !== "proven") continue;
    for (const line of pkg.projection.authoritativeContents ?? []) {
      primaryDeclaredBySource.set(
        line.wmsShipmentItemId,
        checkedAdd(
          primaryDeclaredBySource.get(line.wmsShipmentItemId) ?? 0,
          line.quantity,
          { wmsShipmentItemId: line.wmsShipmentItemId, allocationRole: "primary" },
        ),
      );
    }
  }
  const additionalBySource = new Map<number, number>();
  for (const entry of provisionalPlan.state.allocations) {
    if (entry.allocationKind !== "additional_physical_consumption") continue;
    additionalBySource.set(
      entry.wmsShipmentItemId,
      checkedAdd(
        additionalBySource.get(entry.wmsShipmentItemId) ?? 0,
        entry.quantity,
        { wmsShipmentItemId: entry.wmsShipmentItemId, allocationKind: entry.allocationKind },
      ),
    );
  }
  const resolvedSources = input.sourceLines.map((source) => {
    const primary = primaryDeclaredBySource.get(source.wmsShipmentItemId) ?? 0;
    const additional = additionalBySource.get(source.wmsShipmentItemId) ?? 0;
    const quantity = primary + additional === 0
      ? null
      : checkedAdd(primary, additional, {
          wmsShipmentItemId: source.wmsShipmentItemId,
        });
    return deepFreeze({
      ...source,
      ...authorityFor(previousSourceById.get(source.wmsShipmentItemId), quantity),
    });
  });
  const plannerInput: PackageAllocationGroupPlannerInput = deepFreeze({
    ...provisionalInput,
    sourceLines: resolvedSources,
  });
  const plannerResult = planPackageAllocationGroup(plannerInput);
  return deepFreeze({
    contractVersion: 1 as const,
    authority: "shadow_only" as const,
    outcome: reviews.length > 0 || plannerResult.outcome === "review"
      ? "review" as const
      : plannerResult.outcome,
    scopeHash: observedScopeHash,
    reviews: reviews.sort((left, right) => compareText(left.code, right.code)),
    plannerInput,
    plannerResult,
  });
}
