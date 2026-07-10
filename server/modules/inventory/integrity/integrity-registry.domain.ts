import { createHash } from "node:crypto";

export type IntegrityFindingStatus = "open" | "acknowledged" | "resolved" | "accepted_exception";
export type IntegrityObservationKind =
  | "new"
  | "unchanged"
  | "changed"
  | "worsened"
  | "improved"
  | "recurred"
  | "resolved";

export interface ObservedIntegrityFinding {
  checkId: string;
  category: string;
  severity: "blocker" | "warning";
  entityFingerprint: string;
  entityKey: Record<string, unknown>;
  evidence: Record<string, unknown>;
  evidenceHash: string;
  metricValue: string;
}

export interface ExistingIntegrityFindingState {
  status: IntegrityFindingStatus;
  evidenceHash: string;
  metricValue: string;
}

function normalizeJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Integrity evidence contains non-finite number: ${value}`);
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item));
  if (typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeJsonValue((value as Record<string, unknown>)[key]);
    }
    return normalized;
  }
  throw new Error(`Integrity evidence contains unsupported value type: ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseMetric(value: string): bigint {
  if (!/^-?\d+$/.test(value)) throw new Error(`Integrity metric is not an integer: ${value}`);
  return BigInt(value);
}

export function createObservedIntegrityFinding(params: {
  checkId: string;
  category: string;
  severity: "blocker" | "warning";
  identityColumns: readonly string[];
  evidence: Record<string, unknown>;
  metricValue: bigint;
}): ObservedIntegrityFinding {
  if (params.identityColumns.length === 0) {
    throw new Error(`Integrity check ${params.checkId} has no identity columns`);
  }
  if (params.metricValue < BigInt(0)) {
    throw new Error(`Integrity check ${params.checkId} produced a negative magnitude`);
  }

  const entityKey: Record<string, unknown> = {};
  for (const column of params.identityColumns) {
    if (!Object.prototype.hasOwnProperty.call(params.evidence, column)) {
      throw new Error(`Integrity check ${params.checkId} did not return identity column ${column}`);
    }
    entityKey[column] = params.evidence[column];
  }

  const normalizedEntityKey = JSON.parse(canonicalJson(entityKey)) as Record<string, unknown>;
  const normalizedEvidence = JSON.parse(canonicalJson(params.evidence)) as Record<string, unknown>;
  return {
    checkId: params.checkId,
    category: params.category,
    severity: params.severity,
    entityFingerprint: sha256(canonicalJson({ checkId: params.checkId, entityKey: normalizedEntityKey })),
    entityKey: normalizedEntityKey,
    evidence: normalizedEvidence,
    evidenceHash: sha256(canonicalJson(normalizedEvidence)),
    metricValue: params.metricValue.toString(),
  };
}

export function classifyIntegrityObservation(
  existing: ExistingIntegrityFindingState | null,
  observed: Pick<ObservedIntegrityFinding, "evidenceHash" | "metricValue">,
): IntegrityObservationKind {
  if (existing === null) return "new";
  if (existing.status === "resolved") return "recurred";

  const previousMetric = parseMetric(existing.metricValue);
  const observedMetric = parseMetric(observed.metricValue);
  if (observedMetric > previousMetric) return "worsened";
  if (observedMetric < previousMetric) return "improved";
  if (observed.evidenceHash !== existing.evidenceHash) return "changed";
  return "unchanged";
}
