import { describe, expect, it, vi } from "vitest";

import type { HistoricalShipStationContentsClient } from "../../historical-shipstation-contents-audit.client";
import type { HistoricalShipStationContentsCandidate } from "../../historical-shipstation-contents-audit.repository";
import {
  HistoricalShipStationContentsAttestationService,
  HistoricalShipStationContentsAttestationServiceError,
} from "../../historical-shipstation-contents-attestation.service";
import type {
  HistoricalShipStationContentsAttestationRecord,
  HistoricalShipStationContentsAttestationRepository,
  HistoricalShipStationContentsAttestationTransaction,
} from "../../historical-shipstation-contents-attestation.repository";
import {
  historicalShipStationRecoverableCaseEvidenceHash,
  type HistoricalShipStationContentsRecoveryEvidence,
} from "../../historical-shipstation-contents-recovery.domain";

const candidate: HistoricalShipStationContentsCandidate = Object.freeze({
  shippingProviderLabelId: "51",
  providerShipmentId: 44_001,
  expectedContents: Object.freeze({
    kind: "available" as const,
    source: "legacy_wms_shipment" as const,
    lines: Object.freeze([
      Object.freeze({ wmsShipmentItemId: 7_001, sku: "SKU-A", quantity: 2 }),
    ]),
  }),
});

const recoveryEvidence: HistoricalShipStationContentsRecoveryEvidence = Object.freeze({
  contractVersion: 1,
  recoveryStatus: "provider_line_keys_authoritative",
  evidenceHash: "a".repeat(64),
  attestedContents: Object.freeze([
    Object.freeze({ wmsShipmentItemId: 7_001, quantity: 2 }),
  ]),
});

const expectedPreviewEvidenceHash = historicalShipStationRecoverableCaseEvidenceHash({
  shippingProviderLabelId: candidate.shippingProviderLabelId,
  recoveryStatus: recoveryEvidence.recoveryStatus,
  providerEvidenceHash: recoveryEvidence.evidenceHash,
});

function providerClient(
  details: HistoricalShipStationContentsRecoveryEvidence | null = recoveryEvidence,
): HistoricalShipStationContentsClient {
  return {
    loadShipmentContents: vi.fn(async () => Object.freeze({
      kind: "found" as const,
      evidence: Object.freeze({
        status: details === null ? "empty" as const : "authoritative" as const,
        recoveryStatus: details?.recoveryStatus ?? "provider_empty" as const,
        providerItemCount: details === null ? 0 : 1,
        recognizedProviderItemCount: details === null ? 0 : 1,
        canonicalLineCount: details === null ? 0 : 1,
        malformedItemCount: 0,
        unrecognizedItemCount: 0,
        duplicateLineItemCount: 0,
        recoveryEvidence: details === null ? null : Object.freeze({
          contractVersion: details.contractVersion,
          evidenceHash: details.evidenceHash,
          attestedLineCount: details.attestedContents.length,
        }),
      }),
      recoveryEvidenceDetails: details,
    })),
  };
}

function repository(input: Readonly<{
  readonly snapshot?: HistoricalShipStationContentsCandidate | null;
  readonly locked?: HistoricalShipStationContentsCandidate | null;
  readonly actorAuthorized?: boolean;
  readonly eventIds?: readonly string[];
}> = {}) {
  let appended: HistoricalShipStationContentsAttestationRecord | null = null;
  const appendExactAttestation = vi.fn(async (record: HistoricalShipStationContentsAttestationRecord) => {
    appended = record;
    return Object.freeze({
      kind: "created" as const,
      attestationId: "901",
      shippingProviderLabelId: record.shippingProviderLabelId,
      previewEvidenceHash: record.previewEvidenceHash,
      resolvedEventCount: record.resolvedLabelEventIds.length,
    });
  });
  const transaction: HistoricalShipStationContentsAttestationTransaction = {
    lockAuthorizedActor: vi.fn(async () => input.actorAuthorized === false
      ? null
      : Object.freeze({ userId: "lead-user-1", role: "lead" as const })),
    loadCandidateForUpdate: vi.fn(async () => input.locked === undefined ? candidate : input.locked),
    loadResolvableLabelEventIds: vi.fn(async () => input.eventIds ?? Object.freeze(["71", "72"])),
    appendExactAttestation,
  };
  const value: HistoricalShipStationContentsAttestationRepository = {
    loadCandidateSnapshot: vi.fn(async () => input.snapshot === undefined ? candidate : input.snapshot),
    withSerializableTransaction: vi.fn(async (work) => work(transaction)),
  };
  return { value, transaction, appendExactAttestation, appended: () => appended };
}

const command = Object.freeze({
  shippingProviderLabelId: candidate.shippingProviderLabelId,
  expectedPreviewEvidenceHash,
  authenticatedActorUserId: "lead-user-1",
  reason: "Reviewed the exact historical ShipStation package contents",
});

describe("historical ShipStation contents lead attestation", () => {
  it("returns the exact immutable recoverable preview without opening a write transaction", async () => {
    const persistence = repository();
    const client = providerClient();
    const service = new HistoricalShipStationContentsAttestationService(persistence.value, client);

    const preview = await service.preview(candidate.shippingProviderLabelId);

    expect(preview).toEqual({
      shippingProviderLabelId: "51",
      providerShipmentId: 44_001,
      providerContentsStatus: "authoritative",
      recoveryStatus: "provider_line_keys_authoritative",
      previewEvidenceHash: expectedPreviewEvidenceHash,
      providerEvidenceHash: "a".repeat(64),
      expectedContents: candidate.expectedContents,
      attestedContents: recoveryEvidence.attestedContents,
    });
    expect(Object.isFrozen(preview)).toBe(true);
    expect(client.loadShipmentContents).toHaveBeenCalledWith(
      candidate.providerShipmentId,
      candidate.expectedContents,
    );
    expect(persistence.value.withSerializableTransaction).not.toHaveBeenCalled();
  });

  it("rejects invalid preview identifiers without querying the repository", async () => {
    const persistence = repository();
    const service = new HistoricalShipStationContentsAttestationService(
      persistence.value,
      providerClient(),
    );

    const promise = service.preview("0");

    await expect(promise).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    expect(persistence.value.loadCandidateSnapshot).not.toHaveBeenCalled();
  });

  it("revalidates the preview and appends exact lead, reason, contents, and resolution evidence", async () => {
    const persistence = repository();
    const client = providerClient();
    const service = new HistoricalShipStationContentsAttestationService(persistence.value, client);

    await expect(service.attest(command)).resolves.toEqual({
      kind: "created",
      attestationId: "901",
      shippingProviderLabelId: "51",
      previewEvidenceHash: expectedPreviewEvidenceHash,
      resolvedEventCount: 2,
    });

    expect(client.loadShipmentContents).toHaveBeenCalledWith(
      candidate.providerShipmentId,
      candidate.expectedContents,
    );
    expect(persistence.appendExactAttestation).toHaveBeenCalledTimes(1);
    expect(persistence.appended()).toMatchObject({
      shippingProviderLabelId: "51",
      recoveryEvidence,
      previewEvidenceHash: expectedPreviewEvidenceHash,
      actor: { userId: "lead-user-1", role: "lead" },
      reason: command.reason,
      resolvedLabelEventIds: ["71", "72"],
      attestationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("rejects a stale preview fingerprint before opening a write transaction", async () => {
    const persistence = repository();
    const service = new HistoricalShipStationContentsAttestationService(
      persistence.value,
      providerClient(),
    );

    const promise = service.attest({ ...command, expectedPreviewEvidenceHash: "b".repeat(64) });
    await expect(promise).rejects.toMatchObject({ code: "PREVIEW_EVIDENCE_MISMATCH" });
    expect(persistence.value.withSerializableTransaction).not.toHaveBeenCalled();
  });

  it("fails closed when the authenticated account is not an active lead or administrator", async () => {
    const persistence = repository({ actorAuthorized: false });
    const service = new HistoricalShipStationContentsAttestationService(
      persistence.value,
      providerClient(),
    );

    await expect(service.attest(command)).rejects.toMatchObject({
      code: "LEAD_AUTHORIZATION_REQUIRED",
    });
    expect(persistence.appendExactAttestation).not.toHaveBeenCalled();
  });

  it("rejects changed WMS lineage and an empty resolution set inside the transaction", async () => {
    const changed = Object.freeze({
      ...candidate,
      expectedContents: Object.freeze({
        ...candidate.expectedContents,
        lines: Object.freeze([
          Object.freeze({ wmsShipmentItemId: 7_001, sku: "SKU-A", quantity: 3 }),
        ]),
      }),
    });
    const changedPersistence = repository({ locked: changed });
    await expect(new HistoricalShipStationContentsAttestationService(
      changedPersistence.value,
      providerClient(),
    ).attest(command)).rejects.toMatchObject({ code: "CANDIDATE_CHANGED" });

    const emptyPersistence = repository({ eventIds: [] });
    await expect(new HistoricalShipStationContentsAttestationService(
      emptyPersistence.value,
      providerClient(),
    ).attest(command)).rejects.toMatchObject({ code: "NO_RESOLVABLE_EVENTS" });
  });


  it("rejects inconsistent provider recovery details before opening a write transaction", async () => {
    const persistence = repository();
    const inconsistentClient: HistoricalShipStationContentsClient = {
      async loadShipmentContents() {
        return Object.freeze({
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
              contractVersion: recoveryEvidence.contractVersion,
              evidenceHash: "b".repeat(64),
              attestedLineCount: recoveryEvidence.attestedContents.length,
            }),
          }),
          recoveryEvidenceDetails: recoveryEvidence,
        });
      },
    };

    await expect(new HistoricalShipStationContentsAttestationService(
      persistence.value,
      inconsistentClient,
    ).attest(command)).rejects.toMatchObject({
      code: "PROVIDER_EVIDENCE_NOT_RECOVERABLE",
    });
    expect(persistence.value.withSerializableTransaction).not.toHaveBeenCalled();
  });

  it("rejects nonrecoverable provider evidence and sanitizes validation failures", async () => {
    const persistence = repository();
    await expect(new HistoricalShipStationContentsAttestationService(
      persistence.value,
      providerClient(null),
    ).attest(command)).rejects.toMatchObject({ code: "PROVIDER_EVIDENCE_NOT_RECOVERABLE" });

    const sentinel = "SECRET-INVALID-REASON";
    const promise = new HistoricalShipStationContentsAttestationService(
      persistence.value,
      providerClient(),
    ).attest({ ...command, reason: ` ${sentinel} ` });
    await expect(promise).rejects.toBeInstanceOf(HistoricalShipStationContentsAttestationServiceError);
    await promise.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain(sentinel);
    });
  });
});
