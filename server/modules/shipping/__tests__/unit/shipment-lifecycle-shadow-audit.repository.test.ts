import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  SHIPMENT_LIFECYCLE_SHADOW_AUDIT_LIMITS,
  SHIPMENT_LIFECYCLE_SHADOW_CURRENT_MATCHES_SQL,
  SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL,
  SHIPMENT_LIFECYCLE_SHADOW_LABEL_EVENTS_SQL,
  SHIPMENT_LIFECYCLE_SHADOW_REQUIRED_RELATIONS,
  SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL,
  ShipmentLifecycleShadowAuditRepositoryError,
  loadShipmentLifecycleShadowAuditBatch,
  normalizeShipmentLifecycleShadowAuditRepositoryOptions,
} from "../../shipment-lifecycle-shadow-audit.repository";

function readNormalizedSource(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8").replace(/\r\n/g, "\n");
}

const shadowScanIndexMigration = readNormalizedSource(
  "migrations",
  "197_shipment_lifecycle_shadow_scan_index.sql",
);
const fulfillmentSchema = readNormalizedSource("shared", "schema", "fulfillment.schema.ts");
const SNAPSHOT_AT = "2026-08-21T12:00:00.000Z";

function roleRow(overrides: Record<string, unknown> = {}) {
  return {
    transaction_read_only: "on",
    missing_required_select_count: "0",
    required_rls_count: "0",
    missing_required_schema_usage_count: "0",
    mutable_table_count: "0",
    mutable_column_relation_count: "0",
    mutable_sequence_count: "0",
    sequence_usage_count: "0",
    mutable_schema_count: "0",
    mutable_database: false,
    database_temporary_privilege: true,
    other_role_membership_count: "0",
    elevated_role: false,
    ...overrides,
  };
}

function labelRow(overrides: Record<string, unknown> = {}) {
  return {
    shipping_provider_label_id: "10",
    provider: "shipstation",
    provider_label_id: "provider-shipment-10",
    tracking_number: "TRACKING-10",
    label_status: "active",
    label_direction: "outbound",
    first_observed_at: "2026-08-20T12:00:00.000Z",
    last_observed_at: "2026-08-21T11:00:00.000Z",
    label_event_count: "2",
    label_event_payload_bytes: "512",
    max_event_payload_bytes: "300",
    ...overrides,
  };
}

function labelEventRow(id: number, overrides: Record<string, unknown> = {}) {
  return {
    label_event_id: String(id),
    shipping_provider_label_id: "10",
    event_hash: String(id).repeat(64).slice(0, 64),
    event_type: "label_observed",
    label_status: "active",
    tracking_number: "TRACKING-10",
    provider_occurred_at: null,
    received_at: `2026-08-21T10:00:0${id}.000Z`,
    sanitized_payload: {
      payloadSchemaVersion: 2,
      providerLabelId: "provider-shipment-10",
      trackingNumber: "TRACKING-10",
      declaredContentsEvidence: {
        evidenceSchemaVersion: 1,
        status: "authoritative",
        providerItemCount: 1,
        recognizedProviderItemCount: 1,
        canonicalLineCount: 1,
        malformedItemCount: 0,
        unrecognizedItemCount: 0,
        duplicateLineItemCount: 0,
        rejectedItemCount: 0,
        reviewRequired: false,
        lines: [{ lineItemKey: "wms-item-20", quantity: 1 }],
      },
    },
    ...overrides,
  };
}

function currentMatchRow(overrides: Record<string, unknown> = {}) {
  return {
    match_attempt_id: "30",
    shipping_provider_label_id: "10",
    carrier_tracking_event_id: "40",
    match_status: "matched",
    dispatch_evidence: "confirmed",
    event_occurred_at: "2026-08-21T11:30:00.000Z",
    received_at: "2026-08-21T11:31:00.000Z",
    ...overrides,
  };
}

function repositoryHarness(options: {
  role?: Record<string, unknown>;
  labels?: Record<string, unknown>[];
  events?: Record<string, unknown>[];
  matches?: Record<string, unknown>[];
  failSql?: string;
  failRollback?: boolean;
} = {}) {
  const calls: Array<{ text: string; parameters: unknown[] | undefined }> = [];
  const query = vi.fn(async (text: string, parameters?: unknown[]) => {
    calls.push({ text, parameters });
    if (text === "ROLLBACK" && options.failRollback) throw new Error("rollback failed");
    if (options.failSql && text === options.failSql) throw new Error("query failed");
    if (text === SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL) {
      return { rows: [options.role ?? roleRow()] };
    }
    if (text.includes("transaction_timestamp()")) {
      return { rows: [{ snapshot_at: SNAPSHOT_AT }] };
    }
    if (text === SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL) {
      return { rows: options.labels ?? [labelRow()] };
    }
    if (text === SHIPMENT_LIFECYCLE_SHADOW_LABEL_EVENTS_SQL) {
      return { rows: options.events ?? [labelEventRow(1), labelEventRow(2)] };
    }
    if (text === SHIPMENT_LIFECYCLE_SHADOW_CURRENT_MATCHES_SQL) {
      return { rows: options.matches ?? [currentMatchRow()] };
    }
    return { rows: [] };
  });
  return { calls, client: { query } };
}

function calledSql(
  calls: Array<{ text: string }>,
  sql: string,
): boolean {
  return calls.some(({ text }) => text === sql);
}

describe("shipment lifecycle read-only shadow repository", () => {
  it("uses one repeatable-read read-only transaction and rolls back complete bounded evidence", async () => {
    const harness = repositoryHarness();

    const batch = await loadShipmentLifecycleShadowAuditBatch(harness.client as any, {
      labelLimit: 25,
      maxEventsPerLabel: 10,
      maxPageEvents: 10,
      maxCurrentMatches: 10,
      maxEventPayloadBytes: 1_000,
      maxPagePayloadBytes: 2_000,
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 500,
      idleInTransactionTimeoutMs: 7_500,
    });

    expect(batch).toMatchObject({
      snapshotAt: SNAPSHOT_AT,
      labelLimit: 25,
      batchLimitReached: false,
      nextCursor: null,
      selectedEventPayloadBytes: 512,
      maxEventPayloadBytes: 300,
      databaseTemporaryPrivilege: true,
    });
    expect(batch.labels).toHaveLength(1);
    expect(batch.labelEvents).toHaveLength(2);
    expect(batch.currentCarrierMatches).toHaveLength(1);
    expect(batch.labelEvents[0].sanitizedPayload).toMatchObject({ payloadSchemaVersion: 2 });

    expect(harness.calls[0].text)
      .toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(harness.calls[1]).toEqual(expect.objectContaining({ parameters: ["5000ms"] }));
    expect(harness.calls[2]).toEqual(expect.objectContaining({ parameters: ["500ms"] }));
    expect(harness.calls[3]).toEqual(expect.objectContaining({ parameters: ["7500ms"] }));
    const roleCheckIndex = harness.calls.findIndex(
      ({ text }) => text === SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL,
    );
    const firstEvidenceIndex = harness.calls.findIndex(
      ({ text }) => text === SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL,
    );
    expect(roleCheckIndex).toBeGreaterThan(0);
    expect(roleCheckIndex).toBeLessThan(firstEvidenceIndex);
    expect(harness.calls[firstEvidenceIndex].parameters).toEqual([26, null]);
    expect(harness.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(harness.calls.some(({ text }) => text === "COMMIT")).toBe(false);
  });

  it("rejects missing exact SELECT before reading label evidence and rolls back", async () => {
    const harness = repositoryHarness({
      role: roleRow({ missing_required_select_count: "1" }),
    });

    await expect(loadShipmentLifecycleShadowAuditBatch(harness.client as any))
      .rejects.toMatchObject({ code: "REQUIRED_SELECT_PRIVILEGE_MISSING" });
    expect(calledSql(harness.calls, SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL)).toBe(false);
    expect(harness.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rejects missing required schema USAGE before reading label evidence", async () => {
    const harness = repositoryHarness({
      role: roleRow({ missing_required_schema_usage_count: "1" }),
    });

    await expect(loadShipmentLifecycleShadowAuditBatch(harness.client as any))
      .rejects.toMatchObject({ code: "REQUIRED_SCHEMA_USAGE_PRIVILEGE_MISSING" });
    expect(calledSql(harness.calls, SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL)).toBe(false);
    expect(harness.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rejects required relations protected by unproven row-level security", async () => {
    const harness = repositoryHarness({ role: roleRow({ required_rls_count: "1" }) });

    await expect(loadShipmentLifecycleShadowAuditBatch(harness.client as any))
      .rejects.toMatchObject({ code: "REQUIRED_RELATION_RLS_UNPROVEN" });
    expect(calledSql(harness.calls, SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL)).toBe(false);
    expect(harness.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rejects a mutable role before reading label evidence and still rolls back", async () => {
    const harness = repositoryHarness({ role: roleRow({ mutable_table_count: "1" }) });

    await expect(loadShipmentLifecycleShadowAuditBatch(harness.client as any))
      .rejects.toMatchObject({ code: "READ_ONLY_ROLE_REQUIRED" });
    expect(calledSql(harness.calls, SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL)).toBe(false);
    expect(harness.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rejects column-level write authority before reading label evidence", async () => {
    const harness = repositoryHarness({
      role: roleRow({ mutable_column_relation_count: "1" }),
    });

    await expect(loadShipmentLifecycleShadowAuditBatch(harness.client as any))
      .rejects.toMatchObject({ code: "READ_ONLY_ROLE_REQUIRED" });
    expect(calledSql(harness.calls, SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL)).toBe(false);
  });

  it("rejects every membership in another role before reading operational evidence", async () => {
    expect(SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL)
      .toContain("FROM pg_catalog.pg_roles AS candidate_role");
    expect(SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL)
      .toContain("candidate_role.rolname <> current_user");
    expect(SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL)
      .toContain("pg_catalog.pg_has_role(candidate_role.oid, 'MEMBER')");
    expect(SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL)
      .toContain("AS other_role_membership_count");

    const harness = repositoryHarness({
      role: roleRow({ other_role_membership_count: "1" }),
    });

    await expect(loadShipmentLifecycleShadowAuditBatch(harness.client as any))
      .rejects.toMatchObject({ code: "READ_ONLY_ROLE_REQUIRED" });
    expect(calledSql(harness.calls, SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL)).toBe(false);
    expect(harness.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("observes database TEMP privilege without misrepresenting it as persistent DML authority", async () => {
    const harness = repositoryHarness({ labels: [], matches: [] });
    const batch = await loadShipmentLifecycleShadowAuditBatch(harness.client as any);
    expect(batch.databaseTemporaryPrivilege).toBe(true);
  });

  it("rolls back when evidence loading fails", async () => {
    const harness = repositoryHarness({ failSql: SHIPMENT_LIFECYCLE_SHADOW_LABEL_EVENTS_SQL });

    await expect(loadShipmentLifecycleShadowAuditBatch(harness.client as any))
      .rejects.toThrow("query failed");
    expect(harness.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("surfaces rollback failure instead of reporting a successful audit", async () => {
    const harness = repositoryHarness({ failRollback: true });

    await expect(loadShipmentLifecycleShadowAuditBatch(harness.client as any))
      .rejects.toMatchObject({ code: "ROLLBACK_FAILED" });
    expect(harness.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("fails closed instead of returning a partial label-event history", async () => {
    const harness = repositoryHarness({ events: [labelEventRow(1)] });

    await expect(loadShipmentLifecycleShadowAuditBatch(harness.client as any))
      .rejects.toMatchObject({ code: "INVALID_DATABASE_EVIDENCE" });
    expect(harness.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("bounds per-label history before loading event payloads", async () => {
    const harness = repositoryHarness({
      labels: [labelRow({ label_event_count: "11" })],
    });

    await expect(loadShipmentLifecycleShadowAuditBatch(harness.client as any, {
      maxEventsPerLabel: 10,
    })).rejects.toMatchObject({ code: "HISTORY_BOUND_EXCEEDED" });
    expect(calledSql(harness.calls, SHIPMENT_LIFECYCLE_SHADOW_LABEL_EVENTS_SQL)).toBe(false);
    expect(harness.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("bounds total event rows before loading JSON payloads", async () => {
    const harness = repositoryHarness();

    await expect(loadShipmentLifecycleShadowAuditBatch(harness.client as any, {
      maxPageEvents: 1,
    })).rejects.toMatchObject({ code: "HISTORY_BOUND_EXCEEDED" });
    expect(calledSql(harness.calls, SHIPMENT_LIFECYCLE_SHADOW_LABEL_EVENTS_SQL)).toBe(false);
  });

  it("rejects one oversized event before loading any JSON payload", async () => {
    const harness = repositoryHarness({
      labels: [labelRow({ max_event_payload_bytes: "1001" })],
    });

    await expect(loadShipmentLifecycleShadowAuditBatch(harness.client as any, {
      maxEventPayloadBytes: 1_000,
      maxPagePayloadBytes: 2_000,
    })).rejects.toMatchObject({ code: "HISTORY_BOUND_EXCEEDED" });
    expect(calledSql(harness.calls, SHIPMENT_LIFECYCLE_SHADOW_LABEL_EVENTS_SQL)).toBe(false);
  });

  it("accepts the exact event-byte limit and rejects one byte over the page limit", async () => {
    const exact = repositoryHarness({
      labels: [labelRow({
        label_event_payload_bytes: "1000",
        max_event_payload_bytes: "1000",
      })],
    });
    await expect(loadShipmentLifecycleShadowAuditBatch(exact.client as any, {
      maxEventPayloadBytes: 1_000,
      maxPagePayloadBytes: 1_000,
    })).resolves.toMatchObject({ selectedEventPayloadBytes: 1_000 });

    const over = repositoryHarness({
      labels: [labelRow({
        label_event_payload_bytes: "1001",
        max_event_payload_bytes: "1000",
      })],
    });
    await expect(loadShipmentLifecycleShadowAuditBatch(over.client as any, {
      maxEventPayloadBytes: 1_000,
      maxPagePayloadBytes: 1_000,
    })).rejects.toMatchObject({ code: "HISTORY_BOUND_EXCEEDED" });
    expect(calledSql(over.calls, SHIPMENT_LIFECYCLE_SHADOW_LABEL_EVENTS_SQL)).toBe(false);
  });

  it("uses a stable keyset cursor and returns only the next-page availability token internally", async () => {
    const harness = repositoryHarness({
      labels: [
        labelRow({
          shipping_provider_label_id: "10",
          label_event_count: "0",
          label_event_payload_bytes: "0",
          max_event_payload_bytes: "0",
        }),
        labelRow({
          shipping_provider_label_id: "9",
          label_event_count: "0",
          label_event_payload_bytes: "0",
          max_event_payload_bytes: "0",
        }),
      ],
      events: [],
      matches: [],
    });
    const cursor = { beforeLabelId: "99" } as const;

    const batch = await loadShipmentLifecycleShadowAuditBatch(harness.client as any, {
      labelLimit: 1,
      cursor,
    });
    const labelCall = harness.calls.find(
      ({ text }) => text === SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL,
    );
    expect(labelCall?.parameters).toEqual([2, cursor.beforeLabelId]);
    expect(batch.batchLimitReached).toBe(true);
    expect(batch.nextCursor).toEqual({ beforeLabelId: "10" });
  });

  it("validates cursors and related byte limits before opening a transaction", async () => {
    const harness = repositoryHarness();
    await expect(loadShipmentLifecycleShadowAuditBatch(harness.client as any, {
      cursor: { beforeLabelId: "9223372036854775808" },
    })).rejects.toThrow("PostgreSQL bigint range");
    await expect(loadShipmentLifecycleShadowAuditBatch(harness.client as any, {
      maxEventPayloadBytes: 2_000,
      maxPagePayloadBytes: 1_000,
    })).rejects.toThrow("must not exceed");
    expect(harness.calls).toHaveLength(0);
  });

  it("reads all ShipStation directions and only current confirmed carrier matches", () => {
    expect(SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL)
      .toContain("WHERE label.provider = 'shipstation'");
    expect(SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL)
      .not.toContain("label.label_direction = 'outbound'");
    expect(SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL)
      .toContain("WITH selected_labels AS MATERIALIZED");
    expect(SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL)
      .toContain("$2::bigint IS NULL OR label.id < $2::bigint");
    expect(SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL)
      .toContain("ORDER BY label.id DESC");
    expect(SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL)
      .not.toContain("(label.last_observed_at, label.id) <");
    expect(SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL.indexOf("LIMIT $1"))
      .toBeLessThan(SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL.indexOf("event_stats AS"));
    expect(SHIPMENT_LIFECYCLE_SHADOW_LABEL_EVENTS_SQL)
      .toContain("event.sanitized_payload");
    expect(SHIPMENT_LIFECYCLE_SHADOW_CURRENT_MATCHES_SQL)
      .toContain("match.id = reconciliation_state.last_match_attempt_id");
    expect(SHIPMENT_LIFECYCLE_SHADOW_CURRENT_MATCHES_SQL)
      .toContain("carrier_event.dispatch_evidence = 'confirmed'");
    expect(SHIPMENT_LIFECYCLE_SHADOW_CURRENT_MATCHES_SQL)
      .toContain("match.match_status IN ('matched', 'voided_label')");
    expect(SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL)
      .toContain("has_any_column_privilege");
    expect(SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL.match(
      /SELECT relation\.oid AS relation_oid/g,
    )).toHaveLength(2);
    expect(SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL)
      .toMatch(/has_table_privilege\(\s*current_user,\s*relation_oid,/);
    expect(SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL)
      .toMatch(/has_any_column_privilege\(\s*current_user,\s*relation_oid,/);
    expect(SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL)
      .not.toMatch(
        /has_(?:table|any_column|sequence)_privilege\(\s*current_user,\s*qualified_name,/,
      );
    expect(SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL)
      .toContain("relation.relkind IN ('r', 'p', 'v', 'f')");
  });

  it("backs the immutable provider-and-ID keyset with one matching schema index", () => {
    expect(SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL)
      .toContain("$2::bigint IS NULL OR label.id < $2::bigint");
    expect(SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL)
      .toContain("ORDER BY label.id DESC");
    expect(shadowScanIndexMigration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_shipping_provider_labels_shadow_scan\s+ON wms\.shipping_provider_labels \(provider, id DESC\)/,
    );
    expect(fulfillmentSchema).toMatch(
      /index\("idx_shipping_provider_labels_shadow_scan"\)\s+\.on\(table\.provider, table\.id\.desc\(\)\)/,
    );
  });

  it("exposes every and only operational relation required by its evidence SQL", () => {
    const referencedRelations = new Set<string>();
    for (const statement of [
      SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL,
      SHIPMENT_LIFECYCLE_SHADOW_LABEL_EVENTS_SQL,
      SHIPMENT_LIFECYCLE_SHADOW_CURRENT_MATCHES_SQL,
    ]) {
      for (const match of statement.matchAll(
        /\b(?:FROM|JOIN)\s+(wms\.[a-z_][a-z0-9_]*)/gi,
      )) {
        referencedRelations.add(match[1].toLowerCase());
      }
    }
    expect([...SHIPMENT_LIFECYCLE_SHADOW_REQUIRED_RELATIONS])
      .toEqual([...referencedRelations].sort());
  });

  it("keeps every evidence statement free of DML and DDL", () => {
    const mutating = /\b(?:INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|MERGE\s+INTO|CREATE\s+(?:TABLE|VIEW|SCHEMA)|ALTER\s+|DROP\s+|TRUNCATE\s+)\b/i;
    for (const statement of [
      SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL,
      SHIPMENT_LIFECYCLE_SHADOW_LABEL_EVENTS_SQL,
      SHIPMENT_LIFECYCLE_SHADOW_CURRENT_MATCHES_SQL,
      SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL,
    ]) {
      expect(statement.trim()).toMatch(/^(SELECT|WITH)\b/);
      expect(statement).not.toMatch(mutating);
      expect(statement).not.toContain(";");
    }
  });

  it("rejects sequence USAGE before reading operational evidence", async () => {
    expect(SHIPMENT_LIFECYCLE_SHADOW_ROLE_ASSERTION_SQL).toContain(
      "has_sequence_privilege(current_user, relation_oid, 'USAGE')",
    );
    const harness = repositoryHarness({ role: roleRow({ sequence_usage_count: "1" }) });

    await expect(loadShipmentLifecycleShadowAuditBatch(harness.client as any))
      .rejects.toMatchObject({ code: "READ_ONLY_ROLE_REQUIRED" });
    expect(calledSql(harness.calls, SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL)).toBe(false);
    expect(harness.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("classifies malformed role evidence without reading operational rows", async () => {
    const harness = repositoryHarness({ role: roleRow({ elevated_role: "false" }) });

    await expect(loadShipmentLifecycleShadowAuditBatch(harness.client as any))
      .rejects.toBeInstanceOf(ShipmentLifecycleShadowAuditRepositoryError);
    expect(calledSql(harness.calls, SHIPMENT_LIFECYCLE_SHADOW_LABEL_BATCH_SQL)).toBe(false);
  });

  it("publishes conservative defaults and hard maxima through one contract", () => {
    const normalized = normalizeShipmentLifecycleShadowAuditRepositoryOptions();
    expect(normalized.labelLimit).toBe(25);
    expect(normalized.maxPageEvents)
      .toBe(SHIPMENT_LIFECYCLE_SHADOW_AUDIT_LIMITS.defaultMaxPageEvents);
    expect(normalized.maxEventPayloadBytes)
      .toBe(SHIPMENT_LIFECYCLE_SHADOW_AUDIT_LIMITS.defaultMaxEventPayloadBytes);
    expect(normalized.maxPagePayloadBytes)
      .toBe(SHIPMENT_LIFECYCLE_SHADOW_AUDIT_LIMITS.defaultMaxPagePayloadBytes);
    expect(Object.isFrozen(normalized)).toBe(true);
  });
});
