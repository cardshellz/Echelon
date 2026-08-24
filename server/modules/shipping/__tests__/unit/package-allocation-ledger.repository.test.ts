import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it } from "vitest";

import {
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_RELATIONSHIP_TYPES,
} from "../../package-allocation-authority-discovery.query";
import {
  type AppendPackageAllocationPlanInput,
  PackageAllocationLedgerRepositoryError,
  PgPackageAllocationLedgerRepository,
} from "../../package-allocation-ledger.repository";
import { PackageAllocationPersistenceError } from "../../package-allocation-planning.service";
import { derivePackageAllocationSourceRegistration } from "../../package-allocation-source-identity.domain";

const groupKey = "86e1be0d-c7d8-4c91-919f-04f5eb547f79";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

class FakeClient {
  readonly queries: RecordedQuery[] = [];
  released = false;
  releaseArgument: Error | boolean | undefined;
  releaseError: Error | null = null;
  handler: (query: RecordedQuery) => readonly Record<string, unknown>[] = () => [];

  async query(text: string, values: readonly unknown[] = []): Promise<QueryResult<any>> {
    const query = { text, values };
    this.queries.push(query);
    return {
      command: "SELECT",
      rowCount: null,
      oid: 0,
      fields: [],
      rows: [...this.handler(query)],
    };
  }

  release(error?: Error | boolean): void {
    this.released = true;
    this.releaseArgument = error;
    if (this.releaseError) throw this.releaseError;
  }
}

function repositoryWith(client: FakeClient): PgPackageAllocationLedgerRepository {
  const pool = {
    connect: async () => client as unknown as PoolClient,
  } as Pick<Pool, "connect">;
  return new PgPackageAllocationLedgerRepository(pool);
}

function appendPlanInput(): AppendPackageAllocationPlanInput {
  const registration = derivePackageAllocationSourceRegistration({
    sourceWmsShipmentItemId: 7001,
    shipmentRequestItemId: "90001",
    sourceQuantity: 2,
    shipmentItemPurpose: "customer_fulfillment",
    orderItemId: 8101,
    replacementForOrderItemId: null,
    correctionForShipmentItemId: null,
    productVariantId: 9101,
    orderItemSku: "SKU-ONE",
    replacementOrderItemSku: null,
    productVariantSku: "SKU-ONE",
  });
  return {
    group: { id: "1", groupKey, currentVersion: 0 },
    planVersion: 1,
    inputHash: "a".repeat(64),
    stateHash: "b".repeat(64),
    outcome: "proposed",
    plannerVersion: "package-allocation-group-v1",
    reason: "partial-failure-test",
    createdBy: "unit-test",
    stateSnapshot: {} as AppendPackageAllocationPlanInput["stateSnapshot"],
    reviewSnapshot: { contractVersion: 1, reviews: [] },
    entries: [{
      entryKey: "entry:7001:A",
      allocationKey: "allocation:7001:A",
      wmsShipmentItemId: 7001,
      allocationKind: "primary_transfer",
      targetKind: "package",
      packageKey: "A",
      quantity: 2,
    }],
    intents: [{
      intentKey: "intent:7001:A",
      executable: false,
      effectType: "inventory_consumption",
      subjectKey: "source:7001",
      wmsShipmentItemId: 7001,
      packageKey: "A",
      quantity: 2,
      payloadHash: "c".repeat(64),
    }],
    sourcesByWmsItemId: new Map([[7001, { id: "11", registration }]]),
    bindingsByPackageKey: new Map([[
      "A",
      {
        id: "21",
        packageKey: "A",
        provider: "shipstation",
        providerPhysicalShipmentId: "44001",
        identityHash: "d".repeat(64),
      },
    ]]),
  };
}

describe("PgPackageAllocationLedgerRepository", () => {
  it("uses a bounded serializable transaction and releases the client", async () => {
    const client = new FakeClient();
    const repository = repositoryWith(client);

    await expect(repository.withSerializableTransaction(async () => "ok")).resolves.toBe("ok");

    expect(client.queries.map((query) => query.text)).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE",
      expect.stringContaining("set_config('statement_timeout'"),
      "COMMIT",
    ]);
    expect(client.queries[1].values).toEqual(["30000ms", "5000ms", "60000ms"]);
    expect(client.released).toBe(true);
  });

  it("uses one bounded repeatable read-only snapshot without writer locks", async () => {
    const client = new FakeClient();
    client.handler = ({ text }) => {
      if (text.includes("FROM wms.package_allocation_groups")) {
        return [{ id: "1", group_key: groupKey, current_version: 0 }];
      }
      if (text.includes("FROM wms.outbound_shipment_items")) {
        return [{
          source_wms_shipment_item_id: 7001,
          shipment_request_item_id: "90001",
          source_quantity: 2,
          shipment_item_purpose: "customer_fulfillment",
          order_item_id: 8101,
          replacement_for_order_item_id: null,
          correction_for_shipment_item_id: null,
          product_variant_id: 9101,
          order_item_sku: "SKU-ONE",
          replacement_order_item_sku: null,
          product_variant_sku: "SKU-ONE",
        }];
      }
      if (text.includes("WITH locked_labels AS MATERIALIZED")) {
        return [{
          shipping_provider_label_id: "42",
          provider: "shipstation",
          provider_label_id: "44_001",
          tracking_number: "1Z-PREVIEW-42",
          label_status: "active",
          label_direction: "outbound",
          first_observed_at: new Date("2026-08-23T12:00:00.000Z"),
          last_observed_at: new Date("2026-08-23T12:00:01.000Z"),
          label_event_count: "0",
          label_event_payload_bytes: "0",
          max_event_payload_bytes: "0",
        }];
      }
      return [];
    };
    const repository = repositoryWith(client);

    const evidence = await repository.withRepeatableReadOnlyTransaction(
      async (transaction) => ({
        group: await transaction.readGroup(groupKey),
        sourceFacts: await transaction.readSourceFacts([7001]),
        packages: await transaction.readAuthorityReadinessPackages([42]),
      }),
    );

    expect(evidence.group).toEqual({ id: "1", groupKey, currentVersion: 0 });
    expect(evidence.sourceFacts.map((fact) => fact.sourceWmsShipmentItemId)).toEqual([7001]);
    expect(evidence.packages.map((pkg) => pkg.evidenceKey)).toEqual(["shipping-provider-label:42"]);
    expect(client.queries[0].text).toBe(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(client.queries[1].values).toEqual(["30000ms", "5000ms", "60000ms"]);
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
    const queryText = client.queries.map((query) => query.text).join("\n");
    expect(queryText).not.toMatch(/pg_advisory_xact_lock|FOR\s+(?:UPDATE|KEY SHARE)/i);
    expect(client.queries.map((query) => query.text)).not.toContain("COMMIT");
    expect(client.released).toBe(true);
  });

  it("preserves a read-only preview application failure and rolls back", async () => {
    const client = new FakeClient();
    const repository = repositoryWith(client);
    const primary = new PackageAllocationPersistenceError(
      "STALE_GROUP_VERSION",
      "stale preview test result",
    );

    await expect(repository.withRepeatableReadOnlyTransaction(async () => {
      throw primary;
    })).rejects.toBe(primary);

    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(client.queries.map((query) => query.text)).not.toContain("COMMIT");
    expect(client.released).toBe(true);
  });

  it("evicts a read-only preview client whose rollback failed", async () => {
    const client = new FakeClient();
    const rollbackError = Object.assign(
      new Error("read-only rollback failed"),
      { code: "ROLLBACK_TEST" },
    );
    client.handler = ({ text }) => {
      if (text === "ROLLBACK") throw rollbackError;
      return [];
    };
    const repository = repositoryWith(client);

    await expect(
      repository.withRepeatableReadOnlyTransaction(async () => "ok"),
    ).rejects.toMatchObject({
      name: "PackageAllocationLedgerRepositoryError",
      code: "ROLLBACK_FAILED",
      context: {
        primaryCode: null,
        rollbackPostgresCode: "ROLLBACK_TEST",
      },
    });

    expect(client.releaseArgument).toBe(rollbackError);
    expect(client.released).toBe(true);
  });

  it("preserves a classified application error and rolls back", async () => {
    const client = new FakeClient();
    const repository = repositoryWith(client);
    const primary = new PackageAllocationPersistenceError(
      "STALE_GROUP_VERSION",
      "stale test result",
    );

    await expect(repository.withSerializableTransaction(async () => {
      throw primary;
    })).rejects.toBe(primary);

    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(client.released).toBe(true);
  });

  it("preserves both the primary and release failures", async () => {
    const client = new FakeClient();
    client.releaseError = Object.assign(new Error("release failed"), { code: "RELEASE_TEST" });
    const repository = repositoryWith(client);
    const primary = new PackageAllocationPersistenceError(
      "STALE_GROUP_VERSION",
      "stale test result",
    );

    await expect(repository.withSerializableTransaction(async () => {
      throw primary;
    })).rejects.toMatchObject({
      name: "PackageAllocationLedgerRepositoryError",
      code: "RELEASE_FAILED",
      context: {
        primaryCode: "STALE_GROUP_VERSION",
        releaseCode: "RELEASE_TEST",
      },
      cause: expect.any(AggregateError),
    });
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("evicts a client whose rollback failed", async () => {
    const client = new FakeClient();
    const rollbackError = Object.assign(new Error("rollback failed"), { code: "ROLLBACK_TEST" });
    client.handler = ({ text }) => {
      if (text === "ROLLBACK") throw rollbackError;
      return [];
    };
    const repository = repositoryWith(client);

    await expect(repository.withSerializableTransaction(async () => {
      throw new PackageAllocationPersistenceError("STALE_GROUP_VERSION", "stale test result");
    })).rejects.toMatchObject({
      name: "PackageAllocationLedgerRepositoryError",
      code: "ROLLBACK_FAILED",
      context: { rollbackPostgresCode: "ROLLBACK_TEST" },
    });

    expect(client.releaseArgument).toBe(rollbackError);
    expect(client.released).toBe(true);
  });

  it("classifies connection failure before a transaction exists", async () => {
    const pool = {
      connect: async () => {
        throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      },
    } as Pick<Pool, "connect">;
    const repository = new PgPackageAllocationLedgerRepository(pool);

    await expect(repository.withSerializableTransaction(async () => "unused")).rejects.toMatchObject({
      name: "PackageAllocationLedgerRepositoryError",
      code: "DATABASE_ERROR",
      context: { postgresCode: "ECONNREFUSED" },
    });
  });

  it("locks the group before selecting it for update", async () => {
    const client = new FakeClient();
    client.handler = ({ text }) => text.includes("FROM wms.package_allocation_groups")
      ? [{ id: "1", group_key: groupKey, current_version: 0 }]
      : [];
    const repository = repositoryWith(client);

    const group = await repository.withSerializableTransaction((transaction) => (
      transaction.lockGroup(groupKey, true)
    ));

    expect(group).toEqual({ id: "1", groupKey, currentVersion: 0 });
    const texts = client.queries.map((query) => query.text);
    expect(texts.findIndex((text) => text.includes("pg_advisory_xact_lock"))).toBeLessThan(
      texts.findIndex((text) => text.includes("FOR UPDATE")),
    );
    expect(texts).toContain("COMMIT");
  });

  it("locks and hydrates source rows in ascending WMS-item order", async () => {
    const client = new FakeClient();
    client.handler = ({ text }) => text.includes("FROM wms.outbound_shipment_items")
      ? [
        {
          source_wms_shipment_item_id: 7001,
          shipment_request_item_id: "90001",
          source_quantity: 2,
          shipment_item_purpose: "customer_fulfillment",
          order_item_id: 8101,
          replacement_for_order_item_id: null,
          correction_for_shipment_item_id: null,
          product_variant_id: 9101,
          order_item_sku: "SKU-ONE",
          replacement_order_item_sku: null,
          product_variant_sku: "SKU-ONE",
        },
        {
          source_wms_shipment_item_id: 7002,
          shipment_request_item_id: "90002",
          source_quantity: 1,
          shipment_item_purpose: "customer_fulfillment",
          order_item_id: 8102,
          replacement_for_order_item_id: null,
          correction_for_shipment_item_id: null,
          product_variant_id: 9102,
          order_item_sku: "SKU-TWO",
          replacement_order_item_sku: null,
          product_variant_sku: "SKU-TWO",
        },
      ]
      : [];
    const repository = repositoryWith(client);

    const facts = await repository.withSerializableTransaction((transaction) => (
      transaction.lockSourceFacts([7002, 7001, 7002])
    ));

    expect(facts.map((fact) => fact.sourceWmsShipmentItemId)).toEqual([7001, 7002]);
    const sourceLocks = client.queries.filter((query) => (
      query.text === "SELECT pg_advisory_xact_lock($1, $2)"
    ));
    expect(sourceLocks.map((query) => query.values[1])).toEqual([7001, 7002]);
    expect(client.queries.find((query) => query.text.includes("FROM wms.outbound_shipment_items"))?.text)
      .toContain("FOR UPDATE OF shipment_item");
  });

  it("discovers a bounded label set through exact persisted shipment relationships", async () => {
    const client = new FakeClient();
    client.handler = ({ text }) => text.includes("WITH selected_sources AS MATERIALIZED")
      ? [
          {
            source_count: 2,
            found_source_ids: [7001, 7002],
            shipping_provider_label_id: "42",
            relationship_types: [
              "shipping_engine_order_link",
              "provider_order_id_match",
            ],
          },
          {
            source_count: 2,
            found_source_ids: [7001, 7002],
            shipping_provider_label_id: "43",
            relationship_types: ["provider_order_id_match"],
          },
        ]
      : [];
    const repository = repositoryWith(client);

    const selection = await repository.withSerializableTransaction((transaction) => (
      transaction.discoverAuthorityReadinessPackageSelection([7002, 7001, 7002])
    ));

    expect(selection).toEqual([
      {
        shippingProviderLabelId: 42,
        relationshipTypes: [
          "provider_order_id_match",
          "shipping_engine_order_link",
        ],
      },
      {
        shippingProviderLabelId: 43,
        relationshipTypes: ["provider_order_id_match"],
      },
    ]);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection[0])).toBe(true);
    expect(Object.isFrozen(selection[0].relationshipTypes)).toBe(true);
    const discoveryQuery = client.queries.find((query) =>
      query.text.includes("WITH selected_sources AS MATERIALIZED"),
    );
    expect(discoveryQuery?.values).toEqual([[7001, 7002], 201]);
    expect(discoveryQuery?.text).toContain("wms.shipment_request_items");
    expect(discoveryQuery?.text).toContain("wms.shipment_requests");
    expect(discoveryQuery?.text).toContain("wms.shipping_engine_order_requests");
    expect(discoveryQuery?.text).toContain("wms.shipping_engine_order_provider_refs");
    expect(discoveryQuery?.text).toContain("wms.physical_shipment_items");
    expect(discoveryQuery?.text).toContain("physical_item.shipment_request_item_id");
    expect(discoveryQuery?.text).toContain("physical.shipment_request_id");
    expect(discoveryQuery?.text).toMatch(
      /anchor_engine_orders AS MATERIALIZED \([\s\S]*?JOIN anchor_requests AS request[\s\S]*?WHERE physical\.shipping_engine_order_id IS NOT NULL\s*\),\s*scope_requests AS MATERIALIZED/,
    );
    expect(discoveryQuery?.text).not.toMatch(
      /anchor_engine_orders AS MATERIALIZED \([\s\S]*?\),\s*UNION\s+SELECT physical\.shipping_engine_order_id/,
    );
    expect(discoveryQuery?.text).toContain("wms.shipping_provider_label_links");
    expect(discoveryQuery?.text).toContain(
      "candidate_label_relationships AS MATERIALIZED",
    );
    for (const relationshipType of PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_RELATIONSHIP_TYPES) {
      expect(discoveryQuery?.text).toContain(`'${relationshipType}'::text`);
    }
    expect(discoveryQuery?.text).toMatch(/ARRAY_AGG\(\s*DISTINCT relationship\.relationship_type/);
    expect(discoveryQuery?.text).not.toMatch(/WHERE\s+link\.shipment_request_id[\s\S]*?\sOR\s+link\./);
    expect(discoveryQuery?.text).not.toMatch(
      /engine_order\.provider_order_id[\s\S]*?\sOR\s+[\s\S]*?engine_order\.provider_order_key/,
    );
    expect(discoveryQuery?.text).not.toContain("JOIN wms.orders");
    expect(discoveryQuery?.text).not.toContain("wms_order_id");
  });

  it("fails closed when no outbound label is related to the source set", async () => {
    const client = new FakeClient();
    client.handler = ({ text }) => text.includes("WITH selected_sources AS MATERIALIZED")
      ? [{
          source_count: 1,
          found_source_ids: [7001],
          shipping_provider_label_id: null,
        }]
      : [];
    const repository = repositoryWith(client);

    await expect(repository.withSerializableTransaction((transaction) => (
      transaction.discoverAuthorityReadinessPackageSelection([7001])
    ))).rejects.toMatchObject({
      code: "PACKAGE_EVIDENCE_NOT_FOUND",
      context: { sourceWmsShipmentItemIds: [7001] },
    });
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it.each([
    ["empty", []],
    ["unknown", ["forged_relationship"]],
    ["duplicate", ["shipment_request_link", "shipment_request_link"]],
  ] as const)("fails closed on %s relationship evidence", async (_case, relationshipTypes) => {
    const client = new FakeClient();
    client.handler = ({ text }) => text.includes("WITH selected_sources AS MATERIALIZED")
      ? [{
          source_count: 1,
          found_source_ids: [7001],
          shipping_provider_label_id: "42",
          relationship_types: [...relationshipTypes],
        }]
      : [];
    const repository = repositoryWith(client);

    await expect(repository.withSerializableTransaction((transaction) => (
      transaction.discoverAuthorityReadinessPackageSelection([7001])
    ))).rejects.toMatchObject({
      code: "INVALID_DATABASE_EVIDENCE",
      context: { field: "relationship_types" },
    });
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("fails closed when a source disappears or the package bound is exceeded", async () => {
    const missingSourceClient = new FakeClient();
    missingSourceClient.handler = ({ text }) =>
      text.includes("WITH selected_sources AS MATERIALIZED")
        ? [{
            source_count: 1,
            found_source_ids: [7001],
            shipping_provider_label_id: "42",
          }]
        : [];
    const missingSourceRepository = repositoryWith(missingSourceClient);

    await expect(missingSourceRepository.withSerializableTransaction((transaction) => (
      transaction.discoverAuthorityReadinessPackageSelection([7001, 7002])
    ))).rejects.toMatchObject({
      code: "SOURCE_EVIDENCE_NOT_FOUND",
      context: { missingWmsShipmentItemIds: [7002] },
    });

    const oversizedClient = new FakeClient();
    oversizedClient.handler = ({ text }) =>
      text.includes("WITH selected_sources AS MATERIALIZED")
        ? Array.from({ length: 201 }, (_unused, index) => ({
            source_count: 1,
            found_source_ids: [7001],
            shipping_provider_label_id: String(index + 1),
            relationship_types: ["shipment_request_link"],
          }))
        : [];
    const oversizedRepository = repositoryWith(oversizedClient);

    await expect(oversizedRepository.withSerializableTransaction((transaction) => (
      transaction.discoverAuthorityReadinessPackageSelection([7001])
    ))).rejects.toMatchObject({
      code: "INVALID_DATABASE_EVIDENCE",
      context: {
        observedPackageCount: 201,
        maxPackageCount: 200,
      },
    });
  });

  it("serializes source and membership batches with the SQL record field names", async () => {
    const client = new FakeClient();
    const registration = derivePackageAllocationSourceRegistration({
      sourceWmsShipmentItemId: 7001,
      shipmentRequestItemId: "90001",
      sourceQuantity: 2,
      shipmentItemPurpose: "customer_fulfillment",
      orderItemId: 8101,
      replacementForOrderItemId: null,
      correctionForShipmentItemId: null,
      productVariantId: 9101,
      orderItemSku: "SKU-ONE",
      replacementOrderItemSku: null,
      productVariantSku: "SKU-ONE",
    });
    client.handler = ({ text }) => {
      if (text.includes("FROM wms.package_allocation_source_lines")) {
        return [{
          id: "11",
          source_wms_shipment_item_id: 7001,
          shipment_request_item_id: "90001",
          source_quantity: 2,
          shipment_item_purpose: "customer_fulfillment",
          order_item_id: 8101,
          replacement_for_order_item_id: null,
          correction_for_shipment_item_id: null,
          product_variant_id: 9101,
          sku: "SKU-ONE",
          source_fingerprint: registration.sourceFingerprint,
        }];
      }
      if (text.includes("FROM wms.package_allocation_group_source_lines")) {
        return [{ source_wms_shipment_item_id: 7001 }];
      }
      return [];
    };
    const repository = repositoryWith(client);
    const group = { id: "1", groupKey, currentVersion: 0 };

    await repository.withSerializableTransaction((transaction) => (
      transaction.ensureSourceRegistrations(group, [registration], true)
    ));

    const sourceInsert = client.queries.find((query) => (
      query.text.includes("INSERT INTO wms.package_allocation_source_lines")
    ));
    const sourceRow = JSON.parse(String(sourceInsert?.values[0]))[0];
    expect(sourceRow).toEqual({
      source_wms_shipment_item_id: 7001,
      shipment_request_item_id: "90001",
      source_quantity: 2,
      shipment_item_purpose: "customer_fulfillment",
      order_item_id: 8101,
      replacement_for_order_item_id: null,
      correction_for_shipment_item_id: null,
      product_variant_id: 9101,
      sku: "SKU-ONE",
      source_fingerprint: registration.sourceFingerprint,
    });
    expect(sourceRow).not.toHaveProperty("sourceWmsShipmentItemId");

    const membershipInsert = client.queries.find((query) => (
      query.text.includes("INSERT INTO wms.package_allocation_group_source_lines")
    ));
    expect(JSON.parse(String(membershipInsert?.values[0]))).toEqual([{
      package_allocation_group_id: "1",
      package_allocation_source_line_id: "11",
    }]);
  });

  it("uses code-unit order for package advisory locks regardless of host locale", async () => {
    const client = new FakeClient();
    const packages = [{
      packageKey: "umlaut",
      allocationRole: "additional_dispatch" as const,
      provider: "shipstation",
      providerPhysicalShipmentId: "ä",
      identityHash: "a".repeat(64),
      lifecycleEventEvidence: [{
        eventKey: "shipstation:umlaut:observed",
        eventHash: "b".repeat(64),
      }],
    }, {
      packageKey: "ascii",
      allocationRole: "additional_dispatch" as const,
      provider: "shipstation",
      providerPhysicalShipmentId: "z",
      identityHash: "c".repeat(64),
      lifecycleEventEvidence: [{
        eventKey: "shipstation:ascii:observed",
        eventHash: "d".repeat(64),
      }],
    }];
    client.handler = ({ text }) => text.includes(
      "FROM wms.package_allocation_package_bindings",
    )
      ? packages.map((pkg, index) => ({
        id: String(21 + index),
        package_key: pkg.packageKey,
        provider: pkg.provider,
        provider_physical_shipment_id: pkg.providerPhysicalShipmentId,
        identity_hash: pkg.identityHash,
      }))
      : [];
    const repository = repositoryWith(client);

    await repository.withSerializableTransaction((transaction) => (
      transaction.ensurePackageBindings(
        { id: "1", groupKey, currentVersion: 0 },
        packages,
        true,
      )
    ));

    const packageLocks = client.queries
      .filter((query) => query.text.includes("hashtextextended($1, 0)"))
      .map((query) => query.values[0]);
    expect(packageLocks).toEqual([
      "package-allocation-package:shipstation:z",
      "package-allocation-package:shipstation:ä",
    ]);
  });

  it("normalizes database-collated replay rows to planner code-unit order", async () => {
    const client = new FakeClient();
    client.handler = ({ text }) => {
      if (text.includes("FROM wms.package_allocation_entries")) {
        return ["ä", "z"].map((key) => ({
          entry_key: key,
          allocation_key: `allocation:${key}`,
          source_wms_shipment_item_id: 7001,
          allocation_kind: "primary_transfer",
          target_kind: "package",
          package_key: "A",
          shipping_provider_label_id: null,
          quantity: 1,
        }));
      }
      if (text.includes("FROM wms.package_allocation_effect_intents")) {
        return ["ä", "z"].map((key) => ({
          intent_key: key,
          effect_type: "active_label_tracking",
          payload_hash: "a".repeat(64),
          source_wms_shipment_item_id: null,
          package_key: "A",
          shipping_provider_label_id: null,
          quantity: null,
          payload: {},
          executable: false,
        }));
      }
      return [];
    };
    const repository = repositoryWith(client);

    const result = await repository.withSerializableTransaction(async (transaction) => ({
      entries: await transaction.loadPlanEntries("101"),
      intents: await transaction.loadPlanIntents("101"),
    }));

    expect(result.entries.map((entry) => entry.entryKey)).toEqual(["z", "ä"]);
    expect(result.intents.map((intent) => intent.intentKey)).toEqual(["z", "ä"]);
  });

  it.each([
    ["effect-intent insert", "INSERT INTO wms.package_allocation_effect_intents"],
    ["group compare-and-set", "UPDATE wms.package_allocation_groups"],
    ["forced deferred constraints", "SET CONSTRAINTS ALL IMMEDIATE"],
  ])("rolls back immediately when the %s fails", async (_name, failureQuery) => {
    const client = new FakeClient();
    client.handler = ({ text }) => {
      if (text.includes(failureQuery)) {
        throw Object.assign(new Error("injected append failure"), { code: "08006" });
      }
      if (text.includes("FROM wms.package_allocation_keys")) {
        return [{ allocation_key: "allocation:7001:A", source_id: "11" }];
      }
      if (text.includes("INSERT INTO wms.package_allocation_plans")) {
        return [{ id: "101" }];
      }
      if (text.includes("UPDATE wms.package_allocation_groups")) {
        return [{ current_version: 1 }];
      }
      return [];
    };
    const repository = repositoryWith(client);

    await expect(repository.withSerializableTransaction((transaction) => (
      transaction.appendPlan(appendPlanInput())
    ))).rejects.toMatchObject({
      name: "PackageAllocationLedgerRepositoryError",
      code: "DATABASE_ERROR",
      context: { postgresCode: "08006" },
    });

    const failureIndex = client.queries.findIndex((query) => query.text.includes(failureQuery));
    expect(failureIndex).toBeGreaterThan(-1);
    expect(client.queries.slice(failureIndex + 1).map((query) => query.text)).toEqual([
      "ROLLBACK",
    ]);
    expect(client.queries.map((query) => query.text)).not.toContain("COMMIT");
    expect(client.released).toBe(true);
  });
});

const repositorySource = readFileSync(
  join(process.cwd(), "server", "modules", "shipping", "package-allocation-ledger.repository.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("package allocation ledger SQL contract", () => {
  it("keeps allocation evidence inert and forces deferred checks before commit", () => {
    expect(repositorySource).toContain("row.payload, FALSE");
    expect(repositorySource).not.toContain("executable = TRUE");
    expect(repositorySource.indexOf("UPDATE wms.package_allocation_groups")).toBeLessThan(
      repositorySource.indexOf('this.client.query("SET CONSTRAINTS ALL IMMEDIATE")'),
    );
  });

  it("uses immutable package bindings without inferring provider-label identity", () => {
    expect(repositorySource).toContain("package_allocation_package_bindings");
    expect(repositorySource).toContain("package_allocation_package_binding_id");
    expect(repositorySource).toContain("NULL::bigint, row.intent_key");
    expect(repositorySource).not.toContain("reconcileProviderLabelLinks");
    expect(repositorySource).not.toContain("ShipStationService");
  });
});
