import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "@shared/utils/canonical-json";

import { SHIPSTATION_LABEL_OBSERVATION_SOURCE } from "../../carrier-tracking.domain";
import type { PersistedDeclaredPackageEvidence } from "../../declared-package-lifecycle-shadow.domain";
import {
  PackageAllocationAuthorityReadinessService,
  PackageAllocationAuthorityReadinessServiceError,
  type PackageAllocationAuthorityReadinessCommand,
} from "../../package-allocation-authority-readiness.service";
import {
  PackageAllocationLedgerRepositoryError,
  PgPackageAllocationLedgerRepository,
  type LockedPackageAllocationAuthorityEvidence,
  type PackageAllocationLedgerRepository,
  type PackageAllocationLedgerTransaction,
} from "../../package-allocation-ledger.repository";
import type { PackageAllocationSourceFacts } from "../../package-allocation-source-identity.domain";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceFacts(id: number): PackageAllocationSourceFacts {
  return Object.freeze({
    sourceWmsShipmentItemId: id,
    shipmentRequestItemId: String(90_000 + id),
    sourceQuantity: 2,
    shipmentItemPurpose: "customer_fulfillment",
    orderItemId: 80_000 + id,
    replacementForOrderItemId: null,
    correctionForShipmentItemId: null,
    productVariantId: 70_000 + id,
    orderItemSku: `SKU-${id}`,
    replacementOrderItemSku: null,
    productVariantSku: `SKU-${id}`,
  });
}

function labelPayload(providerLabelId: string, sourceId: number) {
  return {
    payloadSchemaVersion: 2 as const,
    providerLabelId,
    trackingNumber: "1Z999AA10123456784",
    observationSource: SHIPSTATION_LABEL_OBSERVATION_SOURCE,
    sourceObservationHash: "a".repeat(64),
    createDate: null,
    shipDate: null,
    voidDate: null,
    isReturnLabel: false,
    declaredContentsEvidence: {
      evidenceSchemaVersion: 1 as const,
      status: "authoritative" as const,
      providerItemCount: 1,
      recognizedProviderItemCount: 1,
      canonicalLineCount: 1,
      malformedItemCount: 0,
      unrecognizedItemCount: 0,
      duplicateLineItemCount: 0,
      rejectedItemCount: 0,
      reviewRequired: false,
      lines: [{ lineItemKey: `wms-item-${sourceId}`, quantity: 2 }],
    },
  };
}

function persistedPackage(
  shippingProviderLabelId = 42,
  sourceId = 7_001,
): PersistedDeclaredPackageEvidence {
  const providerPhysicalShipmentId = "44001";
  const payload = labelPayload(providerPhysicalShipmentId, sourceId);
  return Object.freeze({
    shippingProviderLabelId,
    provider: "shipstation",
    providerPhysicalShipmentId,
    currentTrackingNumber: payload.trackingNumber,
    currentLabelStatus: "active",
    firstObservedAt: "2026-08-23T12:00:01.000Z",
    lastObservedAt: "2026-08-23T12:00:01.000Z",
    labelDirection: "outbound",
    labelEvents: Object.freeze([
      Object.freeze({
        id: 501,
        shippingProviderLabelId,
        eventHash: sha256(
          canonicalJson({
            provider: "shipstation",
            ...payload,
            labelStatus: "active",
          }),
        ),
        eventType: "label_observed",
        labelStatus: "active",
        trackingNumber: payload.trackingNumber,
        providerOccurredAt: "2026-08-23T12:00:00.000Z",
        sanitizedPayload: payload,
        receivedAt: "2026-08-23T12:00:01.000Z",
      }),
    ]),
    confirmedCarrierEvents: Object.freeze([]),
  });
}

function command(): PackageAllocationAuthorityReadinessCommand {
  return {
    contractVersion: 1,
    authorityMode: "shadow_only",
    sourceWmsShipmentItemIds: [7_002, 7_001],
    shippingProviderLabelIds: [42],
  };
}

describe("PackageAllocationAuthorityReadinessService", () => {
  it("loads locked evidence canonically and remains review-only", async () => {
    const calls: string[] = [];
    const transaction = {
      lockSourceFacts: async (ids: readonly number[]) => {
        calls.push(`sources:${ids.join(",")}`);
        return ids.map(sourceFacts);
      },
      lockAuthorityReadinessPackages: async (ids: readonly number[]) => {
        calls.push(`labels:${ids.join(",")}`);
        return Object.freeze([
          Object.freeze({
            evidenceKey: "shipping-provider-label:42",
            persistedEvidence: persistedPackage(),
          }),
        ]);
      },
    } as unknown as PackageAllocationLedgerTransaction;
    const repository: PackageAllocationLedgerRepository = {
      withSerializableTransaction: async (work) => {
        calls.push("transaction");
        return work(transaction);
      },
    };

    const result = await new PackageAllocationAuthorityReadinessService(
      repository,
    ).assess(command());

    expect(calls).toEqual(["transaction", "sources:7001,7002", "labels:42"]);
    expect(result).toMatchObject({
      contractVersion: 1,
      authority: "none",
      outcome: "review",
      plannerInput: null,
      packageAssessments: [
        {
          lifecycleStatus: "projected",
          candidateSourceStatus: "within_candidate_sources",
          authoritativeContents: [{ wmsShipmentItemId: 7_001, quantity: 2 }],
        },
      ],
    });
    expect(result.reviews.map((review) => review.code)).toEqual([
      "allocation_role_policy_unresolved",
      "package_membership_policy_unresolved",
      "physical_consumption_authority_policy_unresolved",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects duplicate identities before opening a transaction", async () => {
    let transactionCalls = 0;
    const repository: PackageAllocationLedgerRepository = {
      withSerializableTransaction: async () => {
        transactionCalls += 1;
        throw new Error("must not run");
      },
    };
    const service = new PackageAllocationAuthorityReadinessService(repository);

    await expect(
      service.assess({
        ...command(),
        shippingProviderLabelIds: [42, 42],
      }),
    ).rejects.toMatchObject({
      code: "DUPLICATE_SHIPPING_PROVIDER_LABEL_ID",
      context: { shippingProviderLabelId: 42 },
    });
    await expect(
      service.assess({
        ...command(),
        sourceWmsShipmentItemIds: [7_001, 7_001],
      }),
    ).rejects.toMatchObject({
      code: "DUPLICATE_SOURCE_WMS_SHIPMENT_ITEM_ID",
      context: { sourceWmsShipmentItemId: 7_001 },
    });
    expect(transactionCalls).toBe(0);
  });

  it("sanitizes invalid command details and never echoes rejected literals", async () => {
    const sentinel = "ROOT_AUTHORITY_SENTINEL";
    const service = new PackageAllocationAuthorityReadinessService({
      withSerializableTransaction: async () => {
        throw new Error("must not run");
      },
    });
    let error: unknown;
    try {
      await service.assess({
        ...command(),
        authorityMode: sentinel,
      } as unknown as PackageAllocationAuthorityReadinessCommand);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(
      PackageAllocationAuthorityReadinessServiceError,
    );
    expect(error).toMatchObject({
      code: "INVALID_AUTHORITY_READINESS_COMMAND",
    });
    expect(
      JSON.stringify(
        (error as PackageAllocationAuthorityReadinessServiceError).context,
      ),
    ).not.toContain(sentinel);
  });
});

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

class FakeClient {
  readonly queries: RecordedQuery[] = [];
  handler: (query: RecordedQuery) => readonly Record<string, unknown>[] =
    () => [];

  async query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<any>> {
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

  release(): void {}
}

function repositoryWith(
  client: FakeClient,
): PgPackageAllocationLedgerRepository {
  const pool = {
    connect: async () => client as unknown as PoolClient,
  } as Pick<Pool, "connect">;
  return new PgPackageAllocationLedgerRepository(pool);
}

function labelRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    shipping_provider_label_id: "42",
    provider: "shipstation",
    provider_label_id: "44_001",
    tracking_number: "1Z-READINESS-42",
    label_status: "active",
    label_direction: "outbound",
    first_observed_at: new Date("2026-08-23T12:00:00.000Z"),
    last_observed_at: new Date("2026-08-23T12:00:01.000Z"),
    label_event_count: "1",
    label_event_payload_bytes: "512",
    max_event_payload_bytes: "512",
    ...overrides,
  };
}

describe("PgPackageAllocationLedgerRepository authority evidence", () => {
  it("locks labels and maps complete bounded event and carrier evidence", async () => {
    const client = new FakeClient();
    client.handler = ({ text }) => {
      if (text.includes("WITH locked_labels AS MATERIALIZED"))
        return [labelRow()];
      if (text.includes("event.id::text AS label_event_id")) {
        return [
          {
            label_event_id: "501",
            shipping_provider_label_id: "42",
            event_hash: "b".repeat(64),
            event_type: "label_observed",
            label_status: "active",
            tracking_number: "1Z-READINESS-42",
            provider_occurred_at: new Date("2026-08-23T12:00:00.000Z"),
            received_at: new Date("2026-08-23T12:00:01.000Z"),
            sanitized_payload: { payloadSchemaVersion: 2 },
          },
        ];
      }
      if (text.includes("FROM wms.carrier_tracking_reconciliation_state")) {
        return [
          {
            carrier_tracking_event_id: "601",
            shipping_provider_label_id: "42",
            dispatch_evidence: "confirmed",
            match_status: "matched",
            event_occurred_at: new Date("2026-08-23T13:00:00.000Z"),
            received_at: new Date("2026-08-23T13:00:01.000Z"),
          },
        ];
      }
      return [];
    };
    const repository = repositoryWith(client);

    const evidence = await repository.withSerializableTransaction(
      (transaction) => transaction.lockAuthorityReadinessPackages([42]),
    );

    expect(evidence).toEqual([
      {
        evidenceKey: "shipping-provider-label:42",
        persistedEvidence: {
          shippingProviderLabelId: 42,
          provider: "shipstation",
          providerPhysicalShipmentId: "44_001",
          currentTrackingNumber: "1Z-READINESS-42",
          currentLabelStatus: "active",
          firstObservedAt: "2026-08-23T12:00:00.000Z",
          lastObservedAt: "2026-08-23T12:00:01.000Z",
          labelDirection: "outbound",
          labelEvents: [
            {
              id: 501,
              shippingProviderLabelId: 42,
              eventHash: "b".repeat(64),
              eventType: "label_observed",
              labelStatus: "active",
              trackingNumber: "1Z-READINESS-42",
              providerOccurredAt: "2026-08-23T12:00:00.000Z",
              sanitizedPayload: { payloadSchemaVersion: 2 },
              receivedAt: "2026-08-23T12:00:01.000Z",
            },
          ],
          confirmedCarrierEvents: [
            {
              id: 601,
              shippingProviderLabelId: 42,
              dispatchEvidence: "confirmed",
              currentMatchStatus: "matched",
              eventOccurredAt: "2026-08-23T13:00:00.000Z",
              receivedAt: "2026-08-23T13:00:01.000Z",
            },
          ],
        },
      },
    ]);
    expect(
      client.queries.find(
        (query) =>
          query.text === "SELECT pg_advisory_xact_lock($1, $2)" &&
          query.values[0] === 918_422,
      )?.values,
    ).toEqual([918_422, 42]);
    expect(
      client.queries.find((query) =>
        query.text.includes("WITH locked_labels AS MATERIALIZED"),
      )?.text,
    ).toContain("FOR UPDATE");
    expect(
      client.queries.find((query) =>
        query.text.includes("FROM wms.carrier_tracking_reconciliation_state"),
      )?.text,
    ).toContain("FOR KEY SHARE OF reconciliation_state, match, carrier_event");
    expect(Object.isFrozen(evidence[0].persistedEvidence.labelEvents)).toBe(
      true,
    );
  });

  it("fails before loading payload JSON when event history exceeds the row bound", async () => {
    const client = new FakeClient();
    client.handler = ({ text }) =>
      text.includes("WITH locked_labels AS MATERIALIZED")
        ? [labelRow({ label_event_count: "5001" })]
        : [];
    const repository = repositoryWith(client);

    await expect(
      repository.withSerializableTransaction((transaction) =>
        transaction.lockAuthorityReadinessPackages([42]),
      ),
    ).rejects.toBeInstanceOf(PackageAllocationLedgerRepositoryError);
    expect(
      client.queries.some((query) =>
        query.text.includes("event.id::text AS label_event_id"),
      ),
    ).toBe(false);
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("reports every missing locked label deterministically", async () => {
    const client = new FakeClient();
    const repository = repositoryWith(client);

    await expect(
      repository.withSerializableTransaction((transaction) =>
        transaction.lockAuthorityReadinessPackages([43, 42]),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_DATABASE_EVIDENCE",
      context: { missingShippingProviderLabelIds: [42, 43] },
    });
  });
});
