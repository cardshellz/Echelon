import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import {
  adaptPersistedDeclaredPackageLifecycleEvidence,
  projectPersistedDeclaredPackageLifecycleShadow,
  type DeclaredPackageLifecycleShadowEvidenceCoverage,
  type DeclaredPackageLifecycleShadowRejectionReason,
  type PersistedDeclaredPackageEvidence,
} from "./declared-package-lifecycle-shadow.domain";
import {
  derivePackageAllocationSourceRegistration,
  packageAllocationSourceFactsSchema,
  type PackageAllocationSourceFacts,
  type PackageAllocationSourceIdentityError,
  type PackageAllocationSourceRegistrationV1,
} from "./package-allocation-source-identity.domain";

const MEBIBYTE = 1024 * 1024;
const MAX_SOURCE_LINES = 500;
const MAX_PACKAGES = 200;
const MAX_PERSISTED_PACKAGE_EVIDENCE_BYTES = 4 * MEBIBYTE;
const MAX_PERSISTED_PACKAGE_EVIDENCE_NODES = 50_000;
const MAX_TOTAL_PERSISTED_PACKAGE_EVIDENCE_BYTES = 8 * MEBIBYTE;
const MAX_TOTAL_PERSISTED_PACKAGE_EVIDENCE_NODES = 200_000;
const MAX_PERSISTED_PACKAGE_EVIDENCE_DEPTH = 32;

const boundedIdentifier = (field: string, maximum: number) => z.string({
  required_error: `${field} is required`,
})
  .trim()
  .min(1, `${field} must not be blank`)
  .max(maximum, `${field} exceeds ${maximum} characters`);

const packageEvidenceInputSchema = z.object({
  evidenceKey: boundedIdentifier("packages.evidenceKey", 300),
  persistedEvidence: z.unknown(),
}).strict();

export const packageAllocationAuthorityReadinessInputSchema = z.object({
  contractVersion: z.literal(1),
  authorityMode: z.literal("shadow_only"),
  sourceFacts: z.array(packageAllocationSourceFactsSchema).min(1).max(MAX_SOURCE_LINES),
  packages: z.array(packageEvidenceInputSchema).min(1).max(MAX_PACKAGES),
}).strict();

export type PackageAllocationAuthorityReadinessInput = z.input<
  typeof packageAllocationAuthorityReadinessInputSchema
>;

export type PackageAllocationAuthorityReadinessErrorCode =
  | "DUPLICATE_EVIDENCE_KEY"
  | "DUPLICATE_PROVIDER_IDENTITY"
  | "DUPLICATE_SOURCE_IDENTITY"
  | "INVALID_READINESS_INPUT";

export class PackageAllocationAuthorityReadinessError extends Error {
  readonly code: PackageAllocationAuthorityReadinessErrorCode;
  readonly context: Readonly<Record<string, unknown>>;
  override readonly cause?: unknown;

  constructor(
    code: PackageAllocationAuthorityReadinessErrorCode,
    message: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message);
    this.name = "PackageAllocationAuthorityReadinessError";
    this.code = code;
    this.context = Object.freeze({ ...context });
    this.cause = cause;
  }
}

export type PackageAllocationAuthorityReadinessReviewCode =
  | "allocation_role_policy_unresolved"
  | "authoritative_contents_unavailable"
  | "historical_contents_incomplete"
  | "package_lifecycle_evidence_rejected"
  | "package_lifecycle_review"
  | "package_line_outside_candidate_sources"
  | "package_membership_policy_unresolved"
  | "physical_consumption_authority_policy_unresolved";

export interface PackageAllocationAuthorityReadinessReviewV1 {
  readonly code: PackageAllocationAuthorityReadinessReviewCode;
  readonly evidenceKeys: readonly string[];
  readonly wmsShipmentItemIds: readonly number[];
}

export interface PackageAllocationEvidenceAssessmentV1 {
  readonly evidenceKey: string;
  readonly inputEvidenceHash: string;
  readonly lifecycleStatus: "projected" | "rejected";
  readonly lifecycleRejectionReason: DeclaredPackageLifecycleShadowRejectionReason | null;
  readonly evidenceCoverage: DeclaredPackageLifecycleShadowEvidenceCoverage | null;
  readonly provider: string | null;
  readonly providerPhysicalShipmentId: string | null;
  readonly lifecycleEvidenceHash: string | null;
  readonly authoritativeContents: readonly Readonly<{
    wmsShipmentItemId: number;
    quantity: number;
  }>[];
  readonly candidateSourceStatus:
    | "within_candidate_sources"
    | "outside_candidate_sources"
    | "unavailable";
  readonly outsideCandidateSourceIds: readonly number[];
  readonly reviewCodes: readonly PackageAllocationAuthorityReadinessReviewCode[];
}

export interface PackageAllocationAuthorityReadinessResultV1 {
  readonly contractVersion: 1;
  readonly authority: "none";
  readonly outcome: "review";
  /** Diagnostic evidence-assessment hash. It is not an effect or idempotency key. */
  readonly assessmentHash: string;
  readonly sourceRegistrations: readonly PackageAllocationSourceRegistrationV1[];
  readonly packageAssessments: readonly PackageAllocationEvidenceAssessmentV1[];
  readonly reviews: readonly PackageAllocationAuthorityReadinessReviewV1[];
  readonly plannerInput: null;
}

interface MutableReview {
  readonly evidenceKeys: Set<string>;
  readonly wmsShipmentItemIds: Set<number>;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

type PersistedEvidenceInspectionErrorCode =
  | "EVIDENCE_BYTE_BOUND_EXCEEDED"
  | "EVIDENCE_CANONICALIZATION_FAILED"
  | "EVIDENCE_DEPTH_EXCEEDED"
  | "EVIDENCE_INSPECTION_FAILED"
  | "EVIDENCE_NODE_BOUND_EXCEEDED"
  | "EVIDENCE_TOTAL_BYTE_BOUND_EXCEEDED"
  | "EVIDENCE_TOTAL_NODE_BOUND_EXCEEDED"
  | "EVIDENCE_TYPE_UNSUPPORTED";

interface PersistedEvidenceInspectionBudget {
  byteCount: number;
  nodeCount: number;
}

interface BoundedPersistedEvidence {
  readonly inputEvidenceHash: string;
  readonly normalizedEvidence: unknown;
}

function invalidPersistedEvidence(
  evidenceKey: string,
  evidenceErrorCode: PersistedEvidenceInspectionErrorCode,
): PackageAllocationAuthorityReadinessError {
  return new PackageAllocationAuthorityReadinessError(
    "INVALID_READINESS_INPUT",
    "Persisted package evidence failed bounded readiness validation",
    { evidenceKey, evidenceErrorCode },
  );
}

function jsonStringByteLength(value: string): number {
  let byteLength = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f) {
      // JSON escapes every control code. Six bytes is conservative for the
      // five control codes that have a two-byte short escape.
      byteLength += 6;
    } else if (codeUnit === 0x22 || codeUnit === 0x5c) {
      byteLength += 2;
    } else if (codeUnit <= 0x7f) {
      byteLength += 1;
    } else if (codeUnit <= 0x7ff) {
      byteLength += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        byteLength += 4;
        index += 1;
      } else {
        byteLength += 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      byteLength += 6;
    } else {
      byteLength += 3;
    }
  }
  return byteLength;
}

function boundedPersistedEvidence(
  evidenceKey: string,
  rawEvidence: unknown,
  aggregateBudget: PersistedEvidenceInspectionBudget,
): BoundedPersistedEvidence {
  let byteCount = 0;
  let nodeCount = 0;
  const activeObjects = new WeakSet<object>();

  const addBytes = (bytes: number): void => {
    byteCount += bytes;
    aggregateBudget.byteCount += bytes;
    if (byteCount > MAX_PERSISTED_PACKAGE_EVIDENCE_BYTES) {
      throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_BYTE_BOUND_EXCEEDED");
    }
    if (aggregateBudget.byteCount > MAX_TOTAL_PERSISTED_PACKAGE_EVIDENCE_BYTES) {
      throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TOTAL_BYTE_BOUND_EXCEEDED");
    }
  };

  const inspect = (candidate: unknown, depth: number): unknown => {
    if (depth > MAX_PERSISTED_PACKAGE_EVIDENCE_DEPTH) {
      throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_DEPTH_EXCEEDED");
    }
    nodeCount += 1;
    aggregateBudget.nodeCount += 1;
    if (nodeCount > MAX_PERSISTED_PACKAGE_EVIDENCE_NODES) {
      throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_NODE_BOUND_EXCEEDED");
    }
    if (aggregateBudget.nodeCount > MAX_TOTAL_PERSISTED_PACKAGE_EVIDENCE_NODES) {
      throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TOTAL_NODE_BOUND_EXCEEDED");
    }

    if (candidate === null) {
      addBytes(4);
      return null;
    }
    if (typeof candidate === "string") {
      if (candidate.length + 2 > MAX_PERSISTED_PACKAGE_EVIDENCE_BYTES - byteCount) {
        throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_BYTE_BOUND_EXCEEDED");
      }
      addBytes(jsonStringByteLength(candidate));
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TYPE_UNSUPPORTED");
      }
      addBytes(Buffer.byteLength(String(candidate), "utf8"));
      return candidate;
    }
    if (typeof candidate === "boolean") {
      addBytes(candidate ? 4 : 5);
      return candidate;
    }
    if (typeof candidate !== "object") {
      throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TYPE_UNSUPPORTED");
    }
    if (isProxy(candidate)) {
      throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TYPE_UNSUPPORTED");
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype === Date.prototype) {
      if (Reflect.ownKeys(candidate).length > 0) {
        throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TYPE_UNSUPPORTED");
      }
      const timestamp = Date.prototype.getTime.call(candidate);
      if (Number.isNaN(timestamp)) {
        throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TYPE_UNSUPPORTED");
      }
      const isoTimestamp = Date.prototype.toISOString.call(candidate);
      addBytes(jsonStringByteLength(isoTimestamp));
      return isoTimestamp;
    }
    if (activeObjects.has(candidate)) {
      throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TYPE_UNSUPPORTED");
    }

    if (Array.isArray(candidate)) {
      if (prototype !== Array.prototype) {
        throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TYPE_UNSUPPORTED");
      }
      if (nodeCount + candidate.length > MAX_PERSISTED_PACKAGE_EVIDENCE_NODES) {
        throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_NODE_BOUND_EXCEEDED");
      }
      if (aggregateBudget.nodeCount + candidate.length > MAX_TOTAL_PERSISTED_PACKAGE_EVIDENCE_NODES) {
        throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TOTAL_NODE_BOUND_EXCEEDED");
      }
      addBytes(2 + Math.max(0, candidate.length - 1));
      for (const key of Reflect.ownKeys(candidate)) {
        if (key === "length") continue;
        if (typeof key !== "string") {
          throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TYPE_UNSUPPORTED");
        }
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= candidate.length || String(index) !== key) {
          throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TYPE_UNSUPPORTED");
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TYPE_UNSUPPORTED");
        }
      }

      activeObjects.add(candidate);
      const normalizedItems: unknown[] = [];
      try {
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (descriptor === undefined || !("value" in descriptor)) {
            throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TYPE_UNSUPPORTED");
          }
          normalizedItems.push(inspect(descriptor.value, depth + 1));
        }
      } finally {
        activeObjects.delete(candidate);
      }
      return normalizedItems;
    }

    // Reuse the direct prototype captured before Date and array dispatch.
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TYPE_UNSUPPORTED");
    }
    addBytes(2);
    const ownKeys = Reflect.ownKeys(candidate);
    if (nodeCount + ownKeys.length > MAX_PERSISTED_PACKAGE_EVIDENCE_NODES) {
      throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_NODE_BOUND_EXCEEDED");
    }
    if (aggregateBudget.nodeCount + ownKeys.length > MAX_TOTAL_PERSISTED_PACKAGE_EVIDENCE_NODES) {
      throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TOTAL_NODE_BOUND_EXCEEDED");
    }
    activeObjects.add(candidate);
    const normalizedObject: Record<string, unknown> = Object.create(null);
    try {
      let propertyCount = 0;
      for (const key of ownKeys.sort((left, right) => compareText(String(left), String(right)))) {
        if (typeof key !== "string") {
          throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TYPE_UNSUPPORTED");
        }
        propertyCount += 1;
        addBytes(
          (propertyCount > 1 ? 1 : 0)
          + jsonStringByteLength(key)
          + 1,
        );
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_TYPE_UNSUPPORTED");
        }
        normalizedObject[key] = inspect(descriptor.value, depth + 1);
      }
    } finally {
      activeObjects.delete(candidate);
    }
    return normalizedObject;
  };

  let canonicalEvidence: string;
  let normalizedEvidence: unknown;
  try {
    normalizedEvidence = inspect(rawEvidence, 0);
    canonicalEvidence = canonicalJson(normalizedEvidence);
  } catch (error) {
    if (error instanceof PackageAllocationAuthorityReadinessError) throw error;
    throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_INSPECTION_FAILED");
  }
  if (Buffer.byteLength(canonicalEvidence, "utf8") > MAX_PERSISTED_PACKAGE_EVIDENCE_BYTES) {
    throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_BYTE_BOUND_EXCEEDED");
  }

  try {
    return {
      inputEvidenceHash: sha256(canonicalEvidence),
      normalizedEvidence: JSON.parse(canonicalEvidence) as unknown,
    };
  } catch {
    throw invalidPersistedEvidence(evidenceKey, "EVIDENCE_CANONICALIZATION_FAILED");
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

interface SanitizedInputIssue {
  readonly code: string;
  readonly path: readonly (string | number)[];
  readonly message: "Input field failed schema validation";
}

function sanitizedInputIssues(error: z.ZodError): readonly SanitizedInputIssue[] {
  return Object.freeze(error.issues.map((issue) => deepFreeze({
    code: issue.code,
    path: [...issue.path],
    message: "Input field failed schema validation" as const,
  })));
}

function unsafeReadinessInputEnvelope(): PackageAllocationAuthorityReadinessError {
  return new PackageAllocationAuthorityReadinessError(
    "INVALID_READINESS_INPUT",
    "Package-allocation authority readiness input envelope is not plain data",
    { inputErrorCode: "INPUT_ENVELOPE_UNSAFE" },
  );
}

function assertNonExecutableEnvelopeLeaf(candidate: unknown): void {
  if (
    (candidate !== null && typeof candidate === "object")
    || typeof candidate === "function"
  ) {
    throw unsafeReadinessInputEnvelope();
  }
}

function plainDataRecord(candidate: unknown): Readonly<Record<string, unknown>> | null {
  if (candidate === null || typeof candidate !== "object") return null;
  if (isProxy(candidate)) throw unsafeReadinessInputEnvelope();
  if (Array.isArray(candidate)) return null;
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) {
    throw unsafeReadinessInputEnvelope();
  }

  const values: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== "string") throw unsafeReadinessInputEnvelope();
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw unsafeReadinessInputEnvelope();
    }
    values[key] = descriptor.value;
  }
  return values;
}

function plainDataArray(
  candidate: unknown,
  maximumLength: number,
): readonly unknown[] | null {
  if (candidate === null || typeof candidate !== "object") return null;
  if (isProxy(candidate)) throw unsafeReadinessInputEnvelope();
  if (!Array.isArray(candidate)) return null;
  if (Object.getPrototypeOf(candidate) !== Array.prototype) throw unsafeReadinessInputEnvelope();
  if (candidate.length > maximumLength) throw unsafeReadinessInputEnvelope();

  for (const key of Reflect.ownKeys(candidate)) {
    if (key === "length") continue;
    if (typeof key !== "string") throw unsafeReadinessInputEnvelope();
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= candidate.length || String(index) !== key) {
      throw unsafeReadinessInputEnvelope();
    }
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw unsafeReadinessInputEnvelope();
    }
  }

  const values: unknown[] = [];
  for (let index = 0; index < candidate.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw unsafeReadinessInputEnvelope();
    }
    values.push(descriptor.value);
  }
  return values;
}

function assertSafeReadinessInputEnvelope(rawInput: unknown): void {
  const root = plainDataRecord(rawInput);
  if (root === null) return;

  for (const [key, value] of Object.entries(root)) {
    if (key !== "sourceFacts" && key !== "packages") {
      assertNonExecutableEnvelopeLeaf(value);
    }
  }

  const sourceFacts = plainDataArray(root.sourceFacts, MAX_SOURCE_LINES);
  if (sourceFacts !== null) {
    for (const source of sourceFacts) {
      const sourceRecord = plainDataRecord(source);
      if (sourceRecord !== null) {
        for (const value of Object.values(sourceRecord)) {
          assertNonExecutableEnvelopeLeaf(value);
        }
      }
    }
  }

  const packages = plainDataArray(root.packages, MAX_PACKAGES);
  if (packages !== null) {
    for (const packageInput of packages) {
      const packageRecord = plainDataRecord(packageInput);
      if (packageRecord !== null) {
        for (const [key, value] of Object.entries(packageRecord)) {
          if (key !== "persistedEvidence") {
            assertNonExecutableEnvelopeLeaf(value);
          }
        }
      }
    }
  }
}

function duplicateValue<T>(values: readonly T[]): T | null {
  const seen = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function addReview(
  reviews: Map<PackageAllocationAuthorityReadinessReviewCode, MutableReview>,
  code: PackageAllocationAuthorityReadinessReviewCode,
  evidenceKeys: readonly string[] = [],
  wmsShipmentItemIds: readonly number[] = [],
): void {
  const review = reviews.get(code) ?? {
    evidenceKeys: new Set<string>(),
    wmsShipmentItemIds: new Set<number>(),
  };
  for (const evidenceKey of evidenceKeys) review.evidenceKeys.add(evidenceKey);
  for (const wmsShipmentItemId of wmsShipmentItemIds) {
    review.wmsShipmentItemIds.add(wmsShipmentItemId);
  }
  reviews.set(code, review);
}

function normalizedReviews(
  reviews: ReadonlyMap<PackageAllocationAuthorityReadinessReviewCode, MutableReview>,
): readonly PackageAllocationAuthorityReadinessReviewV1[] {
  return Object.freeze([...reviews.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([code, review]) => deepFreeze({
      code,
      evidenceKeys: [...review.evidenceKeys].sort(compareText),
      wmsShipmentItemIds: [...review.wmsShipmentItemIds].sort((left, right) => left - right),
    })));
}

function sourceRegistrations(
  sourceFacts: readonly PackageAllocationSourceFacts[],
): readonly PackageAllocationSourceRegistrationV1[] {
  const duplicateSourceId = duplicateValue(
    sourceFacts.map((facts) => facts.sourceWmsShipmentItemId),
  );
  if (duplicateSourceId !== null) {
    throw new PackageAllocationAuthorityReadinessError(
      "DUPLICATE_SOURCE_IDENTITY",
      "Package-allocation readiness received a duplicate source identity",
      { sourceWmsShipmentItemId: duplicateSourceId },
    );
  }

  return Object.freeze(sourceFacts
    .slice()
    .sort((left, right) => left.sourceWmsShipmentItemId - right.sourceWmsShipmentItemId)
    .map((facts) => {
      try {
        return derivePackageAllocationSourceRegistration(facts);
      } catch (error) {
        const sourceError = error as Partial<PackageAllocationSourceIdentityError>;
        throw new PackageAllocationAuthorityReadinessError(
          "INVALID_READINESS_INPUT",
          "Package-allocation source evidence failed identity validation",
          {
            sourceWmsShipmentItemId: facts.sourceWmsShipmentItemId,
            sourceErrorCode: typeof sourceError.code === "string" ? sourceError.code : null,
          },
          error,
        );
      }
    }));
}

function assessPackage(
  evidenceKey: string,
  persistedEvidence: unknown,
  candidateSourceIds: ReadonlySet<number>,
  reviews: Map<PackageAllocationAuthorityReadinessReviewCode, MutableReview>,
  aggregateBudget: PersistedEvidenceInspectionBudget,
): PackageAllocationEvidenceAssessmentV1 {
  const reviewCodes = new Set<PackageAllocationAuthorityReadinessReviewCode>();
  const review = (
    code: PackageAllocationAuthorityReadinessReviewCode,
    wmsShipmentItemIds: readonly number[] = [],
  ): void => {
    reviewCodes.add(code);
    addReview(reviews, code, [evidenceKey], wmsShipmentItemIds);
  };

  const boundedEvidence = boundedPersistedEvidence(
    evidenceKey,
    persistedEvidence,
    aggregateBudget,
  );
  const normalizedEvidence = boundedEvidence.normalizedEvidence as PersistedDeclaredPackageEvidence;
  const adapted = adaptPersistedDeclaredPackageLifecycleEvidence(
    normalizedEvidence,
  );
  if (adapted.outcome === "rejected") {
    review("package_lifecycle_evidence_rejected");
    review("package_membership_policy_unresolved");
    review("allocation_role_policy_unresolved");
    return deepFreeze({
      evidenceKey,
      inputEvidenceHash: boundedEvidence.inputEvidenceHash,
      lifecycleStatus: "rejected",
      lifecycleRejectionReason: adapted.reason,
      evidenceCoverage: null,
      provider: null,
      providerPhysicalShipmentId: null,
      lifecycleEvidenceHash: null,
      authoritativeContents: [],
      candidateSourceStatus: "unavailable",
      outsideCandidateSourceIds: [],
      reviewCodes: [...reviewCodes].sort(compareText),
    });
  }

  const projected = projectPersistedDeclaredPackageLifecycleShadow(
    normalizedEvidence,
  );
  if (projected.outcome === "rejected") {
    review("package_lifecycle_evidence_rejected");
    review("package_membership_policy_unresolved");
    review("allocation_role_policy_unresolved");
    return deepFreeze({
      evidenceKey,
      inputEvidenceHash: boundedEvidence.inputEvidenceHash,
      lifecycleStatus: "rejected",
      lifecycleRejectionReason: projected.reason,
      evidenceCoverage: adapted.evidenceCoverage,
      provider: adapted.input.provider,
      providerPhysicalShipmentId: adapted.input.providerPhysicalShipmentId,
      lifecycleEvidenceHash: null,
      authoritativeContents: [],
      candidateSourceStatus: "unavailable",
      outsideCandidateSourceIds: [],
      reviewCodes: [...reviewCodes].sort(compareText),
    });
  }

  if (projected.evidenceCoverage === "historical_v1_incomplete") {
    review("historical_contents_incomplete");
  }
  const authoritativeContents = Object.freeze(
    (projected.projection.authoritativeContents ?? [])
      .map((line) => Object.freeze({ ...line }))
      .sort((left, right) => left.wmsShipmentItemId - right.wmsShipmentItemId),
  );
  if (projected.projection.authoritativeContents === null) {
    review("authoritative_contents_unavailable");
  }
  if (!projected.projection.currentAutomationAuthority) {
    review("package_lifecycle_review");
  }
  const outsideCandidateSourceIds = Object.freeze(authoritativeContents
    .filter((line) => !candidateSourceIds.has(line.wmsShipmentItemId))
    .map((line) => line.wmsShipmentItemId));
  if (outsideCandidateSourceIds.length > 0) {
    review("package_line_outside_candidate_sources", outsideCandidateSourceIds);
  }

  // Current evidence can establish exact package contents, but neither the
  // candidate source set nor a package role is authenticated by this pure
  // function. Those decisions remain review-only until a locked repository
  // adapter supplies their durable provenance.
  review("package_membership_policy_unresolved");
  review("allocation_role_policy_unresolved");

  return deepFreeze({
    evidenceKey,
    inputEvidenceHash: boundedEvidence.inputEvidenceHash,
    lifecycleStatus: "projected",
    lifecycleRejectionReason: null,
    evidenceCoverage: projected.evidenceCoverage,
    provider: projected.projection.provider,
    providerPhysicalShipmentId: projected.projection.providerPhysicalShipmentId,
    lifecycleEvidenceHash: projected.projection.evidenceHash,
    authoritativeContents,
    candidateSourceStatus: projected.projection.authoritativeContents === null
      ? "unavailable"
      : outsideCandidateSourceIds.length > 0
        ? "outside_candidate_sources"
        : "within_candidate_sources",
    outsideCandidateSourceIds,
    reviewCodes: [...reviewCodes].sort(compareText),
  });
}

/**
 * Classifies whether persisted package evidence is ready for a future locked
 * package-allocation authority resolver. This function never creates a group,
 * grants package membership, chooses an allocation role, authorizes inventory,
 * accepts an operator action, or emits a planner command.
 */
export function assessPackageAllocationAuthorityReadiness(
  rawInput: PackageAllocationAuthorityReadinessInput,
): PackageAllocationAuthorityReadinessResultV1 {
  assertSafeReadinessInputEnvelope(rawInput);
  const parsed = (() => {
    try {
      return packageAllocationAuthorityReadinessInputSchema.safeParse(rawInput);
    } catch {
      throw new PackageAllocationAuthorityReadinessError(
        "INVALID_READINESS_INPUT",
        "Package-allocation authority readiness input could not be inspected safely",
        { inputErrorCode: "INPUT_PARSING_FAILED" },
      );
    }
  })();
  if (!parsed.success) {
    throw new PackageAllocationAuthorityReadinessError(
      "INVALID_READINESS_INPUT",
      "Package-allocation authority readiness input failed validation",
      { issues: sanitizedInputIssues(parsed.error) },
    );
  }

  const duplicateEvidenceKey = duplicateValue(
    parsed.data.packages.map((pkg) => pkg.evidenceKey),
  );
  if (duplicateEvidenceKey !== null) {
    throw new PackageAllocationAuthorityReadinessError(
      "DUPLICATE_EVIDENCE_KEY",
      "Package-allocation readiness received a duplicate diagnostic evidence key",
      { evidenceKey: duplicateEvidenceKey },
    );
  }

  const registrations = sourceRegistrations(parsed.data.sourceFacts);
  const candidateSourceIds = new Set(
    registrations.map((registration) => registration.sourceWmsShipmentItemId),
  );
  const reviews = new Map<PackageAllocationAuthorityReadinessReviewCode, MutableReview>();
  addReview(
    reviews,
    "physical_consumption_authority_policy_unresolved",
    [],
    [...candidateSourceIds],
  );

  const aggregateBudget: PersistedEvidenceInspectionBudget = {
    byteCount: 0,
    nodeCount: 0,
  };
  const providerIdentities = new Set<string>();
  const packageAssessments = parsed.data.packages
    .slice()
    .sort((left, right) => compareText(left.evidenceKey, right.evidenceKey))
    .map((pkg) => {
      const assessment = assessPackage(
        pkg.evidenceKey,
        pkg.persistedEvidence,
        candidateSourceIds,
        reviews,
        aggregateBudget,
      );
      if (assessment.provider !== null && assessment.providerPhysicalShipmentId !== null) {
        const providerIdentity = canonicalJson([
          assessment.provider,
          assessment.providerPhysicalShipmentId,
        ]);
        if (providerIdentities.has(providerIdentity)) {
          throw new PackageAllocationAuthorityReadinessError(
            "DUPLICATE_PROVIDER_IDENTITY",
            "Package-allocation readiness received a duplicate provider package identity",
            {
              provider: assessment.provider,
              providerPhysicalShipmentId: assessment.providerPhysicalShipmentId,
            },
          );
        }
        providerIdentities.add(providerIdentity);
      }
      return assessment;
    });
  Object.freeze(packageAssessments);

  const normalized = normalizedReviews(reviews);
  const hashProjection = {
    contractVersion: 1 as const,
    sourceRegistrations: registrations,
    packageAssessments,
    reviews: normalized,
  };
  return deepFreeze({
    contractVersion: 1 as const,
    authority: "none" as const,
    outcome: "review" as const,
    assessmentHash: sha256(canonicalJson(hashProjection)),
    sourceRegistrations: registrations,
    packageAssessments,
    reviews: normalized,
    plannerInput: null,
  });
}
