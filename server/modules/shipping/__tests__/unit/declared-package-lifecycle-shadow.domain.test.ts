import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";
import { describe, expect, it } from "vitest";

import { normalizeShipStationLabelObservation } from "../../carrier-tracking.domain";
import {
  adaptPersistedDeclaredPackageLifecycleEvidence,
  projectPersistedDeclaredPackageLifecycleShadow,
  summarizePersistedDeclaredPackageLifecycleShadow,
  type PersistedConfirmedCarrierEvidenceRow,
  type PersistedDeclaredPackageEvidence,
  type PersistedShippingProviderLabelEventRow,
} from "../../declared-package-lifecycle-shadow.domain";

const providerPhysicalShipmentId = "44001";
const trackingNumber = "1Z999AA10123456784";
const labelReceivedAt = "2026-08-20T14:00:00.000Z";
const voidReceivedAt = "2026-08-20T14:05:01.000Z";
const voidOccurredAt = "2026-08-20T14:05:00.000Z";
const possessionReceivedAt = "2026-08-20T14:10:01.000Z";
const possessionOccurredAt = "2026-08-20T14:10:00.000Z";

function authoritativePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    payloadSchemaVersion: 2,
    providerLabelId: providerPhysicalShipmentId,
    trackingNumber,
    observationSource: "shipstation_shipment_observation",
    sourceObservationHash: "f".repeat(64),
    createDate: null,
    shipDate: null,
    voidDate: null,
    isReturnLabel: false,
    declaredContentsEvidence: {
      evidenceSchemaVersion: 1,
      status: "authoritative",
      providerItemCount: 2,
      recognizedProviderItemCount: 2,
      canonicalLineCount: 2,
      malformedItemCount: 0,
      unrecognizedItemCount: 0,
      duplicateLineItemCount: 0,
      rejectedItemCount: 0,
      reviewRequired: false,
      lines: [
        { lineItemKey: "wms-item-7002", quantity: 1 },
        { lineItemKey: "wms-item-7001", quantity: 2 },
      ],
    },
    ...overrides,
  };
}

function persistedEventHash(
  sanitizedPayload: unknown,
  labelStatus: string,
): string {
  return createHash("sha256")
    .update(canonicalJson({ provider: "shipstation", ...(sanitizedPayload as object), labelStatus }))
    .digest("hex");
}

function labelEvent(
  overrides: Partial<PersistedShippingProviderLabelEventRow> = {},
): PersistedShippingProviderLabelEventRow {
  const event: PersistedShippingProviderLabelEventRow = {
    id: 101,
    shippingProviderLabelId: 41,
    eventHash: "",
    eventType: "label_observed",
    labelStatus: "active",
    trackingNumber,
    // This is the currently persisted shipDate-derived value. The adapter must
    // never read it as label issuance evidence, even when it is malformed.
    providerOccurredAt: "not-an-issuance-timestamp",
    sanitizedPayload: authoritativePayload(),
    receivedAt: labelReceivedAt,
    ...overrides,
  };
  return {
    ...event,
    eventHash: overrides.eventHash
      ?? persistedEventHash(event.sanitizedPayload, event.labelStatus),
  };
}

function voidEvent(
  overrides: Partial<PersistedShippingProviderLabelEventRow> = {},
): PersistedShippingProviderLabelEventRow {
  return labelEvent({
    id: 102,
    eventType: "label_voided",
    labelStatus: "voided",
    providerOccurredAt: voidOccurredAt,
    receivedAt: voidReceivedAt,
    sanitizedPayload: authoritativePayload({ voidDate: voidOccurredAt }),
    ...overrides,
  });
}

function carrierEvidence(
  overrides: Partial<PersistedConfirmedCarrierEvidenceRow> = {},
): PersistedConfirmedCarrierEvidenceRow {
  return {
    id: 201,
    shippingProviderLabelId: 41,
    dispatchEvidence: "confirmed",
    currentMatchStatus: "matched",
    eventOccurredAt: possessionOccurredAt,
    receivedAt: possessionReceivedAt,
    ...overrides,
  };
}

function persistedPackage(
  overrides: Partial<PersistedDeclaredPackageEvidence> = {},
): PersistedDeclaredPackageEvidence {
  const labelEvents = overrides.labelEvents ?? [labelEvent()];
  const eventObservedAt = labelEvents
    .map((event) => (
      event.receivedAt instanceof Date ? event.receivedAt.toISOString() : event.receivedAt
    ))
    .sort();
  const currentLabelStatus = labelEvents.some((event) => event.labelStatus === "voided")
    ? "voided"
    : "active";
  return {
    shippingProviderLabelId: 41,
    provider: "shipstation",
    providerPhysicalShipmentId,
    currentTrackingNumber: labelEvents[0]?.trackingNumber ?? trackingNumber,
    currentLabelStatus,
    firstObservedAt: eventObservedAt[0] ?? labelReceivedAt,
    lastObservedAt: eventObservedAt.at(-1) ?? labelReceivedAt,
    labelDirection: "outbound",
    labelEvents,
    confirmedCarrierEvents: [carrierEvidence()],
    ...overrides,
  };
}
function persistedEventFromObservation(
  observation: ReturnType<typeof normalizeShipStationLabelObservation>,
  id: number = 101,
): PersistedShippingProviderLabelEventRow {
  return {
    id,
    shippingProviderLabelId: 41,
    eventHash: observation.eventHash,
    eventType: observation.eventType,
    labelStatus: observation.labelStatus,
    trackingNumber: observation.trackingNumber,
    providerOccurredAt: observation.providerOccurredAt?.toISOString() ?? null,
    sanitizedPayload: observation.sanitizedPayload,
    receivedAt: observation.observedAt.toISOString(),
  };
}

describe("persisted declared-package lifecycle adapter", () => {
  it("uses stable database event ids and original received timestamps", () => {
    const result = adaptPersistedDeclaredPackageLifecycleEvidence(persistedPackage());

    expect(result.outcome).toBe("adapted");
    if (result.outcome !== "adapted") throw new Error("expected adapted evidence");
    expect(result.input.events).toEqual([
      {
        kind: "outbound_label_observed",
        eventKey: "shipping-provider-label-event:101:observed",
        observedAt: labelReceivedAt,
        providerOccurredAt: null,
        trackingNumber,
        contentsEvidence: {
          status: "authoritative",
          lines: [
            { wmsShipmentItemId: 7001, quantity: 2 },
            { wmsShipmentItemId: 7002, quantity: 1 },
          ],
        },
      },
      {
        kind: "carrier_possession_confirmed",
        eventKey: "carrier-tracking-event:201",
        observedAt: possessionReceivedAt,
        providerOccurredAt: possessionOccurredAt,
        carrierTrackingEventId: 201,
      },
    ]);
  });

  it("maps every persisted observation as an observation and never infers reprint", () => {
    const secondObservation = labelEvent({
      id: 103,
      receivedAt: "2026-08-20T14:01:00.000Z",
    });
    const result = adaptPersistedDeclaredPackageLifecycleEvidence(persistedPackage({
      labelEvents: [secondObservation, labelEvent()],
      confirmedCarrierEvents: [],
    }));

    expect(result.outcome).toBe("adapted");
    if (result.outcome !== "adapted") throw new Error("expected adapted evidence");
    expect(result.input.events.map((event) => event.kind)).toEqual([
      "outbound_label_observed",
      "outbound_label_observed",
    ]);
    expect(result.input.events.map((event) => event.eventKey)).toEqual([
      "shipping-provider-label-event:101:observed",
      "shipping-provider-label-event:103:observed",
    ]);
  });

  it("uses a validated void occurrence but never the active shipDate-derived occurrence", () => {
    const result = projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      labelEvents: [voidEvent(), labelEvent()],
      confirmedCarrierEvents: [carrierEvidence({ currentMatchStatus: "voided_label" })],
    }));

    expect(result.outcome).toBe("projected");
    if (result.outcome !== "projected") throw new Error("expected projected evidence");
    expect(result.projection).toMatchObject({
      labelProviderOccurredAt: null,
      labelFirstObservedAt: labelReceivedAt,
      labelVoidedProviderOccurredAt: voidOccurredAt,
      labelVoidFirstObservedAt: voidReceivedAt,
      carrierStatus: "possession_confirmed",
      disposition: "return_to_sender_expected",
    });
  });

  it("rejects a v2 void whose payload occurrence conflicts with its persisted column", () => {
    const result = projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      labelEvents: [
        labelEvent(),
        voidEvent({
          sanitizedPayload: authoritativePayload({
            voidDate: "2026-08-20T14:04:59.000Z",
          }),
        }),
      ],
      confirmedCarrierEvents: [],
    }));

    expect(result).toEqual({
      outcome: "rejected",
      reason: "invalid_v2_label_evidence",
    });
  });

  it("keeps historical key-only v1 evidence incomplete and non-authoritative", () => {
    const result = projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      labelEvents: [labelEvent({
        sanitizedPayload: {
          providerLabelId: providerPhysicalShipmentId,
          trackingNumber,
          shipmentItems: [{ lineItemKey: "wms-item-7001" }],
        },
      })],
      confirmedCarrierEvents: [],
    }));

    expect(result.outcome).toBe("projected");
    if (result.outcome !== "projected") throw new Error("expected projected evidence");
    expect(result.evidenceCoverage).toBe("historical_v1_incomplete");
    expect(result.projection).toMatchObject({
      contentsStatus: "unknown",
      observedContentsEvidenceStatuses: ["omitted"],
      authoritativeContents: null,
      currentAutomationAuthority: false,
      reconciliationStatus: "review",
      reviewReasons: ["package_contents_omitted"],
    });
  });

  it("rejects non-outbound packages and packages without label evidence", () => {
    expect(projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      labelDirection: "return",
    }))).toEqual({ outcome: "rejected", reason: "non_outbound_label" });
    expect(projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      labelEvents: [],
    }))).toEqual({ outcome: "rejected", reason: "no_label_events" });
  });

  it("accepts only carrier evidence that is both current-matched and confirmed", () => {
    expect(projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      confirmedCarrierEvents: [carrierEvidence({ dispatchEvidence: "review" })],
    }))).toEqual({ outcome: "rejected", reason: "invalid_carrier_evidence" });
    expect(projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      confirmedCarrierEvents: [carrierEvidence({ currentMatchStatus: "unmatched" })],
    }))).toEqual({ outcome: "rejected", reason: "invalid_carrier_evidence" });
  });

  it("rejects inconsistent or unsupported persisted v2 evidence", () => {
    const inconsistent = authoritativePayload({
      declaredContentsEvidence: {
        evidenceSchemaVersion: 1,
        status: "authoritative",
        providerItemCount: 2,
        recognizedProviderItemCount: 2,
        canonicalLineCount: 1,
        malformedItemCount: 0,
        unrecognizedItemCount: 0,
        duplicateLineItemCount: 0,
        rejectedItemCount: 0,
        reviewRequired: false,
        lines: [
          { lineItemKey: "wms-item-7001", quantity: 2 },
          { lineItemKey: "wms-item-7002", quantity: 1 },
        ],
      },
    });
    expect(projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      labelEvents: [labelEvent({ sanitizedPayload: inconsistent })],
    }))).toEqual({ outcome: "rejected", reason: "invalid_v2_label_evidence" });
    expect(projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      labelEvents: [labelEvent({
        sanitizedPayload: { ...authoritativePayload(), payloadSchemaVersion: 3 },
      })],
    }))).toEqual({
      outcome: "rejected",
      reason: "unsupported_label_payload_schema",
    });
  });

  it("is deterministic when persisted rows arrive in a different order", () => {
    const labels = [
      labelEvent(),
      labelEvent({
        id: 103,
        receivedAt: "2026-08-20T14:01:00.000Z",
      }),
    ];
    const carriers = [
      carrierEvidence(),
      carrierEvidence({
        id: 202,
        receivedAt: "2026-08-20T14:11:01.000Z",
        eventOccurredAt: "2026-08-20T14:11:00.000Z",
      }),
    ];
    const forward = projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      labelEvents: labels,
      confirmedCarrierEvents: carriers,
    }));
    const reversed = projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      labelEvents: labels.slice().reverse(),
      confirmedCarrierEvents: carriers.slice().reverse(),
    }));

    expect(forward).toEqual(reversed);
  });
});

describe("persisted shadow hardening regressions", () => {
  it("round-trips a normalized current-flow observation with exact contents", () => {
    const observation = normalizeShipStationLabelObservation({
      shipmentId: 44_001,
      trackingNumber,
      isReturnLabel: false,
      shipmentItems: [
        { lineItemKey: "wms-item-7002", quantity: 1 },
        { lineItemKey: "wms-item-7001", quantity: 2 },
      ],
    }, new Date(labelReceivedAt));
    const result = projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      labelEvents: [persistedEventFromObservation(observation)],
      confirmedCarrierEvents: [],
    }));

    expect(result).toMatchObject({
      outcome: "projected",
      evidenceCoverage: "current_flow",
      projection: {
        businessStatus: "shipped",
        labelStatus: "active",
        contentsStatus: "authoritative",
        currentAutomationAuthority: true,
      },
    });
  });

  it("fans out a first-seen normalized void into observed and voided facts", () => {
    const observation = normalizeShipStationLabelObservation({
      shipmentId: 44_001,
      trackingNumber,
      voidDate: voidOccurredAt,
      isReturnLabel: false,
      shipmentItems: [{ lineItemKey: "wms-item-7001", quantity: 2 }],
    }, new Date(voidReceivedAt));
    const input = persistedPackage({
      labelEvents: [persistedEventFromObservation(observation, 102)],
      confirmedCarrierEvents: [],
    });
    const adapted = adaptPersistedDeclaredPackageLifecycleEvidence(input);
    const projected = projectPersistedDeclaredPackageLifecycleShadow(input);

    expect(adapted.outcome).toBe("adapted");
    if (adapted.outcome !== "adapted") throw new Error("expected adapted void evidence");
    expect(adapted.input.events.map((event) => event.kind)).toEqual([
      "outbound_label_observed",
      "outbound_label_voided",
    ]);
    expect(projected).toMatchObject({
      outcome: "projected",
      evidenceCoverage: "current_flow",
      projection: {
        businessStatus: "shipped",
        labelStatus: "voided",
        correctionStatus: "awaiting_relabel",
        trackingNumber,
        contentsStatus: "authoritative",
      },
    });
    if (projected.outcome !== "projected") throw new Error("expected projected void");
    expect(projected.projection.reviewReasons).not.toContain("void_without_label_observation");
  });

  it.each([
    ["null container", null],
    [
      "duplicate quantity overflow",
      [
        { lineItemKey: "wms-item-7001", quantity: 2_147_483_647 },
        { lineItemKey: "wms-item-7001", quantity: 1 },
      ],
    ],
  ])("accepts normalized quarantined evidence for a %s", (_case, shipmentItems) => {
    const observation = normalizeShipStationLabelObservation({
      shipmentId: 44_001,
      trackingNumber,
      isReturnLabel: false,
      shipmentItems,
    }, new Date(labelReceivedAt));
    const result = projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      labelEvents: [persistedEventFromObservation(observation)],
      confirmedCarrierEvents: [],
    }));

    expect(result).toMatchObject({
      outcome: "projected",
      evidenceCoverage: "current_flow",
      projection: {
        contentsStatus: "unknown",
        currentAutomationAuthority: false,
        reconciliationStatus: "review",
        observedContentsEvidenceStatuses: ["malformed"],
      },
    });
  });

  it("rejects a label event whose stored hash does not match its persisted evidence", () => {
    expect(projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      labelEvents: [labelEvent({ eventHash: "0".repeat(64) })],
      confirmedCarrierEvents: [],
    }))).toEqual({ outcome: "rejected", reason: "invalid_label_event_hash" });
  });

  it("requires current-flow source proof fields even when the event hash is self-consistent", () => {
    const {
      sourceObservationHash: _omittedSourceHash,
      ...missingSourceHash
    } = authoritativePayload();
    expect(projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      labelEvents: [labelEvent({ sanitizedPayload: missingSourceHash })],
      confirmedCarrierEvents: [],
    }))).toEqual({ outcome: "rejected", reason: "invalid_v2_label_evidence" });
  });

  it("fails closed for a non-ShipStation package", () => {
    expect(projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      provider: "other-provider",
    }))).toEqual({ outcome: "rejected", reason: "unsupported_provider" });
  });

  it.each([
    ["provider label", { providerLabelId: "wrong-label", trackingNumber }],
    ["tracking", { providerLabelId: providerPhysicalShipmentId, trackingNumber: "WRONG1234" }],
    [
      "return direction",
      { providerLabelId: providerPhysicalShipmentId, trackingNumber, isReturnLabel: true },
    ],
  ])("rejects corrupt historical v1 %s evidence", (_case, sanitizedPayload) => {
    expect(projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      labelEvents: [labelEvent({ sanitizedPayload })],
      confirmedCarrierEvents: [],
    }))).toEqual({ outcome: "rejected", reason: "invalid_v1_label_evidence" });
  });

  it.each([
    ["status", { currentLabelStatus: "voided" as const }],
    ["tracking", { currentTrackingNumber: "DIFFERENT1234" }],
    ["first observation", { firstObservedAt: "2026-08-20T14:00:01.000Z" }],
    ["last observation", { lastObservedAt: "2026-08-20T13:59:59.000Z" }],
  ])("quarantines a current-label %s projection mismatch", (_case, override) => {
    expect(projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      ...override,
      confirmedCarrierEvents: [],
    }))).toEqual({
      outcome: "rejected",
      reason: "current_label_projection_mismatch",
    });
  });

  it("uses normalized tracking identity and permits a later deduped last observation", () => {
    const result = projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      currentTrackingNumber: "1z999-aa10123456784",
      lastObservedAt: "2026-08-20T14:30:00.000Z",
      confirmedCarrierEvents: [],
    }));
    expect(result.outcome).toBe("projected");
  });

  it("deeply freezes adapted events and nested contents", () => {
    const result = adaptPersistedDeclaredPackageLifecycleEvidence(persistedPackage({
      confirmedCarrierEvents: [],
    }));
    expect(result.outcome).toBe("adapted");
    if (result.outcome !== "adapted") throw new Error("expected adapted evidence");
    const observed = result.input.events[0];
    expect(Object.isFrozen(result.input.events)).toBe(true);
    expect(Object.isFrozen(observed)).toBe(true);
    if (observed.kind !== "outbound_label_observed") {
      throw new Error("expected observed event");
    }
    expect(Object.isFrozen(observed.contentsEvidence)).toBe(true);
    if (observed.contentsEvidence.status !== "authoritative") {
      throw new Error("expected authoritative contents");
    }
    expect(Object.isFrozen(observed.contentsEvidence.lines)).toBe(true);
    expect(observed.contentsEvidence.lines.every(Object.isFrozen)).toBe(true);
  });

  it("classifies mixed v1/v2 history as historically incomplete", () => {
    const historical = labelEvent({
      id: 100,
      receivedAt: "2026-08-20T13:59:00.000Z",
      sanitizedPayload: { providerLabelId: providerPhysicalShipmentId, trackingNumber },
    });
    const result = projectPersistedDeclaredPackageLifecycleShadow(persistedPackage({
      labelEvents: [historical, labelEvent()],
      confirmedCarrierEvents: [],
    }));
    expect(result).toMatchObject({
      outcome: "projected",
      evidenceCoverage: "historical_v1_incomplete",
    });
  });
});

describe("aggregate-only declared-package lifecycle shadow service", () => {
  it("returns status counts without identities, tracking, contents, hashes, or effect eligibility", () => {
    const historical = persistedPackage({
      shippingProviderLabelId: 42,
      providerPhysicalShipmentId: "44002",
      labelEvents: [labelEvent({
        id: 104,
        shippingProviderLabelId: 42,
        trackingNumber: "9400111899223856928499",
        sanitizedPayload: {
          providerLabelId: "44002",
          trackingNumber: "9400111899223856928499",
          shipmentItems: [{ lineItemKey: "wms-item-9999" }],
        },
      })],
      confirmedCarrierEvents: [],
    });
    const nonOutbound = persistedPackage({
      shippingProviderLabelId: 43,
      providerPhysicalShipmentId: "44003",
      labelDirection: "return",
      labelEvents: [labelEvent({
        id: 105,
        shippingProviderLabelId: 43,
      })],
      confirmedCarrierEvents: [],
    });

    const summary = summarizePersistedDeclaredPackageLifecycleShadow([
      persistedPackage({ confirmedCarrierEvents: [] }),
      historical,
      nonOutbound,
    ]);

    expect(summary).toMatchObject({
      contractVersion: 1,
      packageCount: 3,
      projectedCount: 2,
      rejectedCount: 1,
      rejectionReasonCounts: { non_outbound_label: 1 },
      evidenceCoverageCounts: {
        current_flow: 1,
        historical_v1_incomplete: 1,
      },
      labelStatusCounts: { active: 2 },
      contentsStatusCounts: { authoritative: 1, unknown: 1 },
      businessStatusCounts: { shipped: 2 },
      reconciliationStatusCounts: { clear: 1, review: 1 },
      observedEvidenceStatusCounts: { authoritative: 1, omitted: 1 },
      reviewReasonCounts: { package_contents_omitted: 1 },
    });

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(providerPhysicalShipmentId);
    expect(serialized).not.toContain(trackingNumber);
    expect(serialized).not.toContain("9400111899223856928499");
    expect(serialized).not.toContain("wms-item-");
    expect(serialized).not.toContain("trackingNumber");
    expect(serialized).not.toContain("authoritativeContents");
    expect(serialized).not.toContain("evidenceHash");
    expect(serialized).not.toContain("stateHash");
    expect(serialized).not.toContain("commercialFulfillmentPostingEligible");
    expect(serialized).not.toContain("inventoryPostingEligible");
    expect(serialized).not.toContain("notificationCandidateEligible");
  });
});
