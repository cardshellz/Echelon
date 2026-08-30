import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";
import { describe, expect, it } from "vitest";

import {
  assessPackageAllocationAuthorityReadiness,
  PackageAllocationAuthorityReadinessError,
  type PackageAllocationAuthorityReadinessInput,
} from "../../package-allocation-authority-readiness.domain";
import type {
  PersistedDeclaredPackageEvidence,
  PersistedShippingProviderLabelEventRow,
} from "../../declared-package-lifecycle-shadow.domain";
import type { PackageAllocationSourceFacts } from "../../package-allocation-source-identity.domain";
import { buildHistoricalShipStationContentsSystemRecoveryEvent } from "../../historical-shipstation-contents-recovery.domain";

const LABEL_RECEIVED_AT = "2026-08-23T14:00:00.000Z";

function sourceFacts(
  sourceWmsShipmentItemId: number,
  sourceQuantity: number,
): PackageAllocationSourceFacts {
  return {
    sourceWmsShipmentItemId,
    shipmentRequestItemId: String(90_000 + sourceWmsShipmentItemId),
    sourceQuantity,
    shipmentItemPurpose: "customer_fulfillment",
    orderItemId: 10_000 + sourceWmsShipmentItemId,
    replacementForOrderItemId: null,
    correctionForShipmentItemId: null,
    productVariantId: 20_000 + sourceWmsShipmentItemId,
    orderItemSku: `SKU-${sourceWmsShipmentItemId}`,
    replacementOrderItemSku: null,
    productVariantSku: `SKU-${sourceWmsShipmentItemId}`,
  };
}

interface PackageFixtureOptions {
  readonly shippingProviderLabelId?: number;
  readonly providerPhysicalShipmentId?: string;
  readonly trackingNumber?: string;
  readonly eventId?: number;
  readonly payload?: Record<string, unknown>;
}

function authoritativePayload(
  providerPhysicalShipmentId: string,
  trackingNumber: string,
  lines: readonly { readonly lineItemKey: string; readonly quantity: number }[] = [
    { lineItemKey: "wms-item-7001", quantity: 2 },
    { lineItemKey: "wms-item-7002", quantity: 1 },
  ],
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
      providerItemCount: lines.length,
      recognizedProviderItemCount: lines.length,
      canonicalLineCount: lines.length,
      malformedItemCount: 0,
      unrecognizedItemCount: 0,
      duplicateLineItemCount: 0,
      rejectedItemCount: 0,
      reviewRequired: false,
      lines,
    },
  };
}

function unavailablePayload(
  providerPhysicalShipmentId: string,
  trackingNumber: string,
): Record<string, unknown> {
  return {
    ...authoritativePayload(providerPhysicalShipmentId, trackingNumber, []),
    declaredContentsEvidence: {
      evidenceSchemaVersion: 1,
      status: "omitted",
      providerItemCount: 0,
      recognizedProviderItemCount: 0,
      canonicalLineCount: 0,
      malformedItemCount: 0,
      unrecognizedItemCount: 0,
      duplicateLineItemCount: 0,
      rejectedItemCount: 0,
      reviewRequired: true,
      lines: [],
    },
  };
}

function eventHash(sanitizedPayload: unknown, labelStatus = "active"): string {
  return createHash("sha256")
    .update(canonicalJson({ provider: "shipstation", ...(sanitizedPayload as object), labelStatus }))
    .digest("hex");
}

function persistedPackage(options: PackageFixtureOptions = {}): PersistedDeclaredPackageEvidence {
  const shippingProviderLabelId = options.shippingProviderLabelId ?? 41;
  const providerPhysicalShipmentId = options.providerPhysicalShipmentId ?? "44001";
  const trackingNumber = options.trackingNumber ?? "1Z999AA10123456784";
  const payload = options.payload
    ?? authoritativePayload(providerPhysicalShipmentId, trackingNumber);
  const labelEvent: PersistedShippingProviderLabelEventRow = {
    id: options.eventId ?? 101,
    shippingProviderLabelId,
    eventHash: eventHash(payload),
    eventType: "label_observed",
    labelStatus: "active",
    trackingNumber,
    providerOccurredAt: null,
    sanitizedPayload: payload,
    receivedAt: LABEL_RECEIVED_AT,
  };
  return {
    shippingProviderLabelId,
    provider: "shipstation",
    providerPhysicalShipmentId,
    currentTrackingNumber: trackingNumber,
    currentLabelStatus: "active",
    firstObservedAt: LABEL_RECEIVED_AT,
    lastObservedAt: LABEL_RECEIVED_AT,
    labelDirection: "outbound",
    labelEvents: [labelEvent],
    confirmedCarrierEvents: [],
  };
}

function historicalPackage(): PersistedDeclaredPackageEvidence {
  const providerPhysicalShipmentId = "44001";
  const trackingNumber = "1Z999AA10123456784";
  const payload = {
    payloadSchemaVersion: 1,
    providerLabelId: providerPhysicalShipmentId,
    trackingNumber,
    isReturnLabel: false,
  };
  return persistedPackage({ providerPhysicalShipmentId, trackingNumber, payload });
}

function rejectedPackageWithSentinel(sentinel: string): PersistedDeclaredPackageEvidence {
  const persisted = persistedPackage();
  const labelEvent = persisted.labelEvents[0];
  if (labelEvent === undefined) throw new Error("Expected a persisted label event fixture");
  return {
    ...persisted,
    labelEvents: [{
      ...labelEvent,
      eventHash: "0".repeat(64),
      sanitizedPayload: {
        ...labelEvent.sanitizedPayload,
        diagnosticSentinel: sentinel,
      },
    }],
  };
}

function validInput(): PackageAllocationAuthorityReadinessInput {
  return {
    contractVersion: 1,
    authorityMode: "shadow_only",
    sourceFacts: [sourceFacts(7001, 2), sourceFacts(7002, 1)],
    packages: [{ evidenceKey: "provider-package:shipstation:44001", persistedEvidence: persistedPackage() }],
  };
}

function errorFrom(run: () => unknown): PackageAllocationAuthorityReadinessError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PackageAllocationAuthorityReadinessError);
    return error as PackageAllocationAuthorityReadinessError;
  }
  throw new Error("Expected PackageAllocationAuthorityReadinessError");
}

describe("package allocation authority readiness", () => {
  it("recognizes current exact contents but keeps every unresolved authority fail-closed", () => {
    const result = assessPackageAllocationAuthorityReadiness(validInput());

    expect(result).toMatchObject({
      contractVersion: 1,
      authority: "none",
      outcome: "review",
      plannerInput: null,
    });
    expect(result.assessmentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sourceRegistrations.map((source) => source.sourceWmsShipmentItemId)).toEqual([
      7001,
      7002,
    ]);
    expect(result.packageAssessments).toEqual([expect.objectContaining({
      evidenceKey: "provider-package:shipstation:44001",
      inputEvidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      lifecycleStatus: "projected",
      lifecycleRejectionReason: null,
      evidenceCoverage: "current_flow",
      provider: "shipstation",
      providerPhysicalShipmentId: "44001",
      authoritativeContents: [
        { wmsShipmentItemId: 7001, quantity: 2 },
        { wmsShipmentItemId: 7002, quantity: 1 },
      ],
      candidateSourceStatus: "within_candidate_sources",
      outsideCandidateSourceIds: [],
      reviewCodes: [
        "allocation_role_policy_unresolved",
        "package_membership_policy_unresolved",
      ],
    })]);
    expect(result.reviews).toEqual([
      {
        code: "allocation_role_policy_unresolved",
        evidenceKeys: ["provider-package:shipstation:44001"],
        wmsShipmentItemIds: [],
      },
      {
        code: "package_membership_policy_unresolved",
        evidenceKeys: ["provider-package:shipstation:44001"],
        wmsShipmentItemIds: [],
      },
      {
        code: "physical_consumption_authority_policy_unresolved",
        evidenceKeys: [],
        wmsShipmentItemIds: [7001, 7002],
      },
    ]);
  });

  it("canonicalizes accepted Date timestamps exactly like ISO string timestamps", () => {
    const stringResult = assessPackageAllocationAuthorityReadiness(validInput());
    const dateInput = validInput();
    const persisted = persistedPackage();
    const labelEvent = persisted.labelEvents[0];
    if (labelEvent === undefined) throw new Error("Expected a persisted label event fixture");
    dateInput.packages[0] = {
      evidenceKey: "provider-package:shipstation:44001",
      persistedEvidence: {
        ...persisted,
        firstObservedAt: new Date(LABEL_RECEIVED_AT),
        lastObservedAt: new Date(LABEL_RECEIVED_AT),
        labelEvents: [{
          ...labelEvent,
          receivedAt: new Date(LABEL_RECEIVED_AT),
        }],
      },
    };

    const dateResult = assessPackageAllocationAuthorityReadiness(dateInput);

    expect(dateResult).toEqual(stringResult);
    expect(dateResult.packageAssessments[0]?.inputEvidenceHash).toBe(
      stringResult.packageAssessments[0]?.inputEvidenceHash,
    );
  });

  it("rejects decorated Date values without invoking caller-controlled methods", () => {
    const sentinel = "DECORATED_DATE_SENTINEL";
    let methodCalls = 0;
    const decoratedDate = new Date(LABEL_RECEIVED_AT);
    Object.defineProperties(decoratedDate, {
      getTime: {
        value() {
          methodCalls += 1;
          throw new Error(sentinel);
        },
      },
      toISOString: {
        value() {
          methodCalls += 1;
          throw new Error(sentinel);
        },
      },
    });
    const input = validInput();
    const persisted = persistedPackage();
    input.packages[0] = {
      evidenceKey: "provider-package:shipstation:44001",
      persistedEvidence: {
        ...persisted,
        firstObservedAt: decoratedDate,
      },
    };

    const error = errorFrom(() => assessPackageAllocationAuthorityReadiness(input));

    expect(error.context).toMatchObject({
      evidenceKey: "provider-package:shipstation:44001",
      evidenceErrorCode: "EVIDENCE_TYPE_UNSUPPORTED",
    });
    expect(methodCalls).toBe(0);
    expect(JSON.stringify(error)).not.toContain(sentinel);
  });

  it("classifies historical v1 evidence as incomplete and never upgrades it", () => {
    const input = validInput();
    input.packages[0] = {
      evidenceKey: "provider-package:shipstation:44001",
      persistedEvidence: historicalPackage(),
    };

    const result = assessPackageAllocationAuthorityReadiness(input);
    const assessment = result.packageAssessments[0];

    expect(assessment).toMatchObject({
      evidenceCoverage: "historical_v1_incomplete",
      authoritativeContents: [],
      candidateSourceStatus: "unavailable",
    });
    expect(assessment?.reviewCodes).toEqual([
      "allocation_role_policy_unresolved",
      "authoritative_contents_unavailable",
      "historical_contents_incomplete",
      "package_lifecycle_review",
      "package_membership_policy_unresolved",
    ]);
  });

  it("consumes validated system recovery without retaining the historical-incomplete block", () => {
    const input = validInput();
    const historical = historicalPackage();
    const recovery = buildHistoricalShipStationContentsSystemRecoveryEvent({
      shippingProviderLabelId: "41",
      providerShipmentId: 44_001,
      trackingNumber: "1Z999AA10123456784",
      labelStatus: "active",
      recoveryEvidence: {
        contractVersion: 1,
        recoveryStatus: "provider_line_keys_authoritative",
        evidenceHash: "e".repeat(64),
        attestedContents: [
          { wmsShipmentItemId: 7001, quantity: 2 },
          { wmsShipmentItemId: 7002, quantity: 1 },
        ],
      },
      resolvedLabelEventIds: [101],
    });
    input.packages[0] = {
      evidenceKey: "provider-package:shipstation:44001",
      persistedEvidence: {
        ...historical,
        labelEvents: [
          historical.labelEvents[0],
          {
            id: 102,
            shippingProviderLabelId: 41,
            eventHash: recovery.eventHash,
            eventType: recovery.eventType,
            labelStatus: recovery.labelStatus,
            trackingNumber: recovery.trackingNumber,
            providerOccurredAt: recovery.providerOccurredAt,
            sanitizedPayload: recovery.sanitizedPayload,
            receivedAt: "2026-08-23T14:01:00.000Z",
          },
        ],
      },
    };

    const assessment = assessPackageAllocationAuthorityReadiness(input).packageAssessments[0];
    expect(assessment).toMatchObject({
      evidenceCoverage: "historical_v1_recovered",
      authoritativeContents: [
        { wmsShipmentItemId: 7001, quantity: 2 },
        { wmsShipmentItemId: 7002, quantity: 1 },
      ],
      candidateSourceStatus: "within_candidate_sources",
    });
    expect(assessment?.reviewCodes).toEqual([
      "allocation_role_policy_unresolved",
      "package_membership_policy_unresolved",
    ]);
  });

  it("classifies unavailable current contents without inventing line authority", () => {
    const input = validInput();
    input.packages[0] = {
      evidenceKey: "provider-package:shipstation:44001",
      persistedEvidence: persistedPackage({
        payload: unavailablePayload("44001", "1Z999AA10123456784"),
      }),
    };

    const assessment = assessPackageAllocationAuthorityReadiness(input).packageAssessments[0];
    expect(assessment).toMatchObject({
      lifecycleStatus: "projected",
      evidenceCoverage: "current_flow",
      authoritativeContents: [],
      candidateSourceStatus: "unavailable",
    });
    expect(assessment?.reviewCodes).toContain("authoritative_contents_unavailable");
    expect(assessment?.reviewCodes).toContain("package_lifecycle_review");
  });

  it("retains a bounded rejection reason for invalid persisted lifecycle evidence", () => {
    const input = validInput();
    const invalid = persistedPackage();
    input.packages[0] = {
      evidenceKey: "provider-package:shipstation:44001",
      persistedEvidence: {
        ...invalid,
        labelEvents: [{ ...invalid.labelEvents[0], eventHash: "0".repeat(64) }],
      },
    };

    const assessment = assessPackageAllocationAuthorityReadiness(input).packageAssessments[0];
    expect(assessment).toEqual(expect.objectContaining({
      lifecycleStatus: "rejected",
      inputEvidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      lifecycleRejectionReason: "invalid_label_event_hash",
      candidateSourceStatus: "unavailable",
      provider: null,
      providerPhysicalShipmentId: null,
      authoritativeContents: [],
    }));
    expect(assessment?.reviewCodes).toEqual([
      "allocation_role_policy_unresolved",
      "package_lifecycle_evidence_rejected",
      "package_membership_policy_unresolved",
    ]);
  });

  it("commits distinct rejected evidence without exposing diagnostic payload values", () => {
    const firstSentinel = "REJECTED_EVIDENCE_SENTINEL_ALPHA";
    const secondSentinel = "REJECTED_EVIDENCE_SENTINEL_BETA";
    const firstInput = validInput();
    firstInput.packages[0] = {
      evidenceKey: "provider-package:shipstation:44001",
      persistedEvidence: rejectedPackageWithSentinel(firstSentinel),
    };
    const secondInput = validInput();
    secondInput.packages[0] = {
      evidenceKey: "provider-package:shipstation:44001",
      persistedEvidence: rejectedPackageWithSentinel(secondSentinel),
    };

    const first = assessPackageAllocationAuthorityReadiness(firstInput);
    const second = assessPackageAllocationAuthorityReadiness(secondInput);

    expect(first.packageAssessments[0]?.lifecycleRejectionReason).toBe(
      "invalid_label_event_hash",
    );
    expect(second.packageAssessments[0]?.lifecycleRejectionReason).toBe(
      "invalid_label_event_hash",
    );
    expect(first.packageAssessments[0]?.inputEvidenceHash).not.toBe(
      second.packageAssessments[0]?.inputEvidenceHash,
    );
    expect(first.assessmentHash).not.toBe(second.assessmentHash);
    expect(JSON.stringify(first)).not.toContain(firstSentinel);
    expect(JSON.stringify(second)).not.toContain(secondSentinel);
  });

  it("rejects nested forged authority within persisted lifecycle evidence", () => {
    const sentinel = "FORGED_NESTED_AUTHORITY_SENTINEL";
    const input = validInput();
    input.packages[0] = {
      evidenceKey: "provider-package:shipstation:44001",
      persistedEvidence: {
        ...persistedPackage(),
        membership: { status: "proven", evidenceKey: sentinel },
        allocationRole: "primary",
        authorization: { kind: "lead_approved", actor: sentinel },
      },
    };

    const result = assessPackageAllocationAuthorityReadiness(input);

    expect(result).toMatchObject({ authority: "none", outcome: "review", plannerInput: null });
    expect(result.packageAssessments[0]).toEqual(expect.objectContaining({
      lifecycleStatus: "rejected",
      lifecycleRejectionReason: "invalid_persisted_package",
      provider: null,
      providerPhysicalShipmentId: null,
    }));
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("rejects non-JSON own properties without invoking or exposing accessors", () => {
    const errorForEvidence = (persistedEvidence: unknown) => {
      const input = validInput();
      input.packages[0] = {
        evidenceKey: "provider-package:shipstation:44001",
        persistedEvidence,
      };
      return errorFrom(() => assessPackageAllocationAuthorityReadiness(input));
    };
    const sentinel = "NON_JSON_AUTHORITY_SENTINEL";

    const symbolEvidence = persistedPackage() as PersistedDeclaredPackageEvidence & {
      [key: symbol]: unknown;
    };
    Object.defineProperty(symbolEvidence, Symbol("forgedAuthority"), {
      enumerable: true,
      value: sentinel,
    });
    const symbolError = errorForEvidence(symbolEvidence);
    expect(symbolError.context).toMatchObject({
      evidenceErrorCode: "EVIDENCE_TYPE_UNSUPPORTED",
    });
    expect(JSON.stringify(symbolError)).not.toContain(sentinel);

    const hiddenEvidence = persistedPackage();
    Object.defineProperty(hiddenEvidence, "forgedAuthority", {
      enumerable: false,
      value: sentinel,
    });
    const hiddenError = errorForEvidence(hiddenEvidence);
    expect(hiddenError.context).toMatchObject({
      evidenceErrorCode: "EVIDENCE_TYPE_UNSUPPORTED",
    });
    expect(JSON.stringify(hiddenError)).not.toContain(sentinel);

    let accessorInvoked = false;
    const accessorEvidence = persistedPackage();
    Object.defineProperty(accessorEvidence, "forgedAuthority", {
      enumerable: true,
      get() {
        accessorInvoked = true;
        return sentinel;
      },
    });
    const accessorError = errorForEvidence(accessorEvidence);
    expect(accessorError.context).toMatchObject({
      evidenceErrorCode: "EVIDENCE_TYPE_UNSUPPORTED",
    });
    expect(accessorInvoked).toBe(false);
    expect(JSON.stringify(accessorError)).not.toContain(sentinel);

    let proxyTrapCalls = 0;
    const proxyEvidence = new Proxy(persistedPackage(), {
      get() {
        proxyTrapCalls += 1;
        throw new Error(sentinel);
      },
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error(sentinel);
      },
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error(sentinel);
      },
    });
    const proxyError = errorForEvidence(proxyEvidence);
    expect(proxyError.context).toMatchObject({
      evidenceErrorCode: "EVIDENCE_TYPE_UNSUPPORTED",
    });
    expect(proxyTrapCalls).toBe(0);
    expect(JSON.stringify(proxyError)).not.toContain(sentinel);

    let inheritedPrototypeTrapCalls = 0;
    const inheritedProxyPrototype = new Proxy(Array.prototype, {
      getPrototypeOf() {
        inheritedPrototypeTrapCalls += 1;
        throw new Error(sentinel);
      },
    });
    const inheritedProxyArray: unknown[] = [null];
    Object.setPrototypeOf(inheritedProxyArray, inheritedProxyPrototype);
    const inheritedProxyError = errorForEvidence(inheritedProxyArray);
    expect(inheritedProxyError.context).toMatchObject({
      evidenceErrorCode: "EVIDENCE_TYPE_UNSUPPORTED",
    });
    expect(inheritedPrototypeTrapCalls).toBe(0);

    const customPrototypeArray: unknown[] = [null];
    Object.setPrototypeOf(customPrototypeArray, Object.create(Array.prototype));
    const customPrototypeError = errorForEvidence(customPrototypeArray);
    expect(customPrototypeError.context).toMatchObject({
      evidenceErrorCode: "EVIDENCE_TYPE_UNSUPPORTED",
    });
  });

  it("reports a provider-line subset without claiming exact candidate equality", () => {
    const input = validInput();
    input.packages[0] = {
      evidenceKey: "provider-package:shipstation:44001",
      persistedEvidence: persistedPackage({
        payload: authoritativePayload("44001", "1Z999AA10123456784", [
          { lineItemKey: "wms-item-7001", quantity: 2 },
        ]),
      }),
    };

    const result = assessPackageAllocationAuthorityReadiness(input);

    expect(result.packageAssessments[0]).toEqual(expect.objectContaining({
      candidateSourceStatus: "within_candidate_sources",
      authoritativeContents: [{ wmsShipmentItemId: 7001, quantity: 2 }],
      outsideCandidateSourceIds: [],
    }));
    expect(result.reviews.some(
      (review) => review.code === "package_line_outside_candidate_sources",
    )).toBe(false);
  });

  it("identifies exact provider lines outside the candidate source set", () => {
    const input = validInput();
    input.sourceFacts = [sourceFacts(7001, 2)];

    const result = assessPackageAllocationAuthorityReadiness(input);
    expect(result.packageAssessments[0]).toEqual(expect.objectContaining({
      candidateSourceStatus: "outside_candidate_sources",
      outsideCandidateSourceIds: [7002],
    }));
    expect(result.reviews).toContainEqual({
      code: "package_line_outside_candidate_sources",
      evidenceKeys: ["provider-package:shipstation:44001"],
      wmsShipmentItemIds: [7002],
    });
  });

  it("strictly rejects caller-injected planner authority fields", () => {
    const rootInjection = errorFrom(() => assessPackageAllocationAuthorityReadiness({
      ...validInput(),
      groupKey: "11111111-1111-4111-8111-111111111111",
    } as PackageAllocationAuthorityReadinessInput));
    expect(rootInjection.code).toBe("INVALID_READINESS_INPUT");

    const literalSentinel = "ROOT_LITERAL_SENTINEL_SECRET";
    const literalError = errorFrom(() => assessPackageAllocationAuthorityReadiness({
      ...validInput(),
      authorityMode: literalSentinel,
    } as unknown as PackageAllocationAuthorityReadinessInput));
    expect(literalError.context).toEqual({
      issues: [{
        code: "invalid_literal",
        path: ["authorityMode"],
        message: "Input field failed schema validation",
      }],
    });
    expect(JSON.stringify(literalError)).not.toContain(literalSentinel);

    const input = validInput();
    const packageInput = input.packages[0] as Record<string, unknown>;
    packageInput.membership = { status: "proven", evidenceKey: "forged" };
    packageInput.allocationRole = "primary";
    const packageInjection = errorFrom(() => assessPackageAllocationAuthorityReadiness(input));
    expect(packageInjection.code).toBe("INVALID_READINESS_INPUT");
  });

  it("bounds persisted evidence bytes, nodes, and depth before lifecycle adaptation", () => {
    const inputWithPayloadExtension = (
      field: string,
      value: unknown,
    ): PackageAllocationAuthorityReadinessInput => {
      const input = validInput();
      const persisted = persistedPackage();
      const labelEvent = persisted.labelEvents[0];
      if (labelEvent === undefined) throw new Error("Expected a persisted label event fixture");
      input.packages[0] = {
        evidenceKey: "provider-package:shipstation:44001",
        persistedEvidence: {
          ...persisted,
          labelEvents: [{
            ...labelEvent,
            sanitizedPayload: {
              ...labelEvent.sanitizedPayload,
              [field]: value,
            },
          }],
        },
      };
      return input;
    };

    const byteSentinel = "OVERSIZE_EVIDENCE_SENTINEL";
    const byteError = errorFrom(() => assessPackageAllocationAuthorityReadiness(
      inputWithPayloadExtension(
        "oversizePayload",
        `${byteSentinel}${"x".repeat(4 * 1024 * 1024)}`,
      ),
    ));
    expect(byteError.context).toMatchObject({
      evidenceKey: "provider-package:shipstation:44001",
      evidenceErrorCode: "EVIDENCE_BYTE_BOUND_EXCEEDED",
    });
    expect(JSON.stringify(byteError)).not.toContain(byteSentinel);

    const nodeError = errorFrom(() => assessPackageAllocationAuthorityReadiness(
      inputWithPayloadExtension(
        "excessiveNodes",
        Array.from({ length: 50_001 }, () => null),
      ),
    ));
    expect(nodeError.context).toMatchObject({
      evidenceKey: "provider-package:shipstation:44001",
      evidenceErrorCode: "EVIDENCE_NODE_BOUND_EXCEEDED",
    });

    let excessiveDepth: unknown = "leaf";
    for (let depth = 0; depth < 40; depth += 1) {
      excessiveDepth = { next: excessiveDepth };
    }
    const depthError = errorFrom(() => assessPackageAllocationAuthorityReadiness(
      inputWithPayloadExtension("excessiveDepth", excessiveDepth),
    ));
    expect(depthError.context).toMatchObject({
      evidenceKey: "provider-package:shipstation:44001",
      evidenceErrorCode: "EVIDENCE_DEPTH_EXCEEDED",
    });

    const invalidDateError = errorFrom(() => assessPackageAllocationAuthorityReadiness(
      inputWithPayloadExtension("invalidDate", new Date(Number.NaN)),
    ));
    expect(invalidDateError.context).toMatchObject({
      evidenceKey: "provider-package:shipstation:44001",
      evidenceErrorCode: "EVIDENCE_TYPE_UNSUPPORTED",
    });
  });

  it("enforces aggregate byte and node budgets across package evidence", () => {
    const packageWithPayloadExtension = (
      index: number,
      field: string,
      value: unknown,
    ): PackageAllocationAuthorityReadinessInput["packages"][number] => {
      const persisted = rejectedPackageWithSentinel(`aggregate-package-${index}`);
      const labelEvent = persisted.labelEvents[0];
      if (labelEvent === undefined) throw new Error("Expected a persisted label event fixture");
      return {
        evidenceKey: `provider-package:shipstation:aggregate-${index}`,
        persistedEvidence: {
          ...persisted,
          labelEvents: [{
            ...labelEvent,
            sanitizedPayload: {
              ...labelEvent.sanitizedPayload,
              [field]: value,
            },
          }],
        },
      };
    };

    const byteInput = validInput();
    byteInput.packages = Array.from(
      { length: 3 },
      (_, index) => packageWithPayloadExtension(
        index,
        "aggregateBytes",
        "x".repeat(3 * 1024 * 1024),
      ),
    );
    const byteError = errorFrom(
      () => assessPackageAllocationAuthorityReadiness(byteInput),
    );
    expect(byteError.context).toMatchObject({
      evidenceKey: "provider-package:shipstation:aggregate-2",
      evidenceErrorCode: "EVIDENCE_TOTAL_BYTE_BOUND_EXCEEDED",
    });

    const nodeInput = validInput();
    nodeInput.packages = Array.from(
      { length: 5 },
      (_, index) => packageWithPayloadExtension(
        index,
        "aggregateNodes",
        Array.from({ length: 45_000 }, () => null),
      ),
    );
    const nodeError = errorFrom(
      () => assessPackageAllocationAuthorityReadiness(nodeInput),
    );
    expect(nodeError.context).toMatchObject({
      evidenceKey: "provider-package:shipstation:aggregate-4",
      evidenceErrorCode: "EVIDENCE_TOTAL_NODE_BOUND_EXCEEDED",
    });
  });

  it("rejects root Proxy envelopes without invoking or exposing their traps", () => {
    const sentinel = "ROOT_PROXY_FAILURE_SENTINEL";
    let getterInvoked = false;
    const hostileInput = new Proxy(validInput(), {
      get() {
        getterInvoked = true;
        throw new Error(sentinel);
      },
    });

    const error = errorFrom(() => assessPackageAllocationAuthorityReadiness(hostileInput));

    expect(error.code).toBe("INVALID_READINESS_INPUT");
    expect(error.context).toEqual({ inputErrorCode: "INPUT_ENVELOPE_UNSAFE" });
    expect(getterInvoked).toBe(false);
    expect(JSON.stringify(error)).not.toContain(sentinel);
  });

  it("rejects nested Proxy envelopes before invoking their traps", () => {
    const sentinel = "NESTED_PROXY_FAILURE_SENTINEL";
    let trapCalls = 0;
    const hostileHandler: ProxyHandler<object> = {
      get() {
        trapCalls += 1;
        throw new Error(sentinel);
      },
      getOwnPropertyDescriptor() {
        trapCalls += 1;
        throw new Error(sentinel);
      },
      ownKeys() {
        trapCalls += 1;
        throw new Error(sentinel);
      },
    };

    const packageArrayInput = validInput();
    packageArrayInput.packages = new Proxy(packageArrayInput.packages, hostileHandler);
    const packageArrayError = errorFrom(
      () => assessPackageAllocationAuthorityReadiness(packageArrayInput),
    );

    const sourceRecordInput = validInput();
    sourceRecordInput.sourceFacts[0] = new Proxy(
      sourceRecordInput.sourceFacts[0]!,
      hostileHandler,
    );
    const sourceRecordError = errorFrom(
      () => assessPackageAllocationAuthorityReadiness(sourceRecordInput),
    );

    const packageRecordInput = validInput();
    packageRecordInput.packages[0] = new Proxy(
      packageRecordInput.packages[0]!,
      hostileHandler,
    );
    const packageRecordError = errorFrom(
      () => assessPackageAllocationAuthorityReadiness(packageRecordInput),
    );

    for (const error of [packageArrayError, sourceRecordError, packageRecordError]) {
      expect(error.code).toBe("INVALID_READINESS_INPUT");
      expect(error.context).toEqual({ inputErrorCode: "INPUT_ENVELOPE_UNSAFE" });
      expect(JSON.stringify(error)).not.toContain(sentinel);
    }
    expect(trapCalls).toBe(0);
  });

  it("rejects Proxy leaf values before schema parsing invokes their traps", () => {
    const sentinel = "LEAF_PROXY_FAILURE_SENTINEL";
    let trapCalls = 0;
    const hostileLeaf = new Proxy({}, {
      get() {
        trapCalls += 1;
        throw new Error(sentinel);
      },
    });

    const packageLeafInput = validInput();
    packageLeafInput.packages[0] = {
      ...packageLeafInput.packages[0]!,
      evidenceKey: hostileLeaf as unknown as string,
    };
    const packageLeafError = errorFrom(
      () => assessPackageAllocationAuthorityReadiness(packageLeafInput),
    );

    const sourceLeafInput = validInput();
    sourceLeafInput.sourceFacts[0] = {
      ...sourceLeafInput.sourceFacts[0]!,
      orderItemSku: hostileLeaf as unknown as string,
    };
    const sourceLeafError = errorFrom(
      () => assessPackageAllocationAuthorityReadiness(sourceLeafInput),
    );

    for (const error of [packageLeafError, sourceLeafError]) {
      expect(error.code).toBe("INVALID_READINESS_INPUT");
      expect(error.context).toEqual({ inputErrorCode: "INPUT_ENVELOPE_UNSAFE" });
      expect(JSON.stringify(error)).not.toContain(sentinel);
    }
    expect(trapCalls).toBe(0);
  });

  it("rejects array envelopes with nonstandard prototypes", () => {
    const input = validInput();
    Object.setPrototypeOf(input.packages, Object.create(Array.prototype));

    const error = errorFrom(() => assessPackageAllocationAuthorityReadiness(input));

    expect(error.code).toBe("INVALID_READINESS_INPUT");
    expect(error.context).toEqual({ inputErrorCode: "INPUT_ENVELOPE_UNSAFE" });
  });

  it("hard-fails duplicate diagnostic, source, and provider identities", () => {
    const duplicateEvidence = validInput();
    duplicateEvidence.packages.push(structuredClone(duplicateEvidence.packages[0]!));
    expect(errorFrom(
      () => assessPackageAllocationAuthorityReadiness(duplicateEvidence),
    ).code).toBe("DUPLICATE_EVIDENCE_KEY");

    const duplicateSource = validInput();
    duplicateSource.sourceFacts.push(sourceFacts(7001, 2));
    expect(errorFrom(
      () => assessPackageAllocationAuthorityReadiness(duplicateSource),
    ).code).toBe("DUPLICATE_SOURCE_IDENTITY");

    const duplicateProvider = validInput();
    duplicateProvider.packages.push({
      evidenceKey: "provider-package:shipstation:44001:duplicate",
      persistedEvidence: persistedPackage(),
    });
    expect(errorFrom(
      () => assessPackageAllocationAuthorityReadiness(duplicateProvider),
    ).code).toBe("DUPLICATE_PROVIDER_IDENTITY");
  });

  it("wraps invalid source lineage as a classified readiness input failure", () => {
    const input = validInput();
    input.sourceFacts[0] = {
      ...input.sourceFacts[0]!,
      orderItemSku: "   ",
    };

    const error = errorFrom(() => assessPackageAllocationAuthorityReadiness(input));
    expect(error.code).toBe("INVALID_READINESS_INPUT");
    expect(error.context).toMatchObject({
      sourceWmsShipmentItemId: 7001,
      sourceErrorCode: "SOURCE_SKU_UNPROVEN",
    });
  });

  it("is deterministic under source and package input permutations", () => {
    const firstPackage = persistedPackage({
      payload: authoritativePayload("44001", "1Z999AA10123456784", [
        { lineItemKey: "wms-item-7001", quantity: 2 },
      ]),
    });
    const secondPackage = persistedPackage({
      shippingProviderLabelId: 42,
      providerPhysicalShipmentId: "44002",
      trackingNumber: "1Z999AA10123456785",
      eventId: 102,
      payload: authoritativePayload("44002", "1Z999AA10123456785", [
        { lineItemKey: "wms-item-7002", quantity: 1 },
      ]),
    });
    const forward: PackageAllocationAuthorityReadinessInput = {
      contractVersion: 1,
      authorityMode: "shadow_only",
      sourceFacts: [sourceFacts(7001, 2), sourceFacts(7002, 1)],
      packages: [
        { evidenceKey: "provider-package:shipstation:44001", persistedEvidence: firstPackage },
        { evidenceKey: "provider-package:shipstation:44002", persistedEvidence: secondPackage },
      ],
    };
    const reverse: PackageAllocationAuthorityReadinessInput = {
      ...structuredClone(forward),
      sourceFacts: [...forward.sourceFacts].reverse(),
      packages: [...forward.packages].reverse(),
    };

    const first = assessPackageAllocationAuthorityReadiness(forward);
    const replay = assessPackageAllocationAuthorityReadiness(structuredClone(forward));
    const reversed = assessPackageAllocationAuthorityReadiness(reverse);
    expect(replay).toEqual(first);
    expect(reversed).toEqual(first);
    expect(replay.assessmentHash).toBe(first.assessmentHash);
    expect(reversed.assessmentHash).toBe(first.assessmentHash);
  });

  it("does not mutate inputs and deeply freezes every returned evidence graph", () => {
    const input = validInput();
    const before = structuredClone(input);

    const result = assessPackageAllocationAuthorityReadiness(input);

    expect(input).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sourceRegistrations)).toBe(true);
    expect(Object.isFrozen(result.sourceRegistrations[0])).toBe(true);
    expect(Object.isFrozen(result.packageAssessments)).toBe(true);
    expect(Object.isFrozen(result.packageAssessments[0])).toBe(true);
    expect(Object.isFrozen(result.packageAssessments[0]?.authoritativeContents)).toBe(true);
    expect(Object.isFrozen(result.reviews)).toBe(true);
    expect(Object.isFrozen(result.reviews[0])).toBe(true);
    expect(Object.isFrozen(result.reviews[0]?.evidenceKeys)).toBe(true);
  });
});
