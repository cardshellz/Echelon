import { describe, expect, it } from "vitest";

import {
  HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL,
  HISTORICAL_SHIPSTATION_CONTENTS_LINEAGE_REQUIRED_RELATIONS,
  HISTORICAL_SHIPSTATION_CONTENTS_LINEAGE_ROLE_ASSERTION_SQL,
  HISTORICAL_SHIPSTATION_CONTENTS_LINKED_LINES_SQL,
  HISTORICAL_SHIPSTATION_CONTENTS_LINKS_SQL,
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

function lineageRoleRow() {
  return {
    missing_required_select_count: "0",
    required_rls_count: "0",
    missing_required_schema_usage_count: "0",
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
    expect(HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL).toMatch(
      /\(\$1::bigint IS NULL OR label\.id < \$1::bigint\)/,
    );
    expect(HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL).toMatch(/ORDER BY label\.id DESC/);
    expect(HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL).toMatch(/LIMIT \$2/);
    expect(HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL).not.toMatch(
      /ORDER BY label\.last_observed_at/,
    );
    for (const sql of [
      HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL,
      HISTORICAL_SHIPSTATION_CONTENTS_LINEAGE_ROLE_ASSERTION_SQL,
      HISTORICAL_SHIPSTATION_CONTENTS_LINKS_SQL,
      HISTORICAL_SHIPSTATION_CONTENTS_LINKED_LINES_SQL,
    ]) {
      expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
    }
    expect(HISTORICAL_SHIPSTATION_CONTENTS_LINEAGE_REQUIRED_RELATIONS).toEqual([
      "catalog.product_variants",
      "wms.order_items",
      "wms.outbound_shipment_items",
      "wms.physical_shipment_items",
      "wms.shipping_provider_label_links",
    ]);
    expect(HISTORICAL_SHIPSTATION_CONTENTS_LINKED_LINES_SQL).toMatch(/UNION ALL/);
    expect(HISTORICAL_SHIPSTATION_CONTENTS_LINKED_LINES_SQL).toMatch(
      /WHEN 'replacement' THEN replacement_order_item\.sku/,
    );
    expect(HISTORICAL_SHIPSTATION_CONTENTS_LINKED_LINES_SQL).toMatch(
      /WHEN 'omission_correction' THEN variant\.sku/,
    );
  });

  it("hydrates a bounded page with physical-package precedence and legacy fallback", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      async query(text: string, values?: unknown[]) {
        queries.push({ text, values });
        if (text.includes("current_setting('transaction_read_only')")) {
          return { rows: [readOnlyRoleRow()] };
        }
        if (text === HISTORICAL_SHIPSTATION_CONTENTS_LINEAGE_ROLE_ASSERTION_SQL) {
          return { rows: [lineageRoleRow()] };
        }
        if (text === HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL) {
          return { rows: [
            { shipping_provider_label_id: "103", provider_label_id: "44003" },
            { shipping_provider_label_id: "102", provider_label_id: "44002" },
            { shipping_provider_label_id: "101", provider_label_id: "44001" },
          ] };
        }
        if (text === HISTORICAL_SHIPSTATION_CONTENTS_LINKS_SQL) {
          return { rows: [
            {
              shipping_provider_label_id: "103",
              physical_shipment_count: "1",
              legacy_wms_shipment_count: "2",
            },
            {
              shipping_provider_label_id: "102",
              physical_shipment_count: "0",
              legacy_wms_shipment_count: "1",
            },
          ] };
        }
        if (text === HISTORICAL_SHIPSTATION_CONTENTS_LINKED_LINES_SQL) {
          return { rows: [
            {
              shipping_provider_label_id: "103",
              source_kind: "physical_shipment",
              wms_shipment_item_id: "7002",
              sku: "SKU-B",
              quantity: "1",
            },
            {
              shipping_provider_label_id: "103",
              source_kind: "physical_shipment",
              wms_shipment_item_id: "7001",
              sku: "SKU-A",
              quantity: "2",
            },
            {
              shipping_provider_label_id: "103",
              source_kind: "legacy_wms_shipment",
              wms_shipment_item_id: "7999",
              sku: null,
              quantity: "1",
            },
            {
              shipping_provider_label_id: "102",
              source_kind: "legacy_wms_shipment",
              wms_shipment_item_id: "7101",
              sku: "SKU-C",
              quantity: "3",
            },
          ] };
        }
        return { rows: [] };
      },
    };

    await expect(loadHistoricalShipStationContentsCandidates(client, {
      candidateLimit: 2,
      beforeLabelId: "104",
      statementTimeoutMs: 3_000,
      lockTimeoutMs: 500,
      idleInTransactionTimeoutMs: 5_000,
    })).resolves.toEqual({
      candidateLimit: 2,
      beforeLabelId: "104",
      nextBeforeLabelId: "102",
      batchLimitReached: true,
      databaseTemporaryPrivilege: false,
      candidates: [
        {
          shippingProviderLabelId: "103",
          providerShipmentId: 44_003,
          expectedContents: {
            kind: "available",
            source: "physical_shipment",
            lines: [
              { wmsShipmentItemId: 7_001, sku: "SKU-A", quantity: 2 },
              { wmsShipmentItemId: 7_002, sku: "SKU-B", quantity: 1 },
            ],
          },
        },
        {
          shippingProviderLabelId: "102",
          providerShipmentId: 44_002,
          expectedContents: {
            kind: "available",
            source: "legacy_wms_shipment",
            lines: [{ wmsShipmentItemId: 7_101, sku: "SKU-C", quantity: 3 }],
          },
        },
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
      .toMatchObject({ values: ["104", 3] });
    expect(queries.find((query) => query.text === HISTORICAL_SHIPSTATION_CONTENTS_LINKS_SQL))
      .toMatchObject({ values: [["103", "102"]] });
    expect(queries.find((query) => query.text === HISTORICAL_SHIPSTATION_CONTENTS_LINKED_LINES_SQL))
      .toMatchObject({ values: [["103", "102"], 501] });
    expect(queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("keeps ambiguous or empty linked package evidence unavailable", async () => {
    const client = {
      async query(text: string) {
        if (text.includes("current_setting('transaction_read_only')")) {
          return { rows: [readOnlyRoleRow()] };
        }
        if (text === HISTORICAL_SHIPSTATION_CONTENTS_LINEAGE_ROLE_ASSERTION_SQL) {
          return { rows: [lineageRoleRow()] };
        }
        if (text === HISTORICAL_SHIPSTATION_CONTENTS_CANDIDATES_SQL) {
          return { rows: [
            { shipping_provider_label_id: "103", provider_label_id: "44003" },
            { shipping_provider_label_id: "102", provider_label_id: "44002" },
          ] };
        }
        if (text === HISTORICAL_SHIPSTATION_CONTENTS_LINKS_SQL) {
          return { rows: [
            {
              shipping_provider_label_id: "103",
              physical_shipment_count: "2",
              legacy_wms_shipment_count: "0",
            },
            {
              shipping_provider_label_id: "102",
              physical_shipment_count: "0",
              legacy_wms_shipment_count: "1",
            },
          ] };
        }
        return { rows: [] };
      },
    };

    await expect(loadHistoricalShipStationContentsCandidates(client, {
      candidateLimit: 2,
    })).resolves.toMatchObject({
      candidates: [
        { expectedContents: { kind: "unavailable", reason: "ambiguous_linked_package" } },
        { expectedContents: { kind: "unavailable", reason: "linked_package_contents_unavailable" } },
      ],
    });
  });

  it("fails closed when the audit role cannot read a lineage relation", async () => {
    const client = {
      async query(text: string) {
        if (text.includes("current_setting('transaction_read_only')")) {
          return { rows: [readOnlyRoleRow()] };
        }
        if (text === HISTORICAL_SHIPSTATION_CONTENTS_LINEAGE_ROLE_ASSERTION_SQL) {
          return { rows: [{ ...lineageRoleRow(), missing_required_select_count: "1" }] };
        }
        return { rows: [] };
      },
    };
    await expect(loadHistoricalShipStationContentsCandidates(client)).rejects.toMatchObject({
      code: "INVALID_DATABASE_EVIDENCE",
      context: { missingRequiredSelectCount: 1 },
    });
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
    expect(normalizeHistoricalShipStationContentsAuditRepositoryOptions({})).toMatchObject({
      beforeLabelId: null,
    });
    expect(normalizeHistoricalShipStationContentsAuditRepositoryOptions({
      beforeLabelId: "9223372036854775807",
    })).toMatchObject({ beforeLabelId: "9223372036854775807" });
    for (const beforeLabelId of ["", "0", " 1", "9223372036854775808"]) {
      expect(() => normalizeHistoricalShipStationContentsAuditRepositoryOptions({ beforeLabelId }))
        .toThrow(/beforeLabelId/);
    }
  });
});
