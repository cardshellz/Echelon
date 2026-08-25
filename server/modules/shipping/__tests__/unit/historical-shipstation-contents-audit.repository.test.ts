import { describe, expect, it } from "vitest";

import {
  HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL,
  HistoricalShipStationContentsAuditRepositoryError,
  loadHistoricalShipStationContentsCandidates,
  normalizeHistoricalShipStationContentsAuditRepositoryOptions,
} from "../../historical-shipstation-contents-audit.repository";

function readOnlyRoleRow() {
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
    database_temporary_privilege: false,
    other_role_membership_count: "0",
    elevated_role: false,
  };
}

describe("historical ShipStation contents audit repository", () => {
  it("uses immutable key ordering and selects only unresolved historical V1 outbound labels", () => {
    expect(HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL).toMatch(
      /label\.provider = 'shipstation'/,
    );
    expect(HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL).toMatch(
      /label\.label_direction = 'outbound'/,
    );
    expect(HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL).toMatch(
      /NOT \(historical_event\.sanitized_payload \? 'payloadSchemaVersion'\)/,
    );
    expect(HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL).toMatch(
      /payloadSchemaVersion' = '1'/,
    );
    expect(HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL).toMatch(
      /declaredContentsEvidence'.*'status'[\s\S]*= 'authoritative'/,
    );
    expect(HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL).toMatch(/ORDER BY label\.id DESC/);
    expect(HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL).not.toMatch(
      /ORDER BY label\.last_observed_at/,
    );
    expect(HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i,
    );
  });

  it("reads one bounded page under repeatable-read read-only and always rolls back", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      async query(text: string, values?: unknown[]) {
        queries.push({ text, values });
        if (text.includes("current_setting('transaction_read_only')")) {
          return { rows: [readOnlyRoleRow()] };
        }
        if (text === HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL) {
          return { rows: [
            { shipping_provider_label_id: "103", provider_label_id: "44003" },
            { shipping_provider_label_id: "102", provider_label_id: "44002" },
            { shipping_provider_label_id: "101", provider_label_id: "44001" },
          ] };
        }
        return { rows: [] };
      },
    };

    await expect(loadHistoricalShipStationContentsCandidates(client, {
      candidateLimit: 2,
      statementTimeoutMs: 3_000,
      lockTimeoutMs: 500,
      idleInTransactionTimeoutMs: 5_000,
    })).resolves.toEqual({
      candidateLimit: 2,
      batchLimitReached: true,
      databaseTemporaryPrivilege: false,
      candidates: [
        { shippingProviderLabelId: "103", providerShipmentId: 44_003 },
        { shippingProviderLabelId: "102", providerShipmentId: 44_002 },
      ],
    });
    expect(queries[0]?.text).toBe(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(queries).toContainEqual({
      text: "SELECT set_config('statement_timeout', $1, true)",
      values: ["3000ms"],
    });
    expect(queries.find((query) => query.text === HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL))
      .toMatchObject({ values: [3] });
    expect(queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("preserves both a primary and rollback failure", async () => {
    const primary = new Error("primary failure");
    const rollback = new Error("rollback failure");
    const client = {
      async query(text: string) {
        if (text.startsWith("SELECT set_config")) throw primary;
        if (text === "ROLLBACK") throw rollback;
        return { rows: [] };
      },
    };
    const promise = loadHistoricalShipStationContentsCandidates(client);

    await expect(promise).rejects.toMatchObject({ code: "ROLLBACK_FAILED" });
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(HistoricalShipStationContentsAuditRepositoryError);
      expect((error as Error).cause).toBeInstanceOf(AggregateError);
      expect([...(error as Error & { cause: AggregateError }).cause.errors]).toEqual([
        primary,
        rollback,
      ]);
    });
  });

  it("enforces the public bounds", () => {
    expect(() => normalizeHistoricalShipStationContentsAuditRepositoryOptions({
      candidateLimit: 101,
    })).toThrow(/candidateLimit/);
  });
});
