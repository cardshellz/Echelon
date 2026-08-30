import { describe, expect, it } from "vitest";

import {
  DeclaredPackageLifecycleError,
  projectDeclaredPackageLifecycle,
  type DeclaredPackageLifecycleEvent,
  type DeclaredPackageLifecycleInput,
} from "../../declared-package-lifecycle.domain";

const labelObservedAt = "2026-08-20T14:00:00.000Z";
const labelProviderOccurredAt = "2026-08-20T13:59:50.000Z";
const voidObservedAt = "2026-08-20T14:05:01.000Z";
const voidProviderOccurredAt = "2026-08-20T14:05:00.000Z";
const possessionObservedAt = "2026-08-20T14:10:01.000Z";
const possessionProviderOccurredAt = "2026-08-20T14:10:00.000Z";
const labelObservationEventKey = "shipstation:shipment:44001:observed";

function observedLabel(
  overrides: Partial<Extract<DeclaredPackageLifecycleEvent, {
    kind: "outbound_label_observed";
  }>> = {},
): Extract<DeclaredPackageLifecycleEvent, { kind: "outbound_label_observed" }> {
  return {
    kind: "outbound_label_observed",
    eventKey: labelObservationEventKey,
    observedAt: labelObservedAt,
    providerOccurredAt: null,
    trackingNumber: "1Z999AA10123456784",
    contentsEvidence: {
      status: "authoritative",
      lines: [
        { wmsShipmentItemId: 7001, quantity: 2 },
        { wmsShipmentItemId: 7002, quantity: 1 },
      ],
    },
    ...overrides,
  };
}

function voidedLabel(
  overrides: Partial<Extract<DeclaredPackageLifecycleEvent, {
    kind: "outbound_label_voided";
  }>> = {},
): Extract<DeclaredPackageLifecycleEvent, { kind: "outbound_label_voided" }> {
  return {
    kind: "outbound_label_voided",
    eventKey: "shipstation:shipment:44001:voided",
    observedAt: voidObservedAt,
    providerOccurredAt: voidProviderOccurredAt,
    ...overrides,
  };
}

function carrierPossession(
  overrides: Partial<Extract<DeclaredPackageLifecycleEvent, {
    kind: "carrier_possession_confirmed";
  }>> = {},
): Extract<DeclaredPackageLifecycleEvent, { kind: "carrier_possession_confirmed" }> {
  return {
    kind: "carrier_possession_confirmed",
    eventKey: "shipstation:tracking:991",
    observedAt: possessionObservedAt,
    providerOccurredAt: possessionProviderOccurredAt,
    carrierTrackingEventId: 991,
    ...overrides,
  };
}

function contentsAttestation(
  overrides: Partial<Extract<DeclaredPackageLifecycleEvent, {
    kind: "package_contents_attested";
  }>> = {},
): Extract<DeclaredPackageLifecycleEvent, { kind: "package_contents_attested" }> {
  return {
    kind: "package_contents_attested",
    eventKey: "echelon:lead-attestation:51",
    observedAt: "2026-08-20T14:20:00.000Z",
    authorization: "lead_approved",
    actor: "lead:51",
    reason: "manual contents verification",
    resolvesEventKeys: [labelObservationEventKey],
    contents: [{ wmsShipmentItemId: 7001, quantity: 2 }],
    ...overrides,
  };
}

function lifecycle(
  events: DeclaredPackageLifecycleEvent[],
  overrides: Partial<DeclaredPackageLifecycleInput> = {},
): DeclaredPackageLifecycleInput {
  return {
    provider: "shipstation",
    providerPhysicalShipmentId: "44001",
    events,
    ...overrides,
  };
}

describe("projectDeclaredPackageLifecycle", () => {
  it("recognizes a contented observed label as business-shipped before carrier possession", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel({ providerOccurredAt: labelProviderOccurredAt }),
    ]));

    expect(state).toMatchObject({
      labelStatus: "active",
      labelProviderOccurredAt,
      labelFirstObservedAt: labelObservedAt,
      contentsStatus: "authoritative",
      observedContentsEvidenceStatuses: ["authoritative"],
      activeContentsEvidenceStatuses: ["authoritative"],
      businessStatus: "shipped",
      businessShipmentRecognizedAt: labelObservedAt,
      businessShipmentProviderOccurredAt: labelProviderOccurredAt,
      currentAutomationAuthority: true,
      reconciliationStatus: "clear",
      correctionStatus: "open",
      carrierStatus: "not_confirmed",
      disposition: "not_dispatched",
      commercialFulfillmentPostingEligible: true,
      inventoryPostingEligible: true,
      activeTrackingProjectionEligible: true,
      voidTrackingProjectionRequired: false,
      carrierTrackingProjectionRequired: false,
      notificationCandidateEligible: true,
      notificationProjectionReconciliationRequired: false,
      reviewReasons: [],
    });
  });

  it("treats a same-tracking reprint as evidence without changing operational state", () => {
    const before = projectDeclaredPackageLifecycle(lifecycle([observedLabel()]));
    const after = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel(),
      {
        kind: "outbound_label_reprinted",
        eventKey: "shipstation:shipment:44001:reprint:2",
        observedAt: "2026-08-20T14:01:00.000Z",
        providerOccurredAt: null,
        trackingNumber: "1Z999AA10123456784",
      },
    ]));

    expect(after).toMatchObject({
      trackingNumber: before.trackingNumber,
      labelStatus: "active",
      businessStatus: before.businessStatus,
      businessShipmentRecognizedAt: before.businessShipmentRecognizedAt,
      currentAutomationAuthority: true,
      correctionStatus: "open",
      commercialFulfillmentPostingEligible: true,
      inventoryPostingEligible: true,
      appliedEventCount: 2,
    });
    expect(after.authoritativeContents).toEqual(before.authoritativeContents);
    expect(after.stateHash).toBe(before.stateHash);
    expect(after.evidenceHash).not.toBe(before.evidenceHash);
  });

  it("quarantines an orphan reprint without inventing a label observation", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([{
      kind: "outbound_label_reprinted",
      eventKey: "shipstation:shipment:44001:reprint:orphan",
      observedAt: "2026-08-20T14:01:00.000Z",
      providerOccurredAt: null,
      trackingNumber: "1Z999AA10123456784",
    }]));

    expect(state).toMatchObject({
      labelStatus: "unknown",
      businessStatus: "not_shipped",
      currentAutomationAuthority: false,
      reconciliationStatus: "review",
      correctionStatus: "unavailable",
      commercialFulfillmentPostingEligible: false,
      inventoryPostingEligible: false,
      notificationCandidateEligible: false,
      notificationProjectionReconciliationRequired: false,
      reviewReasons: ["reprint_without_label_observation"],
    });
  });

  it("clears the orphan-reprint review when an out-of-order label observation exists", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      {
        kind: "outbound_label_reprinted",
        eventKey: "shipstation:shipment:44001:reprint:early",
        observedAt: "2026-08-20T13:59:00.000Z",
        providerOccurredAt: null,
        trackingNumber: "1Z999AA10123456784",
      },
      observedLabel(),
    ]));

    expect(state).toMatchObject({
      labelStatus: "active",
      businessStatus: "shipped",
      currentAutomationAuthority: true,
      reconciliationStatus: "clear",
      reviewReasons: [],
    });
  });
  it("records omitted label contents for review without inventing authority", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel({ contentsEvidence: { status: "omitted" } }),
    ]));

    expect(state).toMatchObject({
      labelStatus: "active",
      contentsStatus: "unknown",
      observedContentsEvidenceStatuses: ["omitted"],
      activeContentsEvidenceStatuses: ["omitted"],
      businessStatus: "shipped",
      businessShipmentRecognizedAt: labelObservedAt,
      currentAutomationAuthority: false,
      reconciliationStatus: "review",
      correctionStatus: "review",
      commercialFulfillmentPostingEligible: false,
      inventoryPostingEligible: false,
      activeTrackingProjectionEligible: false,
      notificationCandidateEligible: false,
      notificationProjectionReconciliationRequired: true,
      reviewReasons: ["package_contents_omitted"],
    });
  });

  it.each([
    ["empty", { status: "empty" }, "package_contents_empty"],
    ["unrecognized", { status: "unrecognized" }, "package_contents_unrecognized"],
    ["malformed", { status: "malformed" }, "package_contents_malformed"],
    [
      "mixed",
      {
        status: "mixed",
        recognizedLines: [{ wmsShipmentItemId: 7001, quantity: 1 }],
      },
      "package_contents_mixed",
    ],
  ] as const)("keeps %s provider contents distinct and non-authoritative", (
    _caseName,
    contentsEvidence,
    reviewReason,
  ) => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel({ contentsEvidence }),
    ]));

    expect(state.observedContentsEvidenceStatuses).toEqual([contentsEvidence.status]);
    expect(state.activeContentsEvidenceStatuses).toEqual([contentsEvidence.status]);
    expect(state.businessStatus).toBe("shipped");
    expect(state.businessShipmentRecognizedAt).toBe(labelObservedAt);
    expect(state.currentAutomationAuthority).toBe(false);
    expect(state.commercialFulfillmentPostingEligible).toBe(false);
    expect(state.inventoryPostingEligible).toBe(false);
    expect(state.reviewReasons).toEqual([reviewReason]);
    expect(state.notificationProjectionReconciliationRequired).toBe(true);
  });

  it("keeps business shipment recognized when a valid label is voided before possession", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel(),
      voidedLabel(),
    ]));

    expect(state).toMatchObject({
      labelStatus: "voided",
      businessStatus: "shipped",
      businessShipmentRecognizedAt: labelObservedAt,
      currentAutomationAuthority: true,
      correctionStatus: "awaiting_relabel",
      carrierStatus: "not_confirmed",
      commercialFulfillmentPostingEligible: true,
      inventoryPostingEligible: true,
      activeTrackingProjectionEligible: false,
      voidTrackingProjectionRequired: true,
      carrierTrackingProjectionRequired: false,
      notificationCandidateEligible: false,
      notificationProjectionReconciliationRequired: true,
      reviewReasons: [],
    });
  });

  it("transitions active-label tracking authority to carrier tracking at possession", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel(),
      carrierPossession(),
    ]));

    expect(state).toMatchObject({
      labelStatus: "active",
      carrierStatus: "possession_confirmed",
      correctionStatus: "carrier_locked",
      disposition: "outbound",
      activeTrackingProjectionEligible: false,
      voidTrackingProjectionRequired: false,
      carrierTrackingProjectionRequired: true,
      notificationProjectionReconciliationRequired: false,
      reviewReasons: [],
    });
  });


  it("lets carrier evidence win for a previously voided label and expects return to sender", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel(),
      voidedLabel(),
      carrierPossession(),
    ]));

    expect(state).toMatchObject({
      businessStatus: "shipped",
      labelStatus: "voided",
      carrierStatus: "possession_confirmed",
      correctionStatus: "carrier_locked",
      topologyLockedProviderAt: possessionProviderOccurredAt,
      topologyLockRecognizedAt: possessionObservedAt,
      disposition: "return_to_sender_expected",
      activeTrackingProjectionEligible: false,
      voidTrackingProjectionRequired: false,
      carrierTrackingProjectionRequired: true,
      notificationCandidateEligible: false,
      notificationProjectionReconciliationRequired: true,
      reviewReasons: [],
    });
  });

  it("keeps carrier tracking when the provider records a void after possession", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel(),
      carrierPossession(),
      voidedLabel({
        observedAt: "2026-08-20T14:15:01.000Z",
        providerOccurredAt: "2026-08-20T14:15:00.000Z",
      }),
    ]));

    expect(state).toMatchObject({
      correctionStatus: "carrier_locked",
      disposition: "outbound",
      activeTrackingProjectionEligible: false,
      voidTrackingProjectionRequired: false,
      carrierTrackingProjectionRequired: true,
      notificationProjectionReconciliationRequired: true,
      currentAutomationAuthority: false,
      commercialFulfillmentPostingEligible: false,
      inventoryPostingEligible: false,
      reconciliationStatus: "review",
      reviewReasons: ["void_after_carrier_possession"],
    });
  });

  it("does not guess void-versus-possession order without comparable provider times", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel(),
      voidedLabel({ providerOccurredAt: null }),
      carrierPossession({ providerOccurredAt: null }),
    ]));

    expect(state).toMatchObject({
      correctionStatus: "carrier_locked",
      disposition: "review",
      carrierTrackingProjectionRequired: true,
      voidTrackingProjectionRequired: false,
      notificationProjectionReconciliationRequired: true,
      currentAutomationAuthority: false,
      commercialFulfillmentPostingEligible: false,
      inventoryPostingEligible: false,
      reconciliationStatus: "review",
      reviewReasons: ["void_carrier_order_unproven"],
    });
  });

  it("records carrier truth while holding unknown contents for lead review", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel({ contentsEvidence: { status: "omitted" } }),
      carrierPossession(),
    ]));

    expect(state).toMatchObject({
      businessStatus: "shipped",
      businessShipmentRecognizedAt: labelObservedAt,
      carrierStatus: "possession_confirmed",
      correctionStatus: "carrier_locked",
      disposition: "outbound",
      currentAutomationAuthority: false,
      commercialFulfillmentPostingEligible: false,
      inventoryPostingEligible: false,
      carrierTrackingProjectionRequired: true,
      notificationProjectionReconciliationRequired: true,
      reviewReasons: [
        "carrier_possession_without_authoritative_contents",
        "package_contents_omitted",
      ],
    });
  });

  it("lets a lead resolve named content evidence after possession without unlocking topology", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel({ contentsEvidence: { status: "omitted" } }),
      carrierPossession(),
      contentsAttestation(),
    ]));

    expect(state).toMatchObject({
      contentsStatus: "authoritative",
      observedContentsEvidenceStatuses: ["omitted"],
      activeContentsEvidenceStatuses: [],
      authoritativeContents: [{ wmsShipmentItemId: 7001, quantity: 2 }],
      businessStatus: "shipped",
      businessShipmentRecognizedAt: labelObservedAt,
      currentAutomationAuthority: true,
      reconciliationStatus: "clear",
      correctionStatus: "carrier_locked",
      carrierTrackingProjectionRequired: true,
      commercialFulfillmentPostingEligible: true,
      inventoryPostingEligible: true,
      notificationProjectionReconciliationRequired: false,
      reviewReasons: [],
    });
  });

  it("accepts deterministic system recovery through the same named-resolution rules", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel({ contentsEvidence: { status: "omitted" } }),
      contentsAttestation({
        eventKey: "shipping-provider-label-event:102:contents-recovered",
        authorization: "system_recovered",
        actor: "historical-shipstation-contents-system-recovery",
        reason: "Deterministic provider_line_keys_authoritative recovery",
      }),
    ]));

    expect(state).toMatchObject({
      contentsStatus: "authoritative",
      authoritativeContents: [{ wmsShipmentItemId: 7001, quantity: 2 }],
      currentAutomationAuthority: true,
      reconciliationStatus: "clear",
      reviewReasons: [],
    });
  });

  it.each([
    [
      "a duplicate reference",
      [
        observedLabel({ contentsEvidence: { status: "omitted" } }),
        contentsAttestation({
          resolvesEventKeys: [labelObservationEventKey, labelObservationEventKey],
        }),
      ],
    ],
    [
      "evidence that is not prior",
      [
        contentsAttestation({
          eventKey: "zz:echelon:lead-attestation:51",
          observedAt: labelObservedAt,
        }),
        observedLabel({ contentsEvidence: { status: "omitted" } }),
      ],
    ],
    [
      "authoritative provider evidence",
      [
        observedLabel(),
        contentsAttestation(),
      ],
    ],
    [
      "evidence already resolved by another attestation",
      [
        observedLabel({ contentsEvidence: { status: "omitted" } }),
        contentsAttestation({ observedAt: "2026-08-20T14:01:00.000Z" }),
        contentsAttestation({
          eventKey: "echelon:lead-attestation:52",
          observedAt: "2026-08-20T14:02:00.000Z",
        }),
      ],
    ],
  ] as const)("rejects content resolution of %s", (_caseName, events) => {
    expect(() => projectDeclaredPackageLifecycle(lifecycle([...events])))
      .toThrowError(expect.objectContaining({
        code: "INVALID_CONTENT_RESOLUTION",
      }));
  });

  it("holds carrier evidence without an observed label for review", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([carrierPossession()]));

    expect(state).toMatchObject({
      labelStatus: "unknown",
      businessStatus: "not_shipped",
      correctionStatus: "carrier_locked",
      disposition: "outbound",
      commercialFulfillmentPostingEligible: false,
      inventoryPostingEligible: false,
      reviewReasons: [
        "carrier_possession_without_authoritative_contents",
        "carrier_possession_without_label_observation",
        "package_contents_not_observed",
      ],
    });
  });

  it("does not create a relabel obligation from a void without label evidence", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([voidedLabel()]));

    expect(state).toMatchObject({
      labelStatus: "voided",
      businessStatus: "not_shipped",
      correctionStatus: "review",
      disposition: "not_dispatched",
      reviewReasons: ["void_without_label_observation"],
    });
  });

  it("accepts late discovery of a label already voided when provider issuance time is unknown", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      voidedLabel({
        observedAt: "2026-08-20T13:59:00.000Z",
        providerOccurredAt: voidProviderOccurredAt,
      }),
      observedLabel({
        observedAt: labelObservedAt,
        providerOccurredAt: null,
      }),
    ]));

    expect(state).toMatchObject({
      labelStatus: "voided",
      labelVoidFirstObservedAt: "2026-08-20T13:59:00.000Z",
      labelFirstObservedAt: labelObservedAt,
      businessStatus: "shipped",
      businessShipmentRecognizedAt: labelObservedAt,
      currentAutomationAuthority: true,
      correctionStatus: "awaiting_relabel",
      reviewReasons: [],
      notificationProjectionReconciliationRequired: true,
    });
  });

  it("blocks automation on provider-authored void chronology without erasing shipment recognition", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      voidedLabel({
        observedAt: "2026-08-20T13:58:00.000Z",
        providerOccurredAt: "2026-08-20T13:58:00.000Z",
      }),
      observedLabel({ providerOccurredAt: labelProviderOccurredAt }),
    ]));

    expect(state).toMatchObject({
      labelStatus: "voided",
      businessStatus: "shipped",
      businessShipmentRecognizedAt: labelObservedAt,
      currentAutomationAuthority: false,
      reconciliationStatus: "review",
      correctionStatus: "review",
      commercialFulfillmentPostingEligible: false,
      inventoryPostingEligible: false,
      notificationCandidateEligible: false,
      notificationProjectionReconciliationRequired: true,
      reviewReasons: ["provider_void_precedes_provider_label_issuance"],
    });
  });

  it("normalizes equivalent observed instants for deterministic input ordering", () => {
    const label = observedLabel({
      observedAt: "2026-08-20T10:00:00-04:00",
      providerOccurredAt: labelProviderOccurredAt,
    });
    const voidEvent = voidedLabel({
      observedAt: labelObservedAt,
      providerOccurredAt: "2026-08-20T13:58:00.000Z",
    });

    const forward = projectDeclaredPackageLifecycle(lifecycle([label, voidEvent]));
    const reversed = projectDeclaredPackageLifecycle(lifecycle([voidEvent, label]));

    expect(forward).toEqual(reversed);
    expect(forward).toMatchObject({
      labelStatus: "voided",
      businessStatus: "shipped",
      businessShipmentRecognizedAt: labelObservedAt,
      currentAutomationAuthority: false,
      notificationProjectionReconciliationRequired: true,
      reviewReasons: ["provider_void_precedes_provider_label_issuance"],
    });
  });

  it("canonicalizes equivalent provider timestamp encodings identically", () => {
    const utc = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel({ providerOccurredAt: labelProviderOccurredAt }),
    ]));
    const offset = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel({ providerOccurredAt: "2026-08-20T09:59:50.000-04:00" }),
    ]));

    expect(offset).toEqual(utc);
  });

  it("rejects sub-millisecond timestamps instead of truncating chronology", () => {
    expect(() => projectDeclaredPackageLifecycle(lifecycle([
      observedLabel({ providerOccurredAt: "2026-08-20T13:59:50.0009Z" }),
    ]))).toThrowError(expect.objectContaining({
      code: "INVALID_PACKAGE_LIFECYCLE",
    }));
  });

  it("retains prior business recognition when later provider evidence contradicts chronology", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel({ providerOccurredAt: labelProviderOccurredAt }),
      voidedLabel({ providerOccurredAt: "2026-08-20T13:58:00.000Z" }),
    ]));

    expect(state).toMatchObject({
      labelStatus: "voided",
      businessStatus: "shipped",
      businessShipmentRecognizedAt: labelObservedAt,
      currentAutomationAuthority: false,
      reconciliationStatus: "review",
      correctionStatus: "review",
      commercialFulfillmentPostingEligible: false,
      notificationProjectionReconciliationRequired: true,
      inventoryPostingEligible: false,
      reviewReasons: ["provider_void_precedes_provider_label_issuance"],
    });
  });

  it("holds simultaneous provider void and possession evidence for disposition review", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel(),
      voidedLabel({ providerOccurredAt: possessionProviderOccurredAt }),
      carrierPossession(),
    ]));

    expect(state).toMatchObject({
      correctionStatus: "carrier_locked",
      disposition: "review",
      carrierTrackingProjectionRequired: true,
      voidTrackingProjectionRequired: false,
      notificationProjectionReconciliationRequired: true,
      currentAutomationAuthority: false,
      commercialFulfillmentPostingEligible: false,
      inventoryPostingEligible: false,
      reviewReasons: ["simultaneous_void_and_carrier_possession"],
    });
  });

  it("is independent of webhook delivery order", () => {
    const events: DeclaredPackageLifecycleEvent[] = [
      observedLabel(),
      voidedLabel(),
      carrierPossession(),
    ];

    expect(projectDeclaredPackageLifecycle(lifecycle(events)))
      .toEqual(projectDeclaredPackageLifecycle(lifecycle(events.slice().reverse())));
  });

  it("deduplicates an exact event replay", () => {
    const event = observedLabel();
    const state = projectDeclaredPackageLifecycle(lifecycle([event, structuredClone(event)]));

    expect(state.appliedEventCount).toBe(1);
  });

  it("rejects a reused event key carrying different evidence", () => {
    const event = observedLabel();

    expect(() => projectDeclaredPackageLifecycle(lifecycle([
      event,
      { ...event, trackingNumber: "1Z999AA10123456785" },
    ]))).toThrowError(expect.objectContaining({
      code: "CONFLICTING_EVENT_REPLAY",
    }));
  });

  it("rejects multiple tracking identities for one provider physical shipment", () => {
    expect(() => projectDeclaredPackageLifecycle(lifecycle([
      observedLabel(),
      {
        kind: "outbound_label_reprinted",
        eventKey: "shipstation:shipment:44001:reprint:2",
        observedAt: "2026-08-20T14:01:00.000Z",
        providerOccurredAt: null,
        trackingNumber: "1Z999AA10123456785",
      },
    ]))).toThrowError(expect.objectContaining({
      code: "CONFLICTING_PROVIDER_IDENTITY",
    }));
  });

  it("blocks automation on later malformed evidence without erasing prior shipment recognition", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel(),
      observedLabel({
        eventKey: "shipstation:shipment:44001:observed:2",
        observedAt: "2026-08-20T14:02:00.000Z",
        contentsEvidence: { status: "malformed" },
      }),
    ]));

    expect(state).toMatchObject({
      contentsStatus: "unknown",
      businessStatus: "shipped",
      businessShipmentRecognizedAt: labelObservedAt,
      currentAutomationAuthority: false,
      reconciliationStatus: "review",
      correctionStatus: "review",
      commercialFulfillmentPostingEligible: false,
      inventoryPostingEligible: false,
      notificationProjectionReconciliationRequired: true,
      reviewReasons: ["package_contents_malformed"],
    });
  });

  it("does not let a later exact observation silently resolve omitted evidence", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel({ contentsEvidence: { status: "omitted" } }),
      observedLabel({
        eventKey: "shipstation:shipment:44001:observed:2",
        observedAt: "2026-08-20T14:02:00.000Z",
        contentsEvidence: {
          status: "authoritative",
          lines: [{ wmsShipmentItemId: 7001, quantity: 2 }],
        },
      }),
    ]));

    expect(state).toMatchObject({
      contentsStatus: "unknown",
      authoritativeContents: null,
      businessStatus: "shipped",
      businessShipmentRecognizedAt: labelObservedAt,
      currentAutomationAuthority: false,
      notificationProjectionReconciliationRequired: true,
      reviewReasons: ["package_contents_omitted"],
    });
  });

  it("classifies contradictory exact contents without erasing prior shipment recognition", () => {
    const state = projectDeclaredPackageLifecycle(lifecycle([
      observedLabel(),
      observedLabel({
        eventKey: "shipstation:shipment:44001:observed:2",
        observedAt: "2026-08-20T14:02:00.000Z",
        contentsEvidence: {
          status: "authoritative",
          lines: [{ wmsShipmentItemId: 7001, quantity: 1 }],
        },
      }),
    ]));

    expect(state).toMatchObject({
      contentsStatus: "conflicting",
      authoritativeContents: null,
      businessStatus: "shipped",
      businessShipmentRecognizedAt: labelObservedAt,
      currentAutomationAuthority: false,
      reconciliationStatus: "review",
      correctionStatus: "review",
      commercialFulfillmentPostingEligible: false,
      inventoryPostingEligible: false,
      notificationProjectionReconciliationRequired: true,
      reviewReasons: ["conflicting_package_contents"],
    });
  });

  it.each([
    [
      "WMS shipment-item ID",
      { wmsShipmentItemId: 2_147_483_648, quantity: 1 },
    ],
    [
      "declared quantity",
      { wmsShipmentItemId: 7001, quantity: 2_147_483_648 },
    ],
  ])("rejects a %s above the PostgreSQL integer maximum", (_caseName, line) => {
    expect(() => projectDeclaredPackageLifecycle(lifecycle([
      observedLabel({
        contentsEvidence: {
          status: "authoritative",
          lines: [line],
        },
      }),
    ]))).toThrowError(expect.objectContaining({
      code: "INVALID_PACKAGE_LIFECYCLE",
    }));
  });

  it("rejects a carrier tracking event ID beyond JavaScript safe precision", () => {
    expect(() => projectDeclaredPackageLifecycle(lifecycle([
      carrierPossession({
        carrierTrackingEventId: Number.MAX_SAFE_INTEGER + 1,
      }),
    ]))).toThrowError(expect.objectContaining({
      code: "INVALID_PACKAGE_LIFECYCLE",
    }));
  });

  it("rejects duplicate line identities inside one package snapshot", () => {
    expect(() => projectDeclaredPackageLifecycle(lifecycle([
      observedLabel({
        contentsEvidence: {
          status: "authoritative",
          lines: [
            { wmsShipmentItemId: 7001, quantity: 1 },
            { wmsShipmentItemId: 7001, quantity: 1 },
          ],
        },
      }),
    ]))).toThrowError(DeclaredPackageLifecycleError);
  });

  it("does not mutate caller-owned events and returns frozen evidence", () => {
    const input = lifecycle([observedLabel()], { provider: " ShipStation " });
    const original = structuredClone(input);
    const state = projectDeclaredPackageLifecycle(input);

    expect(input).toEqual(original);
    expect(state.provider).toBe("shipstation");
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.authoritativeContents)).toBe(true);
    expect(state.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(state.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
