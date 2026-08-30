import { describe, expect, it, vi } from "vitest";

import type { HistoricalShipStationContentsClient } from "../../historical-shipstation-contents-audit.client";
import type {
  HistoricalShipStationContentsRecoveryEvidence,
  HistoricalShipStationContentsSystemRecoveryEvent,
} from "../../historical-shipstation-contents-recovery.domain";
import type {
  HistoricalShipStationContentsSystemRecoveryCandidate,
  HistoricalShipStationContentsSystemRecoveryRepository,
  HistoricalShipStationContentsSystemRecoveryTransaction,
} from "../../historical-shipstation-contents-system-recovery.repository";
import {
  HistoricalShipStationContentsSystemRecoveryService,
  HistoricalShipStationContentsSystemRecoveryServiceError,
} from "../../historical-shipstation-contents-system-recovery.service";

const candidate: HistoricalShipStationContentsSystemRecoveryCandidate = Object.freeze({
  shippingProviderLabelId: "41",
  providerShipmentId: 44_001,
  trackingNumber: "1Z999AA10123456784",
  labelStatus: "active",
  expectedContents: Object.freeze({
    kind: "available" as const,
    source: "physical_shipment" as const,
    lines: Object.freeze([
      Object.freeze({ wmsShipmentItemId: 7001, sku: "SKU-A", quantity: 2 }),
    ]),
  }),
});

const recoveryEvidence: HistoricalShipStationContentsRecoveryEvidence = Object.freeze({
  contractVersion: 1,
  recoveryStatus: "provider_line_keys_authoritative",
  evidenceHash: "e".repeat(64),
  attestedContents: Object.freeze([
    Object.freeze({ wmsShipmentItemId: 7001, quantity: 2 }),
  ]),
});

function providerClient(): HistoricalShipStationContentsClient {
  return {
    loadShipmentContents: vi.fn(async () => Object.freeze({
      kind: "found" as const,
      evidence: Object.freeze({
        status: "authoritative" as const,
        recoveryStatus: recoveryEvidence.recoveryStatus,
        providerItemCount: 1,
        recognizedProviderItemCount: 1,
        canonicalLineCount: 1,
        malformedItemCount: 0,
        unrecognizedItemCount: 0,
        duplicateLineItemCount: 0,
        recoveryEvidence: Object.freeze({
          contractVersion: 1 as const,
          evidenceHash: recoveryEvidence.evidenceHash,
          attestedLineCount: 1,
        }),
      }),
      recoveryEvidenceDetails: recoveryEvidence,
    })),
  };
}

function dependencies(overrides: Readonly<{
  candidate?: HistoricalShipStationContentsSystemRecoveryCandidate | null;
  lockedCandidate?: HistoricalShipStationContentsSystemRecoveryCandidate | null;
  resolvedLabelEventIds?: readonly number[];
}> = {}) {
  const appendExactRecovery = vi.fn(async (
    _labelId: string,
    event: HistoricalShipStationContentsSystemRecoveryEvent,
  ) => Object.freeze({
    kind: "created" as const,
    shippingProviderLabelId: "41",
    labelEventId: "102",
    eventHash: event.eventHash,
  }));
  const transaction: HistoricalShipStationContentsSystemRecoveryTransaction = {
    loadCandidateForUpdate: vi.fn(async () => (
      overrides.lockedCandidate === undefined ? candidate : overrides.lockedCandidate
    )),
    loadResolvableLabelEventIds: vi.fn(async () => (
      overrides.resolvedLabelEventIds ?? Object.freeze([101])
    )),
    appendExactRecovery,
  };
  const repository: HistoricalShipStationContentsSystemRecoveryRepository = {
    loadSnapshot: vi.fn(async () => {
      const loadedCandidate = overrides.candidate === undefined ? candidate : overrides.candidate;
      if (loadedCandidate === null) return null;
      return Object.freeze({ candidate: loadedCandidate });
    }),
    withSerializableTransaction: vi.fn(async (work) => work(transaction)),
  };
  return { repository, transaction, appendExactRecovery };
}

describe("HistoricalShipStationContentsSystemRecoveryService", () => {
  it("rechecks the candidate under lock and appends deterministic evidence", async () => {
    const { repository, transaction, appendExactRecovery } = dependencies();
    const client = providerClient();
    const service = new HistoricalShipStationContentsSystemRecoveryService(repository, client);

    await expect(service.recover("41")).resolves.toMatchObject({
      kind: "created",
      shippingProviderLabelId: "41",
      labelEventId: "102",
      eventHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(client.loadShipmentContents).toHaveBeenCalledWith(
      44_001,
      candidate.expectedContents,
    );
    expect(transaction.loadCandidateForUpdate).toHaveBeenCalledWith("41");
    expect(transaction.loadResolvableLabelEventIds).toHaveBeenCalledWith("41");
    expect(appendExactRecovery).toHaveBeenCalledTimes(1);
    expect(appendExactRecovery.mock.calls[0]?.[1]).toMatchObject({
      eventType: "contents_recovered",
      labelStatus: "active",
      trackingNumber: candidate.trackingNumber,
      providerOccurredAt: null,
      sanitizedPayload: {
        providerLabelId: "44001",
        resolvedLabelEventIds: [101],
        declaredContentsEvidence: {
          status: "authoritative",
          lines: [{ lineItemKey: "wms-item-7001", quantity: 2 }],
        },
      },
    });
  });

  it("rolls back logically when locked lineage differs from the provider snapshot", async () => {
    const { repository, appendExactRecovery } = dependencies({
      lockedCandidate: Object.freeze({
        ...candidate,
        expectedContents: Object.freeze({
          kind: "unavailable" as const,
          reason: "ambiguous_linked_package" as const,
        }),
      }),
    });
    const service = new HistoricalShipStationContentsSystemRecoveryService(
      repository,
      providerClient(),
    );

    await expect(service.recover("41")).rejects.toMatchObject({
      code: "CANDIDATE_CHANGED",
    });
    expect(appendExactRecovery).not.toHaveBeenCalled();
  });

  it("keeps non-recoverable provider evidence out of the write transaction", async () => {
    const { repository } = dependencies();
    const client: HistoricalShipStationContentsClient = {
      loadShipmentContents: vi.fn(async () => Object.freeze({
        kind: "found" as const,
        evidence: Object.freeze({
          status: "empty" as const,
          recoveryStatus: "provider_empty" as const,
          providerItemCount: 0,
          recognizedProviderItemCount: 0,
          canonicalLineCount: 0,
          malformedItemCount: 0,
          unrecognizedItemCount: 0,
          duplicateLineItemCount: 0,
          recoveryEvidence: null,
        }),
        recoveryEvidenceDetails: null,
      })),
    };
    const service = new HistoricalShipStationContentsSystemRecoveryService(repository, client);

    await expect(service.recover("41")).rejects.toMatchObject({
      code: "PROVIDER_EVIDENCE_NOT_RECOVERABLE",
    });
    expect(repository.withSerializableTransaction).not.toHaveBeenCalled();
  });

  it("fails before provider I/O for invalid or missing candidates", async () => {
    const missing = dependencies({ candidate: null });
    const client = providerClient();
    const service = new HistoricalShipStationContentsSystemRecoveryService(
      missing.repository,
      client,
    );

    await expect(service.recover("not-a-label")).rejects.toBeInstanceOf(
      HistoricalShipStationContentsSystemRecoveryServiceError,
    );
    await expect(service.recover("41")).rejects.toMatchObject({ code: "CANDIDATE_NOT_FOUND" });
    expect(client.loadShipmentContents).not.toHaveBeenCalled();
  });

  it("requires at least one exact historical event reference", async () => {
    const { repository, appendExactRecovery } = dependencies({ resolvedLabelEventIds: [] });
    const service = new HistoricalShipStationContentsSystemRecoveryService(
      repository,
      providerClient(),
    );

    await expect(service.recover("41")).rejects.toMatchObject({ code: "NO_RESOLVABLE_EVENTS" });
    expect(appendExactRecovery).not.toHaveBeenCalled();
  });
});
