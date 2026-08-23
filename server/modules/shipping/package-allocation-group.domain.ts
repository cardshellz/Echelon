import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import {
  declaredPackageLifecycleInputSchema,
  projectDeclaredPackageLifecycle,
  type DeclaredPackageLifecycleInput,
  type DeclaredPackageLifecycleProjection,
} from "./declared-package-lifecycle.domain";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_SOURCE_LINES = 500;
const MAX_PACKAGES = 200;
const MAX_PACKAGE_LIFECYCLE_EVENTS = 5_000;
// This V1 bound matches declaredPackageContentsEvidenceSchema.
const MAX_PACKAGE_CONTENT_LINES = 500;
const MAX_PACKAGE_EFFECT_INTENTS = 5;
const MAX_EFFECT_INTENT_EVIDENCE = MAX_SOURCE_LINES * 2
  + MAX_PACKAGES * (MAX_PACKAGE_CONTENT_LINES + MAX_PACKAGE_EFFECT_INTENTS);

const boundedIdentifier = (field: string, maxLength: number) => z.string({
  required_error: `${field} is required`,
})
  .trim()
  .min(1, `${field} must not be blank`)
  .max(maxLength, `${field} exceeds ${maxLength} characters`);

const positivePostgresInteger = z.number()
  .int()
  .positive()
  .max(POSTGRES_INTEGER_MAX);

const nonNegativeSafeInteger = z.number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "must be a non-negative safe integer");

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const canonicalGroupKeySchema = z.string().uuid().transform((value) => value.toLowerCase());
const groupVersionSchema = z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX);

const effectIntentEvidenceSchema = z.object({
  intentKey: boundedIdentifier("previousPlan.effectIntentEvidence.intentKey", 500),
  payloadHash: hashSchema,
}).strict();
type ParsedEffectIntentEvidence = z.infer<typeof effectIntentEvidenceSchema>;


const sourceLineSchema = z.object({
  wmsShipmentItemId: positivePostgresInteger,
  sourceQuantity: positivePostgresInteger,
  physicalConsumptionAuthorityQuantity: positivePostgresInteger.nullable(),
  authorityVersion: nonNegativeSafeInteger,
}).strict();
const sourceLineEvidenceSchema = sourceLineSchema.extend({
  sourceHash: hashSchema,
}).strict();
type ParsedSourceLineEvidence = z.infer<typeof sourceLineEvidenceSchema>;

const packageMembershipSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("proven"),
    evidenceKey: boundedIdentifier("membership.evidenceKey", 300),
  }).strict(),
  z.object({
    status: z.literal("unproven"),
    evidenceKey: boundedIdentifier("membership.evidenceKey", 300).nullable(),
  }).strict(),
]);

const packageSchema = z.object({
  packageKey: boundedIdentifier("packageKey", 180),
  allocationRole: z.enum(["primary", "replacement_candidate", "additional_dispatch"]),
  membership: packageMembershipSchema,
  lifecycle: declaredPackageLifecycleInputSchema,
}).strict();
const packageLifecycleEventEvidenceSchema = z.object({
  eventKey: boundedIdentifier("previousPlan.packageEvidence.lifecycleEventEvidence.eventKey", 240),
  eventHash: hashSchema,
}).strict();
const packageIdentityEvidenceSchema = z.object({
  packageKey: boundedIdentifier("previousPlan.packageEvidence.packageKey", 180),
  allocationRole: z.enum(["primary", "replacement_candidate", "additional_dispatch"]),
  provider: boundedIdentifier("previousPlan.packageEvidence.provider", 40)
    .transform((value) => value.toLowerCase()),
  providerPhysicalShipmentId: boundedIdentifier(
    "previousPlan.packageEvidence.providerPhysicalShipmentId",
    200,
  ),
  identityHash: hashSchema,
  lifecycleEventEvidence: z.array(packageLifecycleEventEvidenceSchema)
    .min(1).max(MAX_PACKAGE_LIFECYCLE_EVENTS),
}).strict();
type ParsedPackageIdentityEvidence = z.infer<typeof packageIdentityEvidenceSchema>;

const transferTargetSchema = z.object({
  packageKey: boundedIdentifier("transfer target packageKey", 180),
  wmsShipmentItemId: positivePostgresInteger,
  quantity: positivePostgresInteger,
}).strict();

const leadApprovedAuthorizationSchema = z.object({
  kind: z.literal("lead_approved"),
  actor: boundedIdentifier("authorization.actor", 200),
  reason: boundedIdentifier("authorization.reason", 500),
}).strict();

const transferAuthorizationSchema = z.discriminatedUnion("kind", [
  leadApprovedAuthorizationSchema,
  z.object({
    kind: z.literal("authenticated_provider_correction"),
    evidenceKey: boundedIdentifier("authorization.evidenceKey", 300),
  }).strict(),
]);

const transferActionSchema = z.object({
  kind: z.literal("transfer_awaiting_allocation"),
  actionKey: boundedIdentifier("actionKey", 300),
  fromPackageKey: boundedIdentifier("fromPackageKey", 180),
  targets: z.array(transferTargetSchema).min(1).max(500),
  authorization: transferAuthorizationSchema,
}).strict();
const cancellationActionSchema = z.object({
  kind: z.literal("cancel_awaiting_allocation"),
  actionKey: boundedIdentifier("actionKey", 300),
  fromPackageKey: boundedIdentifier("fromPackageKey", 180),
  wmsShipmentItemId: positivePostgresInteger,
  quantity: positivePostgresInteger,
  authorization: leadApprovedAuthorizationSchema,
}).strict();
const packageAllocationGroupActionSchema = z.discriminatedUnion("kind", [
  transferActionSchema,
  cancellationActionSchema,
]);
const actionEvidenceSchema = z.object({
  actionKey: boundedIdentifier("previousPlan.actionEvidence.actionKey", 300),
  actionHash: hashSchema,
  action: packageAllocationGroupActionSchema,
}).strict();
type ParsedActionEvidence = z.infer<typeof actionEvidenceSchema>;


export const packageAllocationGroupPreviousPlanSchema = z.object({
  groupKey: canonicalGroupKeySchema,
  groupVersion: groupVersionSchema,
  stateHash: hashSchema,
  actionEvidence: z.array(actionEvidenceSchema).max(500),
  appliedActionKeys: z.array(boundedIdentifier("previousPlan.appliedActionKeys", 300)).max(500),
  packageEvidence: z.array(packageIdentityEvidenceSchema).max(MAX_PACKAGES),
  sourceEvidence: z.array(sourceLineEvidenceSchema).max(MAX_SOURCE_LINES),
  effectIntentEvidence: z.array(effectIntentEvidenceSchema).max(MAX_EFFECT_INTENT_EVIDENCE),
}).strict();

export const packageAllocationGroupPlannerInputSchema = z.object({
  contractVersion: z.literal(1),
  authorityMode: z.literal("shadow_only"),
  groupKey: canonicalGroupKeySchema,
  expectedGroupVersion: groupVersionSchema,
  previousPlan: packageAllocationGroupPreviousPlanSchema.nullable(),
  sourceLines: z.array(sourceLineSchema).min(1).max(MAX_SOURCE_LINES),
  packages: z.array(packageSchema).min(1).max(MAX_PACKAGES),
  actions: z.array(packageAllocationGroupActionSchema).max(500),
}).strict();

type ParsedPlannerInput = z.infer<typeof packageAllocationGroupPlannerInputSchema>;
export type PackageAllocationGroupSourceLine = z.infer<typeof sourceLineSchema>;
type PackageAllocationGroupTransferAction = z.infer<typeof transferActionSchema>;
type PackageAllocationGroupCancellationAction = z.infer<typeof cancellationActionSchema>;
export type PackageAllocationGroupAction =
  | PackageAllocationGroupTransferAction
  | (PackageAllocationGroupCancellationAction & {
    readonly targets?: never;
  });

export interface PackageAllocationGroupActionEvidenceV1 {
  readonly actionKey: string;
  readonly actionHash: string;
  readonly action: PackageAllocationGroupAction;
}
export interface PackageAllocationGroupPackageEvidenceV1 {
  readonly packageKey: string;
  readonly allocationRole: PackageAllocationGroupPackageInput["allocationRole"];
  readonly provider: string;
  readonly providerPhysicalShipmentId: string;
  readonly identityHash: string;
  readonly lifecycleEventEvidence: readonly PackageAllocationGroupLifecycleEventEvidenceV1[];
}
export interface PackageAllocationGroupLifecycleEventEvidenceV1 {
  readonly eventKey: string;
  readonly eventHash: string;
}
export interface PackageAllocationGroupSourceEvidenceV1 extends PackageAllocationGroupSourceLine {
  readonly sourceHash: string;
}

export interface PackageAllocationEffectIntentEvidenceV1 {
  readonly intentKey: string;
  readonly payloadHash: string;
}

export interface PackageAllocationGroupPackageInput {
  readonly packageKey: string;
  readonly allocationRole: "primary" | "replacement_candidate" | "additional_dispatch";
  readonly membership:
    | { readonly status: "proven"; readonly evidenceKey: string }
    | { readonly status: "unproven"; readonly evidenceKey: string | null };
  readonly lifecycle: DeclaredPackageLifecycleInput;
}

export interface PackageAllocationGroupPlannerInput {
  readonly contractVersion: 1;
  readonly authorityMode: "shadow_only";
  readonly groupKey: string;
  readonly expectedGroupVersion: number;
  readonly previousPlan: Readonly<{
    groupKey: string;
    groupVersion: number;
    stateHash: string;
    actionEvidence: readonly PackageAllocationGroupActionEvidenceV1[];
    appliedActionKeys: readonly string[];
    packageEvidence: readonly PackageAllocationGroupPackageEvidenceV1[];
    sourceEvidence: readonly PackageAllocationGroupSourceEvidenceV1[];
    effectIntentEvidence: readonly PackageAllocationEffectIntentEvidenceV1[];
  }> | null;
  readonly sourceLines: readonly PackageAllocationGroupSourceLine[];
  readonly packages: readonly PackageAllocationGroupPackageInput[];
  readonly actions: readonly PackageAllocationGroupAction[];
}

export type PackageAllocationTargetKind = "package" | "awaiting_relabel" | "held_for_unpack";
export type PackageAllocationKind = "primary_transfer" | "additional_physical_consumption";

export interface PackageAllocationEntryV1 {
  readonly entryKey: string;
  readonly allocationKey: string;
  readonly wmsShipmentItemId: number;
  readonly allocationKind: PackageAllocationKind;
  readonly targetKind: PackageAllocationTargetKind;
  readonly packageKey: string | null;
  readonly quantity: number;
}

export type PackageAllocationEffectType =
  | "commercial_fulfillment"
  | "inventory_consumption"
  | "active_label_tracking"
  | "pre_possession_void_removal"
  | "carrier_tracking"
  | "notification_candidate"
  | "notification_reconciliation";

export interface PackageAllocationEffectIntentV1 {
  readonly intentKey: string;
  readonly executable: false;
  readonly effectType: PackageAllocationEffectType;
  readonly subjectKey: string;
  readonly wmsShipmentItemId: number | null;
  readonly packageKey: string | null;
  readonly quantity: number | null;
  readonly payloadHash: string;
}

export type PackageAllocationReviewCode =
  | "cancellation_after_carrier_lock"
  | "cancellation_exceeds_awaiting_relabel"
  | "cancellation_superseded_by_carrier_possession"
  | "competing_allocation_actions"
  | "competing_transfer_actions"
  | "invalid_cancellation_source"
  | "invalid_transfer_source"
  | "invalid_transfer_target"
  | "late_possession_requires_previous_ledger"
  | "package_contents_unavailable"
  | "package_lifecycle_review"
  | "package_line_not_in_group"
  | "package_membership_unproven"
  | "physical_consumption_authority_exceeded"
  | "physical_consumption_authority_missing"
  | "primary_allocation_exceeds_source"
  | "replacement_order_unproven"
  | "transfer_contents_mismatch"
  | "transfer_exceeds_awaiting_relabel"
  | "unclassified_additional_dispatch";

export interface PackageAllocationReviewV1 {
  readonly code: PackageAllocationReviewCode;
  readonly packageKeys: readonly string[];
  readonly wmsShipmentItemIds: readonly number[];
  readonly actionKeys: readonly string[];
}

export interface PackageAllocationPackageSnapshotV1 {
  readonly packageKey: string;
  readonly allocationRole: PackageAllocationGroupPackageInput["allocationRole"];
  readonly membershipStatus: "proven" | "unproven";
  readonly provider: string;
  readonly providerPhysicalShipmentId: string;
  readonly membershipEvidenceKey: string | null;
  readonly lifecycleStateHash: string;
  readonly lifecycleEvidenceHash: string;
  readonly labelStatus: DeclaredPackageLifecycleProjection["labelStatus"];
  readonly carrierStatus: DeclaredPackageLifecycleProjection["carrierStatus"];
  readonly correctionStatus: DeclaredPackageLifecycleProjection["correctionStatus"];
  readonly disposition: DeclaredPackageLifecycleProjection["disposition"];
}

export interface PackageAllocationGroupStateV1 {
  readonly sourceLines: readonly PackageAllocationGroupSourceLine[];
  readonly packageSnapshots: readonly PackageAllocationPackageSnapshotV1[];
  readonly allocations: readonly PackageAllocationEntryV1[];
  readonly desiredEffectIntents: readonly PackageAllocationEffectIntentV1[];
  readonly appliedActionKeys: readonly string[];
  readonly reviews: readonly PackageAllocationReviewV1[];
  readonly actionEvidence: readonly PackageAllocationGroupActionEvidenceV1[];
  readonly packageEvidence: readonly PackageAllocationGroupPackageEvidenceV1[];
  readonly sourceEvidence: readonly PackageAllocationGroupSourceEvidenceV1[];
  readonly effectIntentEvidence: readonly PackageAllocationEffectIntentEvidenceV1[];
}

export interface PackageAllocationGroupPlannerResultV1 {
  readonly contractVersion: 1;
  readonly authority: "shadow_only";
  readonly groupKey: string;
  readonly outcome: "unchanged" | "proposed" | "review";
  readonly baseGroupVersion: number;
  readonly proposedGroupVersion: number;
  readonly evidenceHash: string;
  readonly stateHash: string;
  readonly state: PackageAllocationGroupStateV1;
  readonly ledgerEntriesToAppend: readonly PackageAllocationEntryV1[];
  readonly effectIntentsToAppend: readonly PackageAllocationEffectIntentV1[];
}

export type PackageAllocationGroupErrorCode =
  | "CONFLICTING_ACTION_REPLAY"
  | "CONFLICTING_EFFECT_INTENT_REPLAY"
  | "CONFLICTING_PACKAGE_HISTORY"
  | "CONFLICTING_PACKAGE_LIFECYCLE_REPLAY"
  | "CONFLICTING_SOURCE_HISTORY"
  | "DUPLICATE_IDENTITY"
  | "GROUP_VERSION_EXHAUSTED"
  | "INCOMPLETE_ACTION_HISTORY"
  | "INCOMPLETE_PACKAGE_HISTORY"
  | "INCOMPLETE_PACKAGE_LIFECYCLE_HISTORY"
  | "INCOMPLETE_SOURCE_HISTORY"
  | "INVALID_PACKAGE_GROUP"
  | "PREVIOUS_ALLOCATION_REPLAY_BLOCKED"
  | "SOURCE_AUTHORITY_REGRESSION"
  | "STALE_GROUP_VERSION"
  | "UNSAFE_QUANTITY_TOTAL";
export class PackageAllocationGroupError extends Error {
  readonly code: PackageAllocationGroupErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: PackageAllocationGroupErrorCode,
    message: string,
    context: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PackageAllocationGroupError";
    this.code = code;
    this.context = deepFreeze({ ...context });
  }
}

interface ProjectedPackage {
  readonly packageKey: string;
  readonly allocationRole: PackageAllocationGroupPackageInput["allocationRole"];
  readonly membership: PackageAllocationGroupPackageInput["membership"];
  readonly projection: DeclaredPackageLifecycleProjection;
  readonly lifecycleEventEvidence: readonly PackageAllocationGroupLifecycleEventEvidenceV1[];
}

interface MutablePrimarySegment {
  readonly originPackageKey: string | null;
  targetKind: PackageAllocationTargetKind;
  packageKey: string | null;
  quantity: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function checkedAdd(left: number, right: number, context: Record<string, unknown>): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new PackageAllocationGroupError(
      "UNSAFE_QUANTITY_TOTAL",
      "Package allocation quantity total is outside the safe integer range",
      context,
    );
  }
  return total;
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

function uniqueSortedText(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareText));
}

function uniqueSortedNumbers(values: readonly number[]): readonly number[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left - right));
}

function buildLifecycleEventEvidence(
  events: DeclaredPackageLifecycleInput["events"],
): readonly PackageAllocationGroupLifecycleEventEvidenceV1[] {
  const eventHashes = new Map<string, string>();
  for (const event of events) {
    const eventHash = sha256(canonicalJson(event));
    const previousHash = eventHashes.get(event.eventKey);
    if (previousHash !== undefined && previousHash !== eventHash) {
      throw new PackageAllocationGroupError(
        "INVALID_PACKAGE_GROUP",
        "Current package lifecycle evidence contains a conflicting event replay",
        { eventKey: event.eventKey },
      );
    }
    eventHashes.set(event.eventKey, eventHash);
  }
  return Object.freeze([...eventHashes.entries()]
    .map(([eventKey, eventHash]) => deepFreeze({ eventKey, eventHash }))
    .sort((left, right) => compareText(left.eventKey, right.eventKey)));
}

function review(
  code: PackageAllocationReviewCode,
  packageKeys: readonly string[] = [],
  wmsShipmentItemIds: readonly number[] = [],
  actionKeys: readonly string[] = [],
): PackageAllocationReviewV1 {
  return deepFreeze({
    code,
    packageKeys: uniqueSortedText(packageKeys),
    wmsShipmentItemIds: uniqueSortedNumbers(wmsShipmentItemIds),
    actionKeys: uniqueSortedText(actionKeys),
  });
}

function effectIntent(input: Omit<PackageAllocationEffectIntentV1, "executable" | "payloadHash">): PackageAllocationEffectIntentV1 {
  const payload = {
    effectType: input.effectType,
    subjectKey: input.subjectKey,
    wmsShipmentItemId: input.wmsShipmentItemId,
    packageKey: input.packageKey,
    quantity: input.quantity,
  };
  return deepFreeze({
    ...input,
    executable: false as const,
    payloadHash: sha256(canonicalJson(payload)),
  });
}

function normalizeActions(
  actions: readonly PackageAllocationGroupAction[],
): readonly PackageAllocationGroupAction[] {
  const byKey = new Map<string, { canonical: string; action: PackageAllocationGroupAction }>();
  for (const action of actions) {
    let normalized: PackageAllocationGroupAction;
    if (action.kind === "transfer_awaiting_allocation") {
      const targetIdentities = new Set<string>();
      for (const target of action.targets) {
        const targetIdentity = canonicalJson([target.packageKey, target.wmsShipmentItemId]);
        if (targetIdentities.has(targetIdentity)) {
          throw new PackageAllocationGroupError(
            "DUPLICATE_IDENTITY",
            "A transfer action may identify a package line only once",
            {
              actionKey: action.actionKey,
              packageKey: target.packageKey,
              wmsShipmentItemId: target.wmsShipmentItemId,
            },
          );
        }
        targetIdentities.add(targetIdentity);
      }
      normalized = {
        ...action,
        targets: [...action.targets]
          .sort((left, right) => compareText(left.packageKey, right.packageKey)
            || left.wmsShipmentItemId - right.wmsShipmentItemId
            || left.quantity - right.quantity),
      };
    } else {
      normalized = { ...action };
    }
    const canonical = canonicalJson(normalized);
    const existing = byKey.get(normalized.actionKey);
    if (existing && existing.canonical !== canonical) {
      throw new PackageAllocationGroupError(
        "CONFLICTING_ACTION_REPLAY",
        "The same package allocation action key was reused with different evidence",
        { actionKey: normalized.actionKey },
      );
    }
    if (!existing) byKey.set(normalized.actionKey, { canonical, action: normalized });
  }
  return Object.freeze([...byKey.values()]
    .map(({ action }) => deepFreeze(action))
    .sort((left, right) => compareText(left.actionKey, right.actionKey)));
}

function validateUniqueIdentities(
  sourceLines: readonly PackageAllocationGroupSourceLine[],
  packages: readonly ProjectedPackage[],
): void {
  const sourceIds = new Set<number>();
  for (const line of sourceLines) {
    if (sourceIds.has(line.wmsShipmentItemId)) {
      throw new PackageAllocationGroupError(
        "DUPLICATE_IDENTITY",
        "A WMS shipment item may appear only once in a package allocation group",
        { wmsShipmentItemId: line.wmsShipmentItemId },
      );
    }
    sourceIds.add(line.wmsShipmentItemId);
  }

  const packageKeys = new Set<string>();
  const providerIdentities = new Set<string>();
  for (const pkg of packages) {
    if (packageKeys.has(pkg.packageKey)) {
      throw new PackageAllocationGroupError(
        "DUPLICATE_IDENTITY",
        "A package key may appear only once in a package allocation group",
        { packageKey: pkg.packageKey },
      );
    }
    packageKeys.add(pkg.packageKey);
    const providerIdentity = `${pkg.projection.provider}:${pkg.projection.providerPhysicalShipmentId}`;
    if (providerIdentities.has(providerIdentity)) {
      throw new PackageAllocationGroupError(
        "DUPLICATE_IDENTITY",
        "A provider package identity may not be bound to multiple package keys",
        { providerIdentity },
      );
    }
    providerIdentities.add(providerIdentity);
  }
}

function authoritativeLineMap(
  pkg: ProjectedPackage,
  sourceIds: ReadonlySet<number>,
  reviews: PackageAllocationReviewV1[],
): ReadonlyMap<number, number> | null {
  if (pkg.membership.status !== "proven") {
    reviews.push(review("package_membership_unproven", [pkg.packageKey]));
    return null;
  }
  if (pkg.projection.reconciliationStatus === "review") {
    reviews.push(review("package_lifecycle_review", [pkg.packageKey]));
  }
  if (pkg.projection.authoritativeContents === null) {
    reviews.push(review("package_contents_unavailable", [pkg.packageKey]));
    return null;
  }
  const result = new Map<number, number>();
  const unknownIds: number[] = [];
  for (const line of pkg.projection.authoritativeContents) {
    if (!sourceIds.has(line.wmsShipmentItemId)) {
      unknownIds.push(line.wmsShipmentItemId);
    } else {
      result.set(line.wmsShipmentItemId, line.quantity);
    }
  }
  if (unknownIds.length > 0) {
    reviews.push(review("package_line_not_in_group", [pkg.packageKey], unknownIds));
    return null;
  }
  return result;
}

function aggregateEntries(entries: readonly PackageAllocationEntryV1[]): readonly PackageAllocationEntryV1[] {
  const totals = new Map<string, PackageAllocationEntryV1>();
  for (const entry of entries) {
    const identity = [
      entry.allocationKey,
      entry.wmsShipmentItemId,
      entry.allocationKind,
      entry.targetKind,
      entry.packageKey ?? "-",
    ].join(":");
    const existing = totals.get(identity);
    if (!existing) {
      totals.set(identity, entry);
    } else {
      totals.set(identity, {
        ...existing,
        quantity: checkedAdd(existing.quantity, entry.quantity, {
          allocationKey: entry.allocationKey,
          wmsShipmentItemId: entry.wmsShipmentItemId,
        }),
      });
    }
  }
  return Object.freeze([...totals.values()]
    .map((entry) => deepFreeze(entry))
    .sort((left, right) => compareText(left.entryKey, right.entryKey)));
}

function dedupeReviews(reviews: readonly PackageAllocationReviewV1[]): readonly PackageAllocationReviewV1[] {
  const unique = new Map<string, PackageAllocationReviewV1>();
  for (const item of reviews) unique.set(canonicalJson(item), item);
  return Object.freeze([...unique.values()].sort((left, right) => (
    compareText(left.code, right.code)
    || compareText(canonicalJson(left), canonicalJson(right))
  )));
}

function intentSort(left: PackageAllocationEffectIntentV1, right: PackageAllocationEffectIntentV1): number {
  return compareText(left.intentKey, right.intentKey);
}

export function planPackageAllocationGroup(
  rawInput: PackageAllocationGroupPlannerInput,
): PackageAllocationGroupPlannerResultV1 {
  const parsed = packageAllocationGroupPlannerInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new PackageAllocationGroupError(
      "INVALID_PACKAGE_GROUP",
      "Package allocation group input is invalid",
      { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
    );
  }
  const input: ParsedPlannerInput = parsed.data;
  if (input.previousPlan !== null && input.previousPlan.groupKey !== input.groupKey) {
    throw new PackageAllocationGroupError(
      "INVALID_PACKAGE_GROUP",
      "The previous package allocation plan belongs to a different group",
      {
        groupKey: input.groupKey,
        previousGroupKey: input.previousPlan.groupKey,
      },
    );
  }

  if ((input.previousPlan === null && input.expectedGroupVersion !== 0)
      || (input.previousPlan !== null && input.previousPlan.groupVersion !== input.expectedGroupVersion)) {
    throw new PackageAllocationGroupError(
      "STALE_GROUP_VERSION",
      "The package allocation plan was built against a stale group version",
      {
        expectedGroupVersion: input.expectedGroupVersion,
        actualGroupVersion: input.previousPlan?.groupVersion ?? null,
      },
    );
  }

  const sourceLines = Object.freeze([...input.sourceLines]
    .sort((left, right) => left.wmsShipmentItemId - right.wmsShipmentItemId)
    .map((line) => deepFreeze({ ...line })));
  const sourceEvidence: readonly PackageAllocationGroupSourceEvidenceV1[] = Object.freeze(
    sourceLines.map((line) => deepFreeze({
      ...line,
      sourceHash: sha256(canonicalJson(line)),
    })),
  );
  if (input.previousPlan !== null) {
    const currentById = new Map(sourceEvidence.map((line) => [line.wmsShipmentItemId, line]));
    const previousIds = new Set<number>();
    for (const previousSource of input.previousPlan.sourceEvidence as readonly ParsedSourceLineEvidence[]) {
      const source = {
        wmsShipmentItemId: previousSource.wmsShipmentItemId,
        sourceQuantity: previousSource.sourceQuantity,
        physicalConsumptionAuthorityQuantity: previousSource.physicalConsumptionAuthorityQuantity,
        authorityVersion: previousSource.authorityVersion,
      };
      if (previousSource.sourceHash !== sha256(canonicalJson(source))) {
        throw new PackageAllocationGroupError(
          "INVALID_PACKAGE_GROUP",
          "Previous source-line evidence is internally inconsistent",
          { wmsShipmentItemId: previousSource.wmsShipmentItemId },
        );
      }
      if (previousIds.has(previousSource.wmsShipmentItemId)) {
        throw new PackageAllocationGroupError(
          "INVALID_PACKAGE_GROUP",
          "Previous source-line evidence contains a duplicate WMS shipment item",
          { wmsShipmentItemId: previousSource.wmsShipmentItemId },
        );
      }
      previousIds.add(previousSource.wmsShipmentItemId);
      const currentSource = currentById.get(previousSource.wmsShipmentItemId);
      if (currentSource === undefined) {
        throw new PackageAllocationGroupError(
          "INCOMPLETE_SOURCE_HISTORY",
          "A previously allocated WMS shipment item is missing from the current plan input",
          { wmsShipmentItemId: previousSource.wmsShipmentItemId },
        );
      }
      if (currentSource.sourceQuantity !== previousSource.sourceQuantity) {
        throw new PackageAllocationGroupError(
          "CONFLICTING_SOURCE_HISTORY",
          "An immutable source quantity changed across package allocation plans",
          {
            wmsShipmentItemId: previousSource.wmsShipmentItemId,
            previousSourceQuantity: previousSource.sourceQuantity,
            currentSourceQuantity: currentSource.sourceQuantity,
          },
        );
      }
      const previousAuthority = previousSource.physicalConsumptionAuthorityQuantity;
      const currentAuthority = currentSource.physicalConsumptionAuthorityQuantity;
      if (currentSource.authorityVersion < previousSource.authorityVersion
          || (previousAuthority !== null
            && (currentAuthority === null || currentAuthority < previousAuthority))) {
        throw new PackageAllocationGroupError(
          "SOURCE_AUTHORITY_REGRESSION",
          "Physical-consumption authority cannot move backwards",
          {
            wmsShipmentItemId: previousSource.wmsShipmentItemId,
            previousAuthorityVersion: previousSource.authorityVersion,
            currentAuthorityVersion: currentSource.authorityVersion,
            previousAuthorityQuantity: previousAuthority,
            currentAuthorityQuantity: currentAuthority,
          },
        );
      }
      if (currentAuthority !== previousAuthority
          && currentSource.authorityVersion <= previousSource.authorityVersion) {
        throw new PackageAllocationGroupError(
          "CONFLICTING_SOURCE_HISTORY",
          "A physical-consumption authority change requires a newer authority version",
          { wmsShipmentItemId: previousSource.wmsShipmentItemId },
        );
      }
    }
    const newSourceIds = sourceEvidence
      .map((line) => line.wmsShipmentItemId)
      .filter((wmsShipmentItemId) => !previousIds.has(wmsShipmentItemId));
    if (newSourceIds.length > 0) {
      throw new PackageAllocationGroupError(
        "CONFLICTING_SOURCE_HISTORY",
        "Package allocation group source membership is immutable after its first plan",
        { wmsShipmentItemIds: newSourceIds },
      );
    }
  }
  const projectedPackages: readonly ProjectedPackage[] = Object.freeze(input.packages
    .map((pkg) => {
      const projection = projectDeclaredPackageLifecycle(pkg.lifecycle);
      return {
        packageKey: pkg.packageKey,
        allocationRole: pkg.allocationRole,
        membership: deepFreeze({ ...pkg.membership }),
        projection,
        lifecycleEventEvidence: buildLifecycleEventEvidence(pkg.lifecycle.events),
      };
    })
    .sort((left, right) => compareText(left.packageKey, right.packageKey)));
  validateUniqueIdentities(sourceLines, projectedPackages);
  const packageEvidence: readonly PackageAllocationGroupPackageEvidenceV1[] = Object.freeze(
    projectedPackages.map((pkg) => {
      const identity = {
        packageKey: pkg.packageKey,
        allocationRole: pkg.allocationRole,
        provider: pkg.projection.provider,
        providerPhysicalShipmentId: pkg.projection.providerPhysicalShipmentId,
      };
      return deepFreeze({
        ...identity,
        identityHash: sha256(canonicalJson(identity)),
        lifecycleEventEvidence: pkg.lifecycleEventEvidence,
      });
    }),
  );
  const actions = normalizeActions(input.actions);
  const actionEvidence: readonly PackageAllocationGroupActionEvidenceV1[] = Object.freeze(actions.map((action) => (
    deepFreeze({
      actionKey: action.actionKey,
      actionHash: sha256(canonicalJson(action)),
      action,
    })
  )));
  const previousAppliedActionKeys = new Set<string>();
  if (input.previousPlan !== null) {
    const currentActionHashes = new Map(actionEvidence.map((item) => [item.actionKey, item.actionHash]));
    const previousActionKeys = new Set<string>();
    for (const previousAction of input.previousPlan.actionEvidence as readonly ParsedActionEvidence[]) {
      if (previousAction.actionKey !== previousAction.action.actionKey
          || previousAction.actionHash !== sha256(canonicalJson(previousAction.action))) {
        throw new PackageAllocationGroupError(
          "INVALID_PACKAGE_GROUP",
          "Previous package allocation action evidence is internally inconsistent",
          { actionKey: previousAction.actionKey },
        );
      }
      if (previousActionKeys.has(previousAction.actionKey)) {
        throw new PackageAllocationGroupError(
          "INVALID_PACKAGE_GROUP",
          "Previous package allocation action evidence contains a duplicate action key",
          { actionKey: previousAction.actionKey },
        );
      }
      previousActionKeys.add(previousAction.actionKey);
      const currentHash = currentActionHashes.get(previousAction.actionKey);
      if (currentHash === undefined) {
        throw new PackageAllocationGroupError(
          "INCOMPLETE_ACTION_HISTORY",
          "A previously observed package allocation action is missing from the current plan input",
          { actionKey: previousAction.actionKey },
        );
      }
      if (currentHash !== previousAction.actionHash) {
        throw new PackageAllocationGroupError(
          "CONFLICTING_ACTION_REPLAY",
          "A previously observed package allocation action key was reused with different evidence",
          { actionKey: previousAction.actionKey },
        );
      }
    }
    for (const actionKey of input.previousPlan.appliedActionKeys) {
      if (previousAppliedActionKeys.has(actionKey) || !previousActionKeys.has(actionKey)) {
        throw new PackageAllocationGroupError(
          "INVALID_PACKAGE_GROUP",
          "Previous applied action keys must be unique and backed by action evidence",
          { actionKey },
        );
      }
      previousAppliedActionKeys.add(actionKey);
    }
  }
  const sourceIds = new Set(sourceLines.map((line) => line.wmsShipmentItemId));
  const packageByKey = new Map(projectedPackages.map((pkg) => [pkg.packageKey, pkg]));
  if (input.previousPlan !== null) {
    const currentEvidenceByKey = new Map(packageEvidence.map((item) => [item.packageKey, item]));
    const previousKeys = new Set<string>();
    const previousProviderIdentities = new Set<string>();
    for (const previousPackage of input.previousPlan.packageEvidence as readonly ParsedPackageIdentityEvidence[]) {
      const identity = {
        packageKey: previousPackage.packageKey,
        allocationRole: previousPackage.allocationRole,
        provider: previousPackage.provider,
        providerPhysicalShipmentId: previousPackage.providerPhysicalShipmentId,
      };
      if (previousPackage.identityHash !== sha256(canonicalJson(identity))) {
        throw new PackageAllocationGroupError(
          "INVALID_PACKAGE_GROUP",
          "Previous package identity evidence is internally inconsistent",
          { packageKey: previousPackage.packageKey },
        );
      }
      const providerIdentity = `${previousPackage.provider}:${previousPackage.providerPhysicalShipmentId}`;
      if (previousKeys.has(previousPackage.packageKey)
          || previousProviderIdentities.has(providerIdentity)) {
        throw new PackageAllocationGroupError(
          "INVALID_PACKAGE_GROUP",
          "Previous package identity evidence contains a duplicate identity",
          { packageKey: previousPackage.packageKey, providerIdentity },
        );
      }
      previousKeys.add(previousPackage.packageKey);
      previousProviderIdentities.add(providerIdentity);
      const currentPackage = currentEvidenceByKey.get(previousPackage.packageKey);
      if (currentPackage === undefined) {
        throw new PackageAllocationGroupError(
          "INCOMPLETE_PACKAGE_HISTORY",
          "A previously observed physical package is missing from the current plan input",
          { packageKey: previousPackage.packageKey, providerIdentity },
        );
      }
      if (currentPackage.allocationRole !== previousPackage.allocationRole
          || currentPackage.provider !== previousPackage.provider
          || currentPackage.providerPhysicalShipmentId !== previousPackage.providerPhysicalShipmentId) {
        throw new PackageAllocationGroupError(
          "CONFLICTING_PACKAGE_HISTORY",
          "A stable package key was rebound to different physical package evidence",
          {
            packageKey: previousPackage.packageKey,
            previousProviderIdentity: providerIdentity,
            currentProviderIdentity: `${currentPackage.provider}:${currentPackage.providerPhysicalShipmentId}`,
            previousAllocationRole: previousPackage.allocationRole,
            currentAllocationRole: currentPackage.allocationRole,
          },
        );
      }
      const currentLifecycleByKey = new Map(
        currentPackage.lifecycleEventEvidence.map((event) => [event.eventKey, event.eventHash]),
      );
      const previousLifecycleKeys = new Set<string>();
      for (const previousEvent of previousPackage.lifecycleEventEvidence) {
        if (previousLifecycleKeys.has(previousEvent.eventKey)) {
          throw new PackageAllocationGroupError(
            "INVALID_PACKAGE_GROUP",
            "Previous package lifecycle evidence contains a duplicate event key",
            { packageKey: previousPackage.packageKey, eventKey: previousEvent.eventKey },
          );
        }
        previousLifecycleKeys.add(previousEvent.eventKey);
        const currentEventHash = currentLifecycleByKey.get(previousEvent.eventKey);
        if (currentEventHash === undefined) {
          throw new PackageAllocationGroupError(
            "INCOMPLETE_PACKAGE_LIFECYCLE_HISTORY",
            "Previously observed package lifecycle evidence is missing from the current plan input",
            { packageKey: previousPackage.packageKey, eventKey: previousEvent.eventKey },
          );
        }
        if (currentEventHash !== previousEvent.eventHash) {
          throw new PackageAllocationGroupError(
            "CONFLICTING_PACKAGE_LIFECYCLE_REPLAY",
            "A stable package lifecycle event key was replayed with different evidence",
            { packageKey: previousPackage.packageKey, eventKey: previousEvent.eventKey },
          );
        }
      }
    }
  }
  const reviews: PackageAllocationReviewV1[] = [];
  const lineMaps = new Map<string, ReadonlyMap<number, number> | null>();
  for (const pkg of projectedPackages) {
    lineMaps.set(pkg.packageKey, authoritativeLineMap(pkg, sourceIds, reviews));
  }
  const priorTransferSourceKeys = new Set(
    actions
      .filter((action) => (
        action.kind === "transfer_awaiting_allocation"
        && previousAppliedActionKeys.has(action.actionKey)
      ))
      .map((action) => action.fromPackageKey),
  );
  const latePossessionTransferSourceKeys = new Set(
    projectedPackages
      .filter((pkg) => (
        priorTransferSourceKeys.has(pkg.packageKey)
        && pkg.projection.carrierStatus === "possession_confirmed"
      ))
      .map((pkg) => pkg.packageKey),
  );

  const primarySegments = new Map<number, MutablePrimarySegment[]>();
  const declaredPrimaryQuantity = new Map<number, number>();
  const primaryCommercialEligibleQuantity = new Map<number, number>();
  const primaryInventoryEligibleQuantity = new Map<number, number>();
  for (const source of sourceLines) {
    const contributions: MutablePrimarySegment[] = [];
    let declared = 0;
    let commercialEligible = 0;
    let inventoryEligible = 0;
    for (const pkg of projectedPackages.filter((candidate) => candidate.allocationRole === "primary")) {
      const quantity = lineMaps.get(pkg.packageKey)?.get(source.wmsShipmentItemId) ?? 0;
      if (quantity === 0) continue;
      declared = checkedAdd(declared, quantity, {
        packageKey: pkg.packageKey,
        wmsShipmentItemId: source.wmsShipmentItemId,
      });
      const carrierLocked = pkg.projection.carrierStatus === "possession_confirmed";
      const targetPackage = carrierLocked || pkg.projection.labelStatus === "active";
      if (pkg.projection.commercialFulfillmentPostingEligible) {
        commercialEligible = checkedAdd(commercialEligible, quantity, {
          packageKey: pkg.packageKey,
          wmsShipmentItemId: source.wmsShipmentItemId,
          effectType: "commercial_fulfillment",
        });
      }
      if (pkg.projection.inventoryPostingEligible) {
        inventoryEligible = checkedAdd(inventoryEligible, quantity, {
          packageKey: pkg.packageKey,
          wmsShipmentItemId: source.wmsShipmentItemId,
          effectType: "inventory_consumption",
        });
      }
      contributions.push({
        originPackageKey: pkg.packageKey,
        targetKind: targetPackage ? "package" : "awaiting_relabel",
        packageKey: targetPackage ? pkg.packageKey : null,
        quantity,
      });
    }
    declaredPrimaryQuantity.set(source.wmsShipmentItemId, declared);
    if (declared > source.sourceQuantity) {
      reviews.push(review(
        "primary_allocation_exceeds_source",
        projectedPackages.filter((pkg) => pkg.allocationRole === "primary").map((pkg) => pkg.packageKey),
        [source.wmsShipmentItemId],
      ));
      primaryCommercialEligibleQuantity.set(source.wmsShipmentItemId, 0);
      primaryInventoryEligibleQuantity.set(source.wmsShipmentItemId, 0);
      primarySegments.set(source.wmsShipmentItemId, [{
        originPackageKey: null,
        targetKind: "awaiting_relabel",
        packageKey: null,
        quantity: source.sourceQuantity,
      }]);
      continue;
    }
    if (declared < source.sourceQuantity) {
      contributions.push({
        originPackageKey: null,
        targetKind: "awaiting_relabel",
        packageKey: null,
        quantity: source.sourceQuantity - declared,
      });
    }
    primarySegments.set(source.wmsShipmentItemId, contributions);
    primaryCommercialEligibleQuantity.set(source.wmsShipmentItemId, commercialEligible);
    primaryInventoryEligibleQuantity.set(source.wmsShipmentItemId, inventoryEligible);
  }

  const competingNewActionKeys = new Set<string>();
  const newClaims = new Map<string, {
    readonly fromPackageKey: string;
    readonly wmsShipmentItemId: number;
    readonly actionKeys: Set<string>;
    readonly targetPackageKeys: Set<string>;
    readonly actionKinds: Set<PackageAllocationGroupAction["kind"]>;
  }>();
  for (const action of actions) {
    if (previousAppliedActionKeys.has(action.actionKey)) continue;
    const actionClaims = action.kind === "transfer_awaiting_allocation"
      ? action.targets.map((target) => ({
        wmsShipmentItemId: target.wmsShipmentItemId,
        targetPackageKey: target.packageKey as string | null,
      }))
      : [{
        wmsShipmentItemId: action.wmsShipmentItemId,
        targetPackageKey: null,
      }];
    for (const actionClaim of actionClaims) {
      const claimKey = canonicalJson([action.fromPackageKey, actionClaim.wmsShipmentItemId]);
      const claim = newClaims.get(claimKey) ?? {
        fromPackageKey: action.fromPackageKey,
        wmsShipmentItemId: actionClaim.wmsShipmentItemId,
        actionKeys: new Set<string>(),
        targetPackageKeys: new Set<string>(),
        actionKinds: new Set<PackageAllocationGroupAction["kind"]>(),
      };
      claim.actionKeys.add(action.actionKey);
      claim.actionKinds.add(action.kind);
      if (actionClaim.targetPackageKey !== null) {
        claim.targetPackageKeys.add(actionClaim.targetPackageKey);
      }
      newClaims.set(claimKey, claim);
    }
  }
  for (const claim of newClaims.values()) {
    if (claim.actionKeys.size < 2) continue;
    for (const actionKey of claim.actionKeys) competingNewActionKeys.add(actionKey);
    reviews.push(review(
      claim.actionKinds.size === 1
        && claim.actionKinds.has("transfer_awaiting_allocation")
        ? "competing_transfer_actions"
        : "competing_allocation_actions",
      [claim.fromPackageKey, ...claim.targetPackageKeys],
      [claim.wmsShipmentItemId],
      [...claim.actionKeys],
    ));
  }
  const actionsInApplicationOrder = Object.freeze([...actions].sort((left, right) => {
    const leftOrder = previousAppliedActionKeys.has(left.actionKey) ? 0 : 1;
    const rightOrder = previousAppliedActionKeys.has(right.actionKey) ? 0 : 1;
    return leftOrder - rightOrder || compareText(left.actionKey, right.actionKey);
  }));

  const transferredTargets = new Set<string>();
  const latePossessionAdditionalQuantityByPackage = new Map<string, Map<number, number>>();
  const appliedActionKeys: string[] = [];
  for (const action of actionsInApplicationOrder) {
    if (competingNewActionKeys.has(action.actionKey)) continue;
    const actionWasPreviouslyApplied = previousAppliedActionKeys.has(action.actionKey);
    const from = packageByKey.get(action.fromPackageKey);

    if (action.kind === "cancel_awaiting_allocation") {
      if (!from || from.allocationRole !== "primary" || from.membership.status !== "proven") {
        reviews.push(review(
          "invalid_cancellation_source",
          [action.fromPackageKey],
          [action.wmsShipmentItemId],
          [action.actionKey],
        ));
        continue;
      }

      if (actionWasPreviouslyApplied
          && from.projection.carrierStatus === "possession_confirmed") {
        reviews.push(review(
          "cancellation_superseded_by_carrier_possession",
          [from.packageKey],
          [action.wmsShipmentItemId],
          [action.actionKey],
        ));
        appliedActionKeys.push(action.actionKey);
        continue;
      }

      if (from.projection.carrierStatus === "possession_confirmed") {
        reviews.push(review(
          "cancellation_after_carrier_lock",
          [from.packageKey],
          [action.wmsShipmentItemId],
          [action.actionKey],
        ));
        continue;
      }

      if (from.projection.labelStatus !== "voided"
          || from.projection.correctionStatus !== "awaiting_relabel") {
        reviews.push(review(
          "invalid_cancellation_source",
          [from.packageKey],
          [action.wmsShipmentItemId],
          [action.actionKey],
        ));
        continue;
      }

      const fromLines = lineMaps.get(from.packageKey);
      if (!fromLines || !fromLines.has(action.wmsShipmentItemId)) {
        reviews.push(review(
          "invalid_cancellation_source",
          [from.packageKey],
          [action.wmsShipmentItemId],
          [action.actionKey],
        ));
        continue;
      }

      const segments = primarySegments.get(action.wmsShipmentItemId) ?? [];
      const available = segments
        .filter((segment) => (
          segment.originPackageKey === from.packageKey
          && segment.targetKind === "awaiting_relabel"
        ))
        .reduce((total, segment) => checkedAdd(total, segment.quantity, {
          actionKey: action.actionKey,
          wmsShipmentItemId: action.wmsShipmentItemId,
        }), 0);
      const sourceQuantity = fromLines.get(action.wmsShipmentItemId) ?? 0;
      if (action.quantity > sourceQuantity || action.quantity > available) {
        reviews.push(review(
          "cancellation_exceeds_awaiting_relabel",
          [from.packageKey],
          [action.wmsShipmentItemId],
          [action.actionKey],
        ));
        continue;
      }

      let remaining = action.quantity;
      const heldSegments: MutablePrimarySegment[] = [];
      for (const segment of segments) {
        if (remaining === 0) break;
        if (segment.originPackageKey !== from.packageKey
            || segment.targetKind !== "awaiting_relabel") {
          continue;
        }
        const moved = Math.min(segment.quantity, remaining);
        segment.quantity -= moved;
        heldSegments.push({
          originPackageKey: from.packageKey,
          targetKind: "held_for_unpack",
          packageKey: null,
          quantity: moved,
        });
        remaining -= moved;
      }
      primarySegments.set(
        action.wmsShipmentItemId,
        [...segments, ...heldSegments].filter((segment) => segment.quantity > 0),
      );
      appliedActionKeys.push(action.actionKey);
      continue;
    }

    if (!from || from.allocationRole !== "primary" || from.membership.status !== "proven") {
      reviews.push(review("invalid_transfer_source", [action.fromPackageKey], [], [action.actionKey]));
      continue;
    }
    const replaysLatePossessionTransfer = actionWasPreviouslyApplied
      && latePossessionTransferSourceKeys.has(from.packageKey);
    if (from.projection.carrierStatus === "possession_confirmed"
        && !replaysLatePossessionTransfer) {
      reviews.push(review(
        "late_possession_requires_previous_ledger",
        [action.fromPackageKey],
        [],
        [action.actionKey],
      ));
      continue;
    }
    const sourceCanTransfer = from.projection.labelStatus === "voided"
      && (
        from.projection.correctionStatus === "awaiting_relabel"
        || (replaysLatePossessionTransfer && from.projection.correctionStatus === "carrier_locked")
      );
    if (!sourceCanTransfer) {
      reviews.push(review("invalid_transfer_source", [action.fromPackageKey], [], [action.actionKey]));
      continue;
    }
    const fromLines = lineMaps.get(from.packageKey);
    if (!fromLines) {
      reviews.push(review("invalid_transfer_source", [action.fromPackageKey], [], [action.actionKey]));
      continue;
    }

    const actionTotalsByTarget = new Map<string, Map<number, number>>();
    const actionTotalsByLine = new Map<number, number>();
    let actionValid = true;
    for (const target of action.targets) {
      const targetPackage = packageByKey.get(target.packageKey);
      const replaysCarrierLockedTarget = actionWasPreviouslyApplied
        && targetPackage?.projection.carrierStatus === "possession_confirmed";
      if (!targetPackage
          || targetPackage.allocationRole !== "replacement_candidate"
          || targetPackage.membership.status !== "proven"
          || (!replaysCarrierLockedTarget && targetPackage.projection.labelStatus !== "active")
          || (targetPackage.projection.carrierStatus === "possession_confirmed"
            && !actionWasPreviouslyApplied)
          || transferredTargets.has(target.packageKey)) {
        reviews.push(review(
          "invalid_transfer_target",
          [target.packageKey],
          [target.wmsShipmentItemId],
          [action.actionKey],
        ));
        actionValid = false;
        continue;
      }
      const targetLines = actionTotalsByTarget.get(target.packageKey) ?? new Map<number, number>();
      targetLines.set(
        target.wmsShipmentItemId,
        checkedAdd(targetLines.get(target.wmsShipmentItemId) ?? 0, target.quantity, {
          actionKey: action.actionKey,
          packageKey: target.packageKey,
          wmsShipmentItemId: target.wmsShipmentItemId,
        }),
      );
      actionTotalsByTarget.set(target.packageKey, targetLines);
      actionTotalsByLine.set(
        target.wmsShipmentItemId,
        checkedAdd(actionTotalsByLine.get(target.wmsShipmentItemId) ?? 0, target.quantity, {
          actionKey: action.actionKey,
          wmsShipmentItemId: target.wmsShipmentItemId,
        }),
      );
    }

    for (const [lineId, quantity] of actionTotalsByLine) {
      const fromQuantity = fromLines.get(lineId) ?? 0;
      const available = (primarySegments.get(lineId) ?? [])
        .filter((segment) => segment.originPackageKey === from.packageKey
          && (replaysLatePossessionTransfer
            ? segment.targetKind === "package" && segment.packageKey === from.packageKey
            : segment.targetKind === "awaiting_relabel"))
        .reduce((total, segment) => checkedAdd(total, segment.quantity, {
          actionKey: action.actionKey,
          wmsShipmentItemId: lineId,
        }), 0);
      if (quantity > fromQuantity || quantity > available) {
        reviews.push(review(
          "transfer_exceeds_awaiting_relabel",
          [from.packageKey],
          [lineId],
          [action.actionKey],
        ));
        actionValid = false;
      }
    }

    for (const [targetKey, expectedLines] of actionTotalsByTarget) {
      const actualLines = lineMaps.get(targetKey);
      const expected = [...expectedLines.entries()].sort((a, b) => a[0] - b[0]);
      const actual = actualLines === null || actualLines === undefined
        ? null
        : [...actualLines.entries()].sort((a, b) => a[0] - b[0]);
      if (actual === null || canonicalJson(actual) !== canonicalJson(expected)) {
        reviews.push(review(
          "transfer_contents_mismatch",
          [targetKey],
          expected.map(([lineId]) => lineId),
          [action.actionKey],
        ));
        actionValid = false;
      }
    }
    if (!actionValid) continue;

    for (const target of action.targets) {
      const segments = primarySegments.get(target.wmsShipmentItemId) ?? [];
      let remaining = target.quantity;
      for (const segment of segments) {
        if (remaining === 0) break;
        const isTransferableSourceSegment = segment.originPackageKey === from.packageKey
          && (replaysLatePossessionTransfer
            ? segment.targetKind === "package" && segment.packageKey === from.packageKey
            : segment.targetKind === "awaiting_relabel");
        if (!isTransferableSourceSegment) continue;
        const moved = Math.min(segment.quantity, remaining);
        segment.quantity -= moved;
        segments.push({
          originPackageKey: from.packageKey,
          targetKind: "package",
          packageKey: target.packageKey,
          quantity: moved,
        });
        if (replaysLatePossessionTransfer) {
          const additionalByLine = latePossessionAdditionalQuantityByPackage.get(from.packageKey)
            ?? new Map<number, number>();
          additionalByLine.set(
            target.wmsShipmentItemId,
            checkedAdd(additionalByLine.get(target.wmsShipmentItemId) ?? 0, moved, {
              actionKey: action.actionKey,
              packageKey: from.packageKey,
              wmsShipmentItemId: target.wmsShipmentItemId,
              reason: "late_possession_after_transfer",
            }),
          );
          latePossessionAdditionalQuantityByPackage.set(from.packageKey, additionalByLine);
        }
        remaining -= moved;
      }
      primarySegments.set(
        target.wmsShipmentItemId,
        segments.filter((segment) => segment.quantity > 0),
      );
      transferredTargets.add(target.packageKey);
    }
    appliedActionKeys.push(action.actionKey);
  }
  if (input.previousPlan !== null) {
    const currentAppliedActionKeys = new Set(appliedActionKeys);
    for (const previousActionKey of input.previousPlan.appliedActionKeys) {
      if (!currentAppliedActionKeys.has(previousActionKey)) {
        throw new PackageAllocationGroupError(
          "PREVIOUS_ALLOCATION_REPLAY_BLOCKED",
          "A previously applied allocation action cannot be reconstructed from current evidence",
          { actionKey: previousActionKey },
        );
      }
    }
  }


  for (const pkg of projectedPackages) {
    if (pkg.allocationRole === "replacement_candidate"
        && pkg.projection.businessStatus === "shipped"
        && !transferredTargets.has(pkg.packageKey)) {
      reviews.push(review("replacement_order_unproven", [pkg.packageKey]));
    }
  }

  const rawEntries: PackageAllocationEntryV1[] = [];
  for (const source of sourceLines) {
    const allocationKey = `package-allocation:v1:${input.groupKey}:primary:${source.wmsShipmentItemId}`;
    for (const segment of primarySegments.get(source.wmsShipmentItemId) ?? []) {
      const packageIdentity = segment.packageKey ?? "none";
      rawEntries.push({
        entryKey: `${allocationKey}:${segment.targetKind}:${packageIdentity}`,
        allocationKey,
        wmsShipmentItemId: source.wmsShipmentItemId,
        allocationKind: "primary_transfer",
        targetKind: segment.targetKind,
        packageKey: segment.packageKey,
        quantity: segment.quantity,
      });
    }
  }

  const additionalQuantity = new Map<number, number>();
  const additionalInventoryEligiblePackageKeys = new Set<string>();
  for (const [packageKey, additionalByLine] of latePossessionAdditionalQuantityByPackage) {
    const pkg = packageByKey.get(packageKey);
    if (!pkg) {
      throw new PackageAllocationGroupError(
        "PREVIOUS_ALLOCATION_REPLAY_BLOCKED",
        "A late-possession source package disappeared while reconstructing its prior transfer",
        { packageKey },
      );
    }
    if (pkg.projection.inventoryPostingEligible) {
      additionalInventoryEligiblePackageKeys.add(packageKey);
    }
    for (const [lineId, quantity] of additionalByLine) {
      const allocationKey = `package-allocation:v1:${input.groupKey}:late-possession:${packageKey}:${lineId}`;
      rawEntries.push({
        entryKey: `${allocationKey}:package:${packageKey}`,
        allocationKey,
        wmsShipmentItemId: lineId,
        allocationKind: "additional_physical_consumption",
        targetKind: "package",
        packageKey,
        quantity,
      });
      additionalQuantity.set(lineId, checkedAdd(additionalQuantity.get(lineId) ?? 0, quantity, {
        packageKey,
        wmsShipmentItemId: lineId,
        reason: "late_possession_after_transfer",
      }));
    }
  }
  for (const pkg of projectedPackages.filter((candidate) => candidate.allocationRole === "additional_dispatch")) {
    const contents = lineMaps.get(pkg.packageKey);
    if (!contents || pkg.projection.businessStatus !== "shipped") continue;
    if (pkg.projection.labelStatus !== "active" && pkg.projection.carrierStatus !== "possession_confirmed") {
      reviews.push(review("package_lifecycle_review", [pkg.packageKey]));
      continue;
    }
    reviews.push(review("unclassified_additional_dispatch", [pkg.packageKey]));
    if (pkg.projection.inventoryPostingEligible) {
      additionalInventoryEligiblePackageKeys.add(pkg.packageKey);
    }
    for (const [lineId, quantity] of contents) {
      const allocationKey = `package-allocation:v1:${input.groupKey}:additional:${pkg.packageKey}:${lineId}`;
      rawEntries.push({
        entryKey: `${allocationKey}:package:${pkg.packageKey}`,
        allocationKey,
        wmsShipmentItemId: lineId,
        allocationKind: "additional_physical_consumption",
        targetKind: "package",
        packageKey: pkg.packageKey,
        quantity,
      });
      additionalQuantity.set(lineId, checkedAdd(additionalQuantity.get(lineId) ?? 0, quantity, {
        packageKey: pkg.packageKey,
        wmsShipmentItemId: lineId,
      }));
    }
  }

  const allocations = aggregateEntries(rawEntries);
  const desiredIntents: PackageAllocationEffectIntentV1[] = [];
  for (const source of sourceLines) {
    const primaryDeclared = Math.min(
      declaredPrimaryQuantity.get(source.wmsShipmentItemId) ?? 0,
      source.sourceQuantity,
    );
    const primaryCommercialEligible = Math.min(
      primaryCommercialEligibleQuantity.get(source.wmsShipmentItemId) ?? 0,
      source.sourceQuantity,
    );
    if (primaryCommercialEligible > 0) {
      desiredIntents.push(effectIntent({
        intentKey: `package-allocation:v1:${input.groupKey}:commercial:${source.wmsShipmentItemId}`,
        effectType: "commercial_fulfillment",
        subjectKey: `commercial:${source.wmsShipmentItemId}`,
        wmsShipmentItemId: source.wmsShipmentItemId,
        packageKey: null,
        quantity: primaryCommercialEligible,
      }));
    }
    const totalPhysical = checkedAdd(
      primaryDeclared,
      additionalQuantity.get(source.wmsShipmentItemId) ?? 0,
      { wmsShipmentItemId: source.wmsShipmentItemId },
    );
    if (totalPhysical === 0) continue;
    if (source.physicalConsumptionAuthorityQuantity === null) {
      reviews.push(review("physical_consumption_authority_missing", [], [source.wmsShipmentItemId]));
      continue;
    }
    if (totalPhysical > source.physicalConsumptionAuthorityQuantity) {
      reviews.push(review("physical_consumption_authority_exceeded", [], [source.wmsShipmentItemId]));
      continue;
    }
    const primaryInventoryEligible = Math.min(
      primaryInventoryEligibleQuantity.get(source.wmsShipmentItemId) ?? 0,
      source.sourceQuantity,
    );
    if (primaryInventoryEligible > 0) {
      desiredIntents.push(effectIntent({
        intentKey: `package-allocation:v1:${input.groupKey}:inventory:primary:${source.wmsShipmentItemId}`,
        effectType: "inventory_consumption",
        subjectKey: `primary:${source.wmsShipmentItemId}`,
        wmsShipmentItemId: source.wmsShipmentItemId,
        packageKey: null,
        quantity: primaryInventoryEligible,
      }));
    }
    for (const entry of allocations.filter((candidate) => (
      candidate.wmsShipmentItemId === source.wmsShipmentItemId
      && candidate.allocationKind === "additional_physical_consumption"
      && candidate.packageKey !== null
      && additionalInventoryEligiblePackageKeys.has(candidate.packageKey)
    ))) {
      desiredIntents.push(effectIntent({
        intentKey: `package-allocation:v1:${input.groupKey}:inventory:${entry.allocationKey}`,
        effectType: "inventory_consumption",
        subjectKey: entry.allocationKey,
        wmsShipmentItemId: entry.wmsShipmentItemId,
        packageKey: entry.packageKey,
        quantity: entry.quantity,
      }));
    }
  }

  for (const pkg of projectedPackages) {
    const packageIntent = (
      effectType: PackageAllocationEffectType,
      suffix: string,
    ): void => {
      desiredIntents.push(effectIntent({
        intentKey: `package-allocation:v1:${input.groupKey}:${suffix}:${pkg.packageKey}`,
        effectType,
        subjectKey: pkg.packageKey,
        wmsShipmentItemId: null,
        packageKey: pkg.packageKey,
        quantity: null,
      }));
    };
    const groupMembershipProven = pkg.membership.status === "proven";
    if (groupMembershipProven && pkg.projection.activeTrackingProjectionEligible) {
      packageIntent("active_label_tracking", "active-label-tracking");
    }
    if (groupMembershipProven && pkg.projection.voidTrackingProjectionRequired) {
      packageIntent("pre_possession_void_removal", "pre-possession-void-removal");
    }
    if (groupMembershipProven && pkg.projection.carrierTrackingProjectionRequired) {
      packageIntent("carrier_tracking", "carrier-tracking");
    }
    if (groupMembershipProven && pkg.projection.notificationCandidateEligible) {
      packageIntent("notification_candidate", "notification-candidate");
    }
    if (groupMembershipProven && pkg.projection.notificationProjectionReconciliationRequired) {
      packageIntent("notification_reconciliation", "notification-reconciliation");
    }
  }

  const normalizedReviews = dedupeReviews(reviews);
  const normalizedIntents = Object.freeze(desiredIntents.sort(intentSort));
  const effectEvidenceByKey = new Map<string, string>();
  if (input.previousPlan !== null) {
    for (const previousIntent of input.previousPlan.effectIntentEvidence as readonly ParsedEffectIntentEvidence[]) {
      if (effectEvidenceByKey.has(previousIntent.intentKey)) {
        throw new PackageAllocationGroupError(
          "INVALID_PACKAGE_GROUP",
          "Previous effect intent evidence contains a duplicate intent key",
          { intentKey: previousIntent.intentKey },
        );
      }
      effectEvidenceByKey.set(previousIntent.intentKey, previousIntent.payloadHash);
    }
  }
  const newEffectIntents: PackageAllocationEffectIntentV1[] = [];
  for (const intent of normalizedIntents) {
    const previousHash = effectEvidenceByKey.get(intent.intentKey);
    if (previousHash !== undefined && previousHash !== intent.payloadHash) {
      throw new PackageAllocationGroupError(
        "CONFLICTING_EFFECT_INTENT_REPLAY",
        "A stable package allocation effect intent key changed payload",
        { intentKey: intent.intentKey },
      );
    }
    if (previousHash === undefined) newEffectIntents.push(intent);
    effectEvidenceByKey.set(intent.intentKey, intent.payloadHash);
  }
  const effectIntentEvidence: readonly PackageAllocationEffectIntentEvidenceV1[] = Object.freeze(
    [...effectEvidenceByKey.entries()]
      .map(([intentKey, payloadHash]) => deepFreeze({ intentKey, payloadHash }))
      .sort((left, right) => compareText(left.intentKey, right.intentKey)),
  );

  const packageSnapshots = Object.freeze(projectedPackages.map((pkg) => deepFreeze({
    packageKey: pkg.packageKey,
    allocationRole: pkg.allocationRole,
    membershipStatus: pkg.membership.status,
    provider: pkg.projection.provider,
    providerPhysicalShipmentId: pkg.projection.providerPhysicalShipmentId,
    membershipEvidenceKey: pkg.membership.evidenceKey,
    lifecycleStateHash: pkg.projection.stateHash,
    lifecycleEvidenceHash: pkg.projection.evidenceHash,
    labelStatus: pkg.projection.labelStatus,
    carrierStatus: pkg.projection.carrierStatus,
    correctionStatus: pkg.projection.correctionStatus,
    disposition: pkg.projection.disposition,
  })));
  const state: PackageAllocationGroupStateV1 = deepFreeze({
    sourceLines,
    packageSnapshots,
    allocations,
    desiredEffectIntents: normalizedIntents,
    appliedActionKeys: uniqueSortedText(appliedActionKeys),
    reviews: normalizedReviews,
    actionEvidence,
    packageEvidence,
    sourceEvidence,
    effectIntentEvidence,
  });

  const operationalProjection = {
    sourceLines,
    packageSnapshots: packageSnapshots.map(({ lifecycleEvidenceHash: _lifecycle, membershipEvidenceKey: _membership, ...snapshot }) => snapshot),
    allocations,
    desiredEffectIntents: normalizedIntents,
    appliedActionKeys: state.appliedActionKeys,
    reviews: normalizedReviews,
    actionEvidence,
    packageEvidence: packageEvidence.map(({ lifecycleEventEvidence: _lifecycleEvents, ...identity }) => identity),
    sourceEvidence,
    effectIntentEvidence,
  };
  const stateHash = sha256(canonicalJson(operationalProjection));
  const evidenceHash = sha256(canonicalJson({
    groupKey: input.groupKey,
    sourceLines,
    packages: packageSnapshots,
    actions,
  }));
  const unchanged = input.previousPlan?.stateHash === stateHash;
  const outcome = unchanged
    ? "unchanged" as const
    : normalizedReviews.length > 0
      ? "review" as const
      : "proposed" as const;


  if (!unchanged && input.expectedGroupVersion === POSTGRES_INTEGER_MAX) {
    throw new PackageAllocationGroupError(
      "GROUP_VERSION_EXHAUSTED",
      "The package allocation group version cannot advance beyond the PostgreSQL integer range",
      { expectedGroupVersion: input.expectedGroupVersion },
    );
  }
  return deepFreeze({
    contractVersion: 1 as const,
    authority: "shadow_only" as const,
    groupKey: input.groupKey,
    outcome,
    baseGroupVersion: input.expectedGroupVersion,
    proposedGroupVersion: unchanged
      ? input.expectedGroupVersion
      : input.expectedGroupVersion + 1,
    evidenceHash,
    stateHash,
    state,
    ledgerEntriesToAppend: unchanged ? Object.freeze([]) : allocations,
    effectIntentsToAppend: unchanged ? Object.freeze([]) : Object.freeze(newEffectIntents),
  });
}
