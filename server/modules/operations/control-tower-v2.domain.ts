import { createHash } from "node:crypto";

export const CONTROL_TOWER_DOMAINS = [
  "oms",
  "wms",
  "shipping",
  "inventory",
  "procurement",
] as const;

export const CONTROL_TOWER_SEVERITIES = ["blocker", "high", "medium", "low"] as const;
export const CONTROL_TOWER_URGENCIES = ["overdue", "due_soon", "normal", "deferred"] as const;
export const CONTROL_TOWER_TRIAGE_STATUSES = [
  "needs_attention",
  "in_progress",
  "waiting",
  "resolved",
] as const;
export const CONTROL_TOWER_VIEWS = ["attention", "in_progress", "waiting", "resolved"] as const;

export type ControlTowerDomain = (typeof CONTROL_TOWER_DOMAINS)[number];
export type ControlTowerSeverity = (typeof CONTROL_TOWER_SEVERITIES)[number];
export type ControlTowerUrgency = (typeof CONTROL_TOWER_URGENCIES)[number];
export type ControlTowerTriageStatus = (typeof CONTROL_TOWER_TRIAGE_STATUSES)[number];
export type ControlTowerView = (typeof CONTROL_TOWER_VIEWS)[number];
export type ControlTowerSourceStatus = "open" | "acknowledged" | "resolved" | "ignored";
export type ControlTowerActionability = "investigate" | "monitor" | "automated" | "none";

export interface ControlTowerNavigationAction {
  code: string;
  kind: "navigate";
  label: string;
  href: string;
}

export interface ProjectedControlTowerWorkItem {
  sourceNamespace: string;
  sourceType: string;
  sourceKey: string;
  sourceFingerprint: string;
  projectionVersion: number;
  domain: ControlTowerDomain;
  code: string;
  entityType: string;
  entityId: string;
  entityRef: string | null;
  correlationId: string | null;
  rootCauseGroupKey: string | null;
  title: string;
  summary: string;
  expectedState: string;
  actualState: string;
  severity: ControlTowerSeverity;
  urgency: ControlTowerUrgency;
  impactTags: string[];
  actionability: ControlTowerActionability;
  sourceStatus: Exclude<ControlTowerSourceStatus, "resolved" | "ignored">;
  ownerTeam: string | null;
  recommendedAction: string;
  responseDueAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  occurrenceCount: number;
  recurrenceCount: number;
  worsenedCount: number;
  evidenceSummary: Record<string, unknown>;
  detailLocator: Record<string, unknown>;
  availableActions: ControlTowerNavigationAction[];
  sourceUpdatedAt: string;
  observedMetric: string | null;
}

export interface ControlTowerSourceAdapter<Row = Record<string, unknown>> {
  name: string;
  sourceNamespace: string;
  sourceType: string;
  projectionVersion: number;
  loadRows: (client: QueryClient, now: Date) => Promise<Row[]>;
  projectRow: (row: Row, now: Date) => ProjectedControlTowerWorkItem;
}

export interface QueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number | null;
}

export interface QueryClient {
  query: <Row = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<QueryResult<Row>>;
}

export interface ProjectionPreview {
  sourceName: string;
  sourceNamespace: string;
  sourceType: string;
  projectionVersion: number;
  rowsScanned: number;
  rowsValid: number;
  rowsFailed: number;
  completeScan: boolean;
  sourceWatermark: string | null;
  items: ProjectedControlTowerWorkItem[];
  errors: Array<{ sourceKey: string | null; message: string }>;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function controlTowerFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function humanizeControlTowerCode(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function boundedString(value: unknown, field: string, maxLength: number): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return normalized;
}

export function nullableBoundedString(value: unknown, field: string, maxLength: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return boundedString(value, field, maxLength);
}

export function nonNegativeInteger(value: unknown, field: string, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative integer`);
  return parsed;
}

export function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

export function isoTimestamp(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return date.toISOString();
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function compactEvidence(value: unknown, depth = 0): unknown {
  if (depth >= 4) return "[truncated]";
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 497)}...` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => compactEvidence(entry, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([key, nested]) => [key, compactEvidence(nested, depth + 1)]),
    );
  }
  return value;
}

export function validateProjectedWorkItem(
  item: ProjectedControlTowerWorkItem,
  adapter: Pick<ControlTowerSourceAdapter, "sourceNamespace" | "sourceType" | "projectionVersion">,
): ProjectedControlTowerWorkItem {
  if (item.sourceNamespace !== adapter.sourceNamespace) {
    throw new Error(`sourceNamespace must be ${adapter.sourceNamespace}`);
  }
  if (item.sourceType !== adapter.sourceType) {
    throw new Error(`sourceType must be ${adapter.sourceType}`);
  }
  if (item.projectionVersion !== adapter.projectionVersion) {
    throw new Error(`projectionVersion must be ${adapter.projectionVersion}`);
  }
  boundedString(item.sourceKey, "sourceKey", 200);
  if (!/^[0-9a-f]{64}$/.test(item.sourceFingerprint)) {
    throw new Error("sourceFingerprint must be a lowercase SHA-256 digest");
  }
  if (!CONTROL_TOWER_DOMAINS.includes(item.domain)) throw new Error(`Unsupported domain ${item.domain}`);
  if (!CONTROL_TOWER_SEVERITIES.includes(item.severity)) throw new Error(`Unsupported severity ${item.severity}`);
  if (!CONTROL_TOWER_URGENCIES.includes(item.urgency)) throw new Error(`Unsupported urgency ${item.urgency}`);
  boundedString(item.code, "code", 100);
  boundedString(item.entityType, "entityType", 50);
  boundedString(item.entityId, "entityId", 200);
  boundedString(item.title, "title", 200);
  boundedString(item.summary, "summary", 10_000);
  boundedString(item.expectedState, "expectedState", 10_000);
  boundedString(item.actualState, "actualState", 10_000);
  boundedString(item.recommendedAction, "recommendedAction", 10_000);
  isoTimestamp(item.firstSeenAt, "firstSeenAt");
  isoTimestamp(item.lastSeenAt, "lastSeenAt");
  isoTimestamp(item.lastChangedAt, "lastChangedAt");
  isoTimestamp(item.sourceUpdatedAt, "sourceUpdatedAt");
  nonNegativeInteger(item.occurrenceCount, "occurrenceCount");
  if (item.occurrenceCount < 1) throw new Error("occurrenceCount must be positive");
  nonNegativeInteger(item.recurrenceCount, "recurrenceCount");
  nonNegativeInteger(item.worsenedCount, "worsenedCount");
  if (!Array.isArray(item.impactTags) || item.impactTags.some((tag) => !tag || tag.length > 30)) {
    throw new Error("impactTags must contain non-empty strings no longer than 30 characters");
  }
  return item;
}

function sourceKeyFromUnknownRow(row: unknown): string | null {
  const record = asRecord(row);
  for (const key of ["id", "source_key", "sourceKey", "entity_fingerprint", "payload_hash"]) {
    const value = record[key];
    if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
  }
  return null;
}

export function projectSourceRows<Row>(params: {
  adapter: ControlTowerSourceAdapter<Row>;
  rows: Row[];
  now: Date;
}): ProjectionPreview {
  const items: ProjectedControlTowerWorkItem[] = [];
  const errors: ProjectionPreview["errors"] = [];
  const identities = new Set<string>();
  let sourceWatermark: string | null = null;

  for (const row of params.rows) {
    try {
      const item = validateProjectedWorkItem(params.adapter.projectRow(row, params.now), params.adapter);
      const identity = `${item.sourceNamespace}\u0000${item.sourceType}\u0000${item.sourceKey}`;
      if (identities.has(identity)) throw new Error(`duplicate projected source identity ${item.sourceKey}`);
      identities.add(identity);
      items.push(item);
      if (sourceWatermark === null || item.sourceUpdatedAt > sourceWatermark) {
        sourceWatermark = item.sourceUpdatedAt;
      }
    } catch (error) {
      errors.push({
        sourceKey: sourceKeyFromUnknownRow(row),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    sourceName: params.adapter.name,
    sourceNamespace: params.adapter.sourceNamespace,
    sourceType: params.adapter.sourceType,
    projectionVersion: params.adapter.projectionVersion,
    rowsScanned: params.rows.length,
    rowsValid: items.length,
    rowsFailed: errors.length,
    completeScan: errors.length === 0,
    sourceWatermark,
    items,
    errors,
  };
}
