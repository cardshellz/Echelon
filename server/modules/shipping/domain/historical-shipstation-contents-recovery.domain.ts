import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";

import type { ShipStationShipmentContentsEvidenceStatus } from "./carrier-tracking.domain";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");
const MAX_PACKAGE_LINES = 500;
const MAX_SKU_LENGTH = 100;

export const HISTORICAL_SHIPSTATION_RECOVERY_EVIDENCE_CONTRACT_VERSION = 1 as const;
export const HISTORICAL_SHIPSTATION_CONTENTS_RECOVERY_EVENT_TYPE = "contents_recovered" as const;
export const HISTORICAL_SHIPSTATION_CONTENTS_RECOVERY_OBSERVATION_SOURCE =
  "historical_shipstation_contents_system_recovery" as const;
export const HISTORICAL_SHIPSTATION_CONTENTS_OPERATOR_RESOLUTION_SOURCE =
  "historical_shipstation_contents_operator_resolution" as const;

export const HISTORICAL_SHIPSTATION_CONTENTS_RECOVERY_STATUSES = Object.freeze([
  "provider_line_keys_authoritative",
  "exact_unique_wms_match",
  "provider_empty",
  "provider_evidence_unavailable",
  "wms_lineage_unavailable",
  "ambiguous_wms_match",
  "provider_wms_conflict",
] as const);

export type HistoricalShipStationContentsRecoveryStatus =
  typeof HISTORICAL_SHIPSTATION_CONTENTS_RECOVERY_STATUSES[number];

export interface HistoricalShipStationExpectedContentsLine {
  readonly wmsShipmentItemId: number;
  readonly sku: string;
  readonly quantity: number;
}

export type HistoricalShipStationExpectedContentsEvidence =
  | Readonly<{
      readonly kind: "available";
      readonly source: "physical_shipment" | "legacy_wms_shipment";
      readonly lines: readonly HistoricalShipStationExpectedContentsLine[];
    }>
  | Readonly<{
      readonly kind: "unavailable";
      readonly reason:
        | "no_linked_package"
        | "ambiguous_linked_package"
        | "linked_package_contents_unavailable";
    }>;

export type HistoricalShipStationContentsRecoveryErrorCode =
  | "INVALID_EXPECTED_CONTENTS_EVIDENCE"
  | "INVALID_PROVIDER_CONTENTS_EVIDENCE"
  | "INVALID_PROVIDER_SHIPMENT_ID";

export interface HistoricalShipStationRecoverableContentsLine {
  readonly wmsShipmentItemId: number;
  readonly quantity: number;
}

export interface HistoricalShipStationContentsRecoveryEvidence {
  readonly contractVersion: typeof HISTORICAL_SHIPSTATION_RECOVERY_EVIDENCE_CONTRACT_VERSION;
  readonly recoveryStatus:
    | "provider_line_keys_authoritative"
    | "exact_unique_wms_match"
    | "wms_confirmed_after_provider_conflict";
  readonly evidenceHash: string;
  readonly attestedContents: readonly HistoricalShipStationRecoverableContentsLine[];
}

export type HistoricalShipStationContentsAutomaticRecoveryEvidence = Readonly<
  Omit<HistoricalShipStationContentsRecoveryEvidence, "recoveryStatus"> & {
    readonly recoveryStatus: "provider_line_keys_authoritative" | "exact_unique_wms_match";
  }
>;

export type HistoricalShipStationContentsRecoveryLabelStatus =
  | "active"
  | "voided"
  | "superseded"
  | "unknown";

export interface HistoricalShipStationContentsSystemRecoveryPayload {
  readonly payloadSchemaVersion: 2;
  readonly providerLabelId: string;
  readonly trackingNumber: string;
  readonly observationSource:
    | typeof HISTORICAL_SHIPSTATION_CONTENTS_RECOVERY_OBSERVATION_SOURCE
    | typeof HISTORICAL_SHIPSTATION_CONTENTS_OPERATOR_RESOLUTION_SOURCE;
  readonly recoveryContractVersion:
    typeof HISTORICAL_SHIPSTATION_RECOVERY_EVIDENCE_CONTRACT_VERSION;
  readonly recoveryStatus: HistoricalShipStationContentsRecoveryEvidence["recoveryStatus"];
  readonly providerEvidenceHash: string;
  readonly recoveryEvidenceHash: string;
  readonly resolvedLabelEventIds: readonly number[];
  readonly actorUserId?: string;
  readonly actorRole?: "admin" | "lead";
  readonly reason?: string;
  readonly declaredContentsEvidence: Readonly<{
    readonly evidenceSchemaVersion: 1;
    readonly status: "authoritative";
    readonly lines: readonly Readonly<{
      readonly lineItemKey: string;
      readonly quantity: number;
    }>[];
  }>;
}

export interface HistoricalShipStationContentsSystemRecoveryEvent {
  readonly eventHash: string;
  readonly eventType: typeof HISTORICAL_SHIPSTATION_CONTENTS_RECOVERY_EVENT_TYPE;
  readonly labelStatus: HistoricalShipStationContentsRecoveryLabelStatus;
  readonly trackingNumber: string;
  readonly providerOccurredAt: null;
  readonly sanitizedPayload: HistoricalShipStationContentsSystemRecoveryPayload;
}

export class HistoricalShipStationContentsRecoveryError extends Error {
  constructor(
    readonly code: HistoricalShipStationContentsRecoveryErrorCode,
    message: string,
    readonly context: Readonly<Record<string, number>> = Object.freeze({}),
  ) {
    super(message);
    this.name = "HistoricalShipStationContentsRecoveryError";
  }
}

export interface HistoricalShipStationObservedContentsLine {
  readonly sku: string;
  readonly quantity: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
export function historicalShipStationRecoverableCaseEvidenceHash(input: Readonly<{
  readonly shippingProviderLabelId: string;
  readonly recoveryStatus: HistoricalShipStationContentsRecoveryEvidence["recoveryStatus"];
  readonly providerEvidenceHash: string;
}>): string {
  if (
    !/^[1-9][0-9]*$/.test(input.shippingProviderLabelId)
    || BigInt(input.shippingProviderLabelId) > POSTGRES_BIGINT_MAX
    || ![
      "provider_line_keys_authoritative",
      "exact_unique_wms_match",
      "wms_confirmed_after_provider_conflict",
    ].includes(
      input.recoveryStatus,
    )
    || !/^[0-9a-f]{64}$/.test(input.providerEvidenceHash)
  ) {
    throw new HistoricalShipStationContentsRecoveryError(
      "INVALID_PROVIDER_CONTENTS_EVIDENCE",
      "Recoverable-case evidence identity failed validation",
    );
  }
  return sha256(canonicalJson(Object.freeze({
    contract: "historical_shipstation_contents_recoverable_case_v1",
    contractVersion: HISTORICAL_SHIPSTATION_RECOVERY_EVIDENCE_CONTRACT_VERSION,
    shippingProviderLabelId: input.shippingProviderLabelId,
    recoveryStatus: input.recoveryStatus,
    providerEvidenceHash: input.providerEvidenceHash,
  })));
}

function validatedRecoveryContents(
  recoveryEvidence: HistoricalShipStationContentsRecoveryEvidence,
): readonly HistoricalShipStationRecoverableContentsLine[] {
  if (
    recoveryEvidence.contractVersion !== HISTORICAL_SHIPSTATION_RECOVERY_EVIDENCE_CONTRACT_VERSION
    || ![
      "provider_line_keys_authoritative",
      "exact_unique_wms_match",
      "wms_confirmed_after_provider_conflict",
    ].includes(
      recoveryEvidence.recoveryStatus,
    )
    || !/^[0-9a-f]{64}$/.test(recoveryEvidence.evidenceHash)
    || recoveryEvidence.attestedContents.length < 1
    || recoveryEvidence.attestedContents.length > MAX_PACKAGE_LINES
  ) {
    throw new HistoricalShipStationContentsRecoveryError(
      "INVALID_PROVIDER_CONTENTS_EVIDENCE",
      "System recovery evidence failed validation",
    );
  }
  const sourceIds = new Set<number>();
  const lines = recoveryEvidence.attestedContents.map((line) => {
    if (
      !isPositivePostgresInteger(line.wmsShipmentItemId)
      || !isPositivePostgresInteger(line.quantity)
      || sourceIds.has(line.wmsShipmentItemId)
    ) {
      throw new HistoricalShipStationContentsRecoveryError(
        "INVALID_PROVIDER_CONTENTS_EVIDENCE",
        "System recovery evidence contains an invalid or duplicate WMS source line",
      );
    }
    sourceIds.add(line.wmsShipmentItemId);
    return Object.freeze({
      wmsShipmentItemId: line.wmsShipmentItemId,
      quantity: line.quantity,
    });
  });
  lines.sort((left, right) => left.wmsShipmentItemId - right.wmsShipmentItemId);
  return Object.freeze(lines);
}

/**
 * Builds the exact immutable event appended by the automatic or operator
 * recovery application service. The event is deterministic across retries and contains no SKU,
 * product name, address, or raw provider payload.
 */
export function buildHistoricalShipStationContentsSystemRecoveryEvent(input: Readonly<{
  readonly shippingProviderLabelId: string;
  readonly providerShipmentId: number;
  readonly trackingNumber: string;
  readonly labelStatus: HistoricalShipStationContentsRecoveryLabelStatus;
  readonly recoveryEvidence: HistoricalShipStationContentsRecoveryEvidence;
  readonly resolvedLabelEventIds: readonly number[];
  readonly authorization?: Readonly<{
    readonly actorUserId: string;
    readonly actorRole: "admin" | "lead";
    readonly reason: string;
  }>;
}>): HistoricalShipStationContentsSystemRecoveryEvent {
  if (
    !/^[1-9][0-9]*$/.test(input.shippingProviderLabelId)
    || BigInt(input.shippingProviderLabelId) > POSTGRES_BIGINT_MAX
    || !Number.isSafeInteger(input.providerShipmentId)
    || input.providerShipmentId <= 0
    || typeof input.trackingNumber !== "string"
    || input.trackingNumber.length < 1
    || input.trackingNumber.length > 200
    || input.trackingNumber.trim() !== input.trackingNumber
    || !["active", "voided", "superseded", "unknown"].includes(input.labelStatus)
    || input.resolvedLabelEventIds.length < 1
    || input.resolvedLabelEventIds.length > MAX_PACKAGE_LINES
  ) {
    throw new HistoricalShipStationContentsRecoveryError(
      "INVALID_PROVIDER_CONTENTS_EVIDENCE",
      "System recovery event identity failed validation",
    );
  }
  const resolvedLabelEventIds = [...input.resolvedLabelEventIds];
  if (
    resolvedLabelEventIds.some((eventId) => !Number.isSafeInteger(eventId) || eventId <= 0)
    || new Set(resolvedLabelEventIds).size !== resolvedLabelEventIds.length
  ) {
    throw new HistoricalShipStationContentsRecoveryError(
      "INVALID_PROVIDER_CONTENTS_EVIDENCE",
      "System recovery event references invalid or duplicate label evidence",
    );
  }
  resolvedLabelEventIds.sort((left, right) => left - right);
  Object.freeze(resolvedLabelEventIds);
  const contents = validatedRecoveryContents(input.recoveryEvidence);
  const isOperatorResolution = input.recoveryEvidence.recoveryStatus
    === "wms_confirmed_after_provider_conflict";
  const authorization = input.authorization;
  if (
    isOperatorResolution !== (authorization !== undefined)
    || (authorization !== undefined && (
      typeof authorization.actorUserId !== "string"
      || authorization.actorUserId.length < 1
      || authorization.actorUserId.length > 190
      || authorization.actorUserId.trim() !== authorization.actorUserId
      || (authorization.actorRole !== "admin" && authorization.actorRole !== "lead")
      || typeof authorization.reason !== "string"
      || authorization.reason.length < 1
      || authorization.reason.length > 500
      || authorization.reason.trim() !== authorization.reason
    ))
  ) {
    throw new HistoricalShipStationContentsRecoveryError(
      "INVALID_PROVIDER_CONTENTS_EVIDENCE",
      "Operator recovery authorization failed validation",
    );
  }
  const recoveryEvidenceHash = historicalShipStationRecoverableCaseEvidenceHash({
    shippingProviderLabelId: input.shippingProviderLabelId,
    recoveryStatus: input.recoveryEvidence.recoveryStatus,
    providerEvidenceHash: input.recoveryEvidence.evidenceHash,
  });
  const lines = Object.freeze(contents.map((line) => Object.freeze({
    lineItemKey: `wms-item-${line.wmsShipmentItemId}`,
    quantity: line.quantity,
  })));
  const declaredContentsEvidence = Object.freeze({
    evidenceSchemaVersion: 1 as const,
    status: "authoritative" as const,
    lines,
  });
  const sanitizedPayload: HistoricalShipStationContentsSystemRecoveryPayload = Object.freeze({
    payloadSchemaVersion: 2 as const,
    providerLabelId: String(input.providerShipmentId),
    trackingNumber: input.trackingNumber,
    observationSource: isOperatorResolution
      ? HISTORICAL_SHIPSTATION_CONTENTS_OPERATOR_RESOLUTION_SOURCE
      : HISTORICAL_SHIPSTATION_CONTENTS_RECOVERY_OBSERVATION_SOURCE,
    recoveryContractVersion: HISTORICAL_SHIPSTATION_RECOVERY_EVIDENCE_CONTRACT_VERSION,
    recoveryStatus: input.recoveryEvidence.recoveryStatus,
    providerEvidenceHash: input.recoveryEvidence.evidenceHash,
    recoveryEvidenceHash,
    resolvedLabelEventIds,
    ...(authorization === undefined ? {} : {
      actorUserId: authorization.actorUserId,
      actorRole: authorization.actorRole,
      reason: authorization.reason,
    }),
    declaredContentsEvidence,
  });
  return Object.freeze({
    eventHash: sha256(canonicalJson({
      provider: "shipstation",
      ...sanitizedPayload,
      labelStatus: input.labelStatus,
    })),
    eventType: HISTORICAL_SHIPSTATION_CONTENTS_RECOVERY_EVENT_TYPE,
    labelStatus: input.labelStatus,
    trackingNumber: input.trackingNumber,
    providerOccurredAt: null,
    sanitizedPayload,
  });
}


function isPositivePostgresInteger(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) > 0
    && (value as number) <= POSTGRES_INTEGER_MAX;
}

function exactSku(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SKU_LENGTH) {
    return null;
  }
  return value.trim() === value ? value : null;
}

export function normalizedHistoricalShipStationProviderLines(
  rawItems: unknown,
): readonly HistoricalShipStationObservedContentsLine[] | null {
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_PACKAGE_LINES) {
    return null;
  }
  const lines: HistoricalShipStationObservedContentsLine[] = [];
  for (const rawItem of rawItems) {
    if (rawItem === null || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      return null;
    }
    const item = rawItem as Record<string, unknown>;
    const sku = exactSku(item.sku);
    if (sku === null || !isPositivePostgresInteger(item.quantity)) return null;
    lines.push(Object.freeze({ sku, quantity: item.quantity }));
  }
  return Object.freeze(lines);
}

function providerObservationFingerprint(rawItems: unknown): Readonly<Record<string, unknown>> {
  if (rawItems === undefined) return Object.freeze({ kind: "omitted" });
  if (!Array.isArray(rawItems)) {
    return Object.freeze({
      kind: "invalid_container",
      valueType: rawItems === null ? "null" : typeof rawItems,
    });
  }
  if (rawItems.length > MAX_PACKAGE_LINES) {
    return Object.freeze({ kind: "oversized", lineCount: rawItems.length });
  }
  const lines = rawItems.map((rawItem) => {
    if (rawItem === null || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      return Object.freeze({
        kind: "invalid_line",
        valueType: rawItem === null ? "null" : Array.isArray(rawItem) ? "array" : typeof rawItem,
      });
    }
    const item = rawItem as Record<string, unknown>;
    const lineItemKey = typeof item.lineItemKey === "string"
      && item.lineItemKey.length > 0
      && item.lineItemKey.length <= 200
      && item.lineItemKey.trim() === item.lineItemKey
      ? item.lineItemKey
      : null;
    return Object.freeze({
      kind: "line",
      lineItemKey,
      sku: exactSku(item.sku),
      quantity: typeof item.quantity === "number" && Number.isFinite(item.quantity)
        ? String(item.quantity)
        : null,
    });
  });
  lines.sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
  return Object.freeze({ kind: "items", lines: Object.freeze(lines) });
}

export function historicalShipStationProviderObservationHash(input: Readonly<{
  readonly providerShipmentId: number;
  readonly providerStatus: ShipStationShipmentContentsEvidenceStatus;
  readonly rawProviderItems: unknown;
  readonly expectedContents: HistoricalShipStationExpectedContentsEvidence;
}>): string {
  if (!Number.isSafeInteger(input.providerShipmentId) || input.providerShipmentId <= 0) {
    throw new HistoricalShipStationContentsRecoveryError(
      "INVALID_PROVIDER_SHIPMENT_ID",
      "Provider shipment identity must be a positive safe integer",
    );
  }
  return sha256(canonicalJson(Object.freeze({
    contract: "historical_shipstation_contents_provider_observation_v1",
    provider: "shipstation",
    providerShipmentId: input.providerShipmentId,
    providerStatus: input.providerStatus,
    providerObservation: providerObservationFingerprint(input.rawProviderItems),
    expectedContents: normalizedExpectedContents(input.expectedContents),
  })));
}

export function buildHistoricalShipStationWmsConfirmationEvidence(input: Readonly<{
  readonly providerObservationHash: string;
  readonly expectedContents: HistoricalShipStationExpectedContentsEvidence;
}>): HistoricalShipStationContentsRecoveryEvidence {
  if (!/^[0-9a-f]{64}$/.test(input.providerObservationHash)) {
    throw new HistoricalShipStationContentsRecoveryError(
      "INVALID_PROVIDER_CONTENTS_EVIDENCE",
      "Provider observation hash failed validation",
    );
  }
  const expected = normalizedExpectedContents(input.expectedContents);
  if (expected.kind !== "available" || expected.lines.length === 0) {
    throw new HistoricalShipStationContentsRecoveryError(
      "INVALID_EXPECTED_CONTENTS_EVIDENCE",
      "WMS confirmation requires one linked package with exact contents",
    );
  }
  return Object.freeze({
    contractVersion: HISTORICAL_SHIPSTATION_RECOVERY_EVIDENCE_CONTRACT_VERSION,
    recoveryStatus: "wms_confirmed_after_provider_conflict",
    evidenceHash: input.providerObservationHash,
    attestedContents: Object.freeze(expected.lines.map((line) => Object.freeze({
      wmsShipmentItemId: line.wmsShipmentItemId,
      quantity: line.quantity,
    }))),
  });
}

function authoritativeProviderLines(
  rawItems: unknown,
): readonly HistoricalShipStationRecoverableContentsLine[] {
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_PACKAGE_LINES) {
    throw new HistoricalShipStationContentsRecoveryError(
      "INVALID_PROVIDER_CONTENTS_EVIDENCE",
      "Authoritative provider contents are missing or exceed the recovery safety bound",
    );
  }
  const sourceIds = new Set<number>();
  const lines = rawItems.map((rawItem) => {
    if (rawItem === null || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      throw new HistoricalShipStationContentsRecoveryError(
        "INVALID_PROVIDER_CONTENTS_EVIDENCE",
        "Authoritative provider contents contain a malformed line",
      );
    }
    const item = rawItem as Record<string, unknown>;
    const match = typeof item.lineItemKey === "string"
      ? /^wms-item-([1-9][0-9]*)$/.exec(item.lineItemKey)
      : null;
    const wmsShipmentItemId = match === null ? Number.NaN : Number(match[1]);
    if (
      !isPositivePostgresInteger(wmsShipmentItemId)
      || !isPositivePostgresInteger(item.quantity)
      || sourceIds.has(wmsShipmentItemId)
    ) {
      throw new HistoricalShipStationContentsRecoveryError(
        "INVALID_PROVIDER_CONTENTS_EVIDENCE",
        "Authoritative provider contents contain an invalid or duplicate WMS source line",
      );
    }
    sourceIds.add(wmsShipmentItemId);
    return Object.freeze({
      wmsShipmentItemId,
      quantity: item.quantity,
    });
  });
  lines.sort((left, right) => left.wmsShipmentItemId - right.wmsShipmentItemId);
  return Object.freeze(lines);
}

function validatedExpectedLines(
  evidence: Extract<HistoricalShipStationExpectedContentsEvidence, { kind: "available" }>,
): readonly HistoricalShipStationExpectedContentsLine[] {
  if (evidence.lines.length > MAX_PACKAGE_LINES) {
    throw new HistoricalShipStationContentsRecoveryError(
      "INVALID_EXPECTED_CONTENTS_EVIDENCE",
      "Linked WMS package contents exceed the recovery safety bound",
      { observedLineCount: evidence.lines.length, maxLineCount: MAX_PACKAGE_LINES },
    );
  }
  const sourceIds = new Set<number>();
  const lines = evidence.lines.map((line) => {
    const sku = exactSku(line.sku);
    if (
      !isPositivePostgresInteger(line.wmsShipmentItemId)
      || !isPositivePostgresInteger(line.quantity)
      || sku === null
      || sourceIds.has(line.wmsShipmentItemId)
    ) {
      throw new HistoricalShipStationContentsRecoveryError(
        "INVALID_EXPECTED_CONTENTS_EVIDENCE",
        "Linked WMS package contents contain an invalid or duplicate source line",
      );
    }
    sourceIds.add(line.wmsShipmentItemId);
    return Object.freeze({
      wmsShipmentItemId: line.wmsShipmentItemId,
      sku,
      quantity: line.quantity,
    });
  });
  return Object.freeze(lines);
}

function normalizedExpectedContents(
  evidence: HistoricalShipStationExpectedContentsEvidence,
): HistoricalShipStationExpectedContentsEvidence {
  if (evidence.kind === "unavailable") {
    return Object.freeze({ kind: evidence.kind, reason: evidence.reason });
  }
  const lines = [...validatedExpectedLines(evidence)]
    .sort((left, right) => left.wmsShipmentItemId - right.wmsShipmentItemId);
  if (lines.length === 0) {
    throw new HistoricalShipStationContentsRecoveryError(
      "INVALID_EXPECTED_CONTENTS_EVIDENCE",
      "Linked WMS package contents cannot be empty when marked available",
    );
  }
  return Object.freeze({
    kind: evidence.kind,
    source: evidence.source,
    lines: Object.freeze(lines),
  });
}

function occurrenceCounts(
  lines: readonly Readonly<{ sku: string; quantity: number }>[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = canonicalJson([line.sku, line.quantity]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function sameCounts(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, count] of left) {
    if (right.get(key) !== count) return false;
  }
  return true;
}

/**
 * Determines whether a historical provider response with missing WMS line keys
 * can be mapped one-to-one to an already-linked WMS package. This function does
 * not persist evidence or grant automation authority.
 */
export function classifyHistoricalShipStationContentsRecovery(input: Readonly<{
  readonly providerStatus: ShipStationShipmentContentsEvidenceStatus;
  readonly rawProviderItems: unknown;
  readonly expectedContents: HistoricalShipStationExpectedContentsEvidence;
}>): HistoricalShipStationContentsRecoveryStatus {
  if (input.providerStatus === "authoritative") {
    return "provider_line_keys_authoritative";
  }
  if (input.providerStatus === "empty") return "provider_empty";
  if (input.providerStatus !== "unrecognized") return "provider_evidence_unavailable";

  const provider = normalizedHistoricalShipStationProviderLines(input.rawProviderItems);
  if (provider === null) return "provider_evidence_unavailable";
  if (input.expectedContents.kind === "unavailable") return "wms_lineage_unavailable";

  const expected = validatedExpectedLines(input.expectedContents);
  if (expected.length === 0) return "provider_wms_conflict";
  const providerCounts = occurrenceCounts(provider);
  const expectedCounts = occurrenceCounts(expected);
  if (!sameCounts(providerCounts, expectedCounts)) return "provider_wms_conflict";
  if (
    [...providerCounts.values()].some((count) => count > 1)
    || [...expectedCounts.values()].some((count) => count > 1)
  ) {
    return "ambiguous_wms_match";
  }
  return "exact_unique_wms_match";
}

/**
 * Produces a deterministic, non-sensitive commitment to a recoverable provider
 * observation. The returned lines are the exact WMS identities and quantities
 * that the system-recovery application service may persist only after reloading
 * and locking the same candidate. This pure function does not persist evidence
 * or grant runtime effect authority.
 */
export function buildHistoricalShipStationContentsRecoveryEvidence(input: Readonly<{
  readonly providerShipmentId: number;
  readonly providerStatus: ShipStationShipmentContentsEvidenceStatus;
  readonly rawProviderItems: unknown;
  readonly expectedContents: HistoricalShipStationExpectedContentsEvidence;
}>): HistoricalShipStationContentsAutomaticRecoveryEvidence | null {
  if (!Number.isSafeInteger(input.providerShipmentId) || input.providerShipmentId <= 0) {
    throw new HistoricalShipStationContentsRecoveryError(
      "INVALID_PROVIDER_SHIPMENT_ID",
      "Provider shipment identity must be a positive safe integer",
    );
  }
  const recoveryStatus = classifyHistoricalShipStationContentsRecovery(input);
  if (
    recoveryStatus !== "provider_line_keys_authoritative"
    && recoveryStatus !== "exact_unique_wms_match"
  ) {
    return null;
  }

  const expectedContents = normalizedExpectedContents(input.expectedContents);
  let providerEvidence: Readonly<Record<string, unknown>>;
  let attestedContents: readonly HistoricalShipStationRecoverableContentsLine[];
  if (recoveryStatus === "provider_line_keys_authoritative") {
    attestedContents = authoritativeProviderLines(input.rawProviderItems);
    providerEvidence = Object.freeze({
      kind: "provider_wms_line_keys",
      lines: attestedContents,
    });
  } else {
    if (expectedContents.kind !== "available") {
      throw new HistoricalShipStationContentsRecoveryError(
        "INVALID_EXPECTED_CONTENTS_EVIDENCE",
        "Exact WMS recovery requires available linked package contents",
      );
    }
    const provider = normalizedHistoricalShipStationProviderLines(input.rawProviderItems);
    if (provider === null) {
      throw new HistoricalShipStationContentsRecoveryError(
        "INVALID_PROVIDER_CONTENTS_EVIDENCE",
        "Exact WMS recovery requires bounded provider SKU and quantity evidence",
      );
    }
    const providerLinesForHash = [...provider]
      .sort((left, right) => compareText(left.sku, right.sku) || left.quantity - right.quantity);
    providerEvidence = Object.freeze({
      kind: "provider_sku_quantity_multiset",
      lines: Object.freeze(providerLinesForHash),
    });
    attestedContents = Object.freeze(expectedContents.lines.map((line) => Object.freeze({
      wmsShipmentItemId: line.wmsShipmentItemId,
      quantity: line.quantity,
    })));
  }

  const hashProjection = Object.freeze({
    contract: "historical_shipstation_contents_recovery_evidence_v1",
    contractVersion: HISTORICAL_SHIPSTATION_RECOVERY_EVIDENCE_CONTRACT_VERSION,
    provider: "shipstation",
    providerShipmentId: input.providerShipmentId,
    recoveryStatus,
    providerEvidence,
    expectedContents,
    attestedContents,
  });
  return Object.freeze({
    contractVersion: HISTORICAL_SHIPSTATION_RECOVERY_EVIDENCE_CONTRACT_VERSION,
    recoveryStatus,
    evidenceHash: sha256(canonicalJson(hashProjection)),
    attestedContents,
  });
}
