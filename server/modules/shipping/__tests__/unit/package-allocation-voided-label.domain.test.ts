import { describe, expect, it } from "vitest";
import { normalizeShipStationLabelObservation } from "../../carrier-tracking.domain";
import type { PersistedDeclaredPackageEvidence } from "../../declared-package-lifecycle-shadow.domain";
import { assessVoidedLabelExclusion, type VoidedLabelPostingFacts } from "../../package-allocation-voided-label.domain";
import { resolvePackageAllocationAuthorityEvidence } from "../../package-allocation-authority-resolution.service";
import { packageAllocationGroupPreviousPlanSchema } from "../../package-allocation-group.domain";

const groupKey = "86e1be0d-c7d8-4c91-919f-04f5eb547f79";
const sourceId = 7001;
const sourceFacts: Parameters<typeof resolvePackageAllocationAuthorityEvidence>[0]["sourceFacts"] = [{ sourceWmsShipmentItemId: sourceId, shipmentRequestItemId: "90001", sourceQuantity: 2,
  shipmentItemPurpose: "customer_fulfillment", orderItemId: 8001, replacementForOrderItemId: null,
  correctionForShipmentItemId: null, productVariantId: 9001, orderItemSku: "SLEEVE-CASE",
  replacementOrderItemSku: null, productVariantSku: "SLEEVE-CASE" }];

function evidence(id = 41, quantities = [1, 2], voided = true): PersistedDeclaredPackageEvidence {
  const events = quantities.map((quantity, index) => {
    const observation = normalizeShipStationLabelObservation({
      shipmentId: id, orderId: 500, trackingNumber: `TRACK-${id}`, isReturnLabel: false,
      shipDate: "2026-09-10", voidDate: voided ? "2026-09-10T09:38:29.5370000" : null,
      shipmentItems: quantity === 0 ? [] : [{ lineItemKey: `wms-item-${sourceId}`, quantity }],
    }, new Date(`2026-09-${voided ? "10" : "16"}T${17 + index}:00:${String(id % 60).padStart(2, "0")}Z`));
    return { id: id * 100 + index, shippingProviderLabelId: id, eventHash: observation.eventHash,
      eventType: observation.eventType, labelStatus: observation.labelStatus,
      trackingNumber: observation.trackingNumber, providerOccurredAt: observation.providerOccurredAt?.toISOString() ?? null,
      sanitizedPayload: observation.sanitizedPayload, receivedAt: observation.observedAt.toISOString() };
  });
  return { shippingProviderLabelId: id, provider: "shipstation", providerPhysicalShipmentId: String(id),
    currentTrackingNumber: `TRACK-${id}`, currentLabelStatus: voided ? "voided" : "active", labelDirection: "outbound",
    firstObservedAt: events[0].receivedAt, lastObservedAt: events[events.length - 1].receivedAt,
    labelEvents: events, confirmedCarrierEvents: [] };
}

function facts(): VoidedLabelPostingFacts {
  return { shippingProviderLabelId: 41, provider: "shipstation", providerPhysicalShipmentId: "41",
    trackingNumber: "TRACK-41", hasOrderScope: true, hasAllocationBinding: false,
    hasPhysicalPackage: false, hasLegacyPackage: false, hasChannelCommand: false, hasChannelReceipt: false };
}

function resolve(packages: Parameters<typeof resolvePackageAllocationAuthorityEvidence>[0]["packages"],
  previousPlan: Parameters<typeof resolvePackageAllocationAuthorityEvidence>[0]["previousPlan"] = null) {
  return resolvePackageAllocationAuthorityEvidence({ groupKey, expectedGroupVersion: previousPlan ? 1 : 0,
    previousPlan, sourceFacts, packages, actions: [] });
}

function previousPlanFor(result: ReturnType<typeof resolve>) {
  const planner = result.resolution!.plannerResult;
  return packageAllocationGroupPreviousPlanSchema.parse({ groupKey, groupVersion: 1, stateHash: planner.stateHash,
    sourceEvidence: planner.state.sourceEvidence, packageEvidence: planner.state.packageEvidence,
    effectIntentEvidence: planner.state.effectIntentEvidence, actionEvidence: [], appliedActionKeys: [] });
}

describe("voided package exclusion", () => {
  it.each([{ quantities: [1, 2] }, { quantities: [2] }, { quantities: [0] }])("retires unposted voided history without inventing its contents: %j", ({ quantities }) => {
    const input = evidence(41, quantities);
    const original = structuredClone(input);
    expect(assessVoidedLabelExclusion("shipping-provider-label:41", input, facts())).toMatchObject({
      reason: "voided_without_posting_or_allocation", postingFacts: facts(),
    });
    expect(input).toEqual(original);
  });

  it.each(["hasAllocationBinding", "hasPhysicalPackage", "hasLegacyPackage", "hasChannelCommand", "hasChannelReceipt"] as const)(
    "keeps a canceled package with %s in reconciliation", key => {
      expect(assessVoidedLabelExclusion("shipping-provider-label:41", evidence(), { ...facts(), [key]: true })).toBeNull();
    });

  it.each([undefined, null, {}, { ...facts(), hasOrderScope: false }, { ...facts(), shippingProviderLabelId: 42 },
    { ...facts(), providerPhysicalShipmentId: "42" }, { ...facts(), trackingNumber: "DIFFERENT" }])(
    "does not infer absence of postings from missing, invalid, or mismatched evidence", footprint => {
      expect(assessVoidedLabelExclusion("shipping-provider-label:41", evidence(), footprint)).toBeNull();
    });

  it("keeps active labels and tampered histories in reconciliation", () => {
    expect(assessVoidedLabelExclusion("shipping-provider-label:41", evidence(41, [1, 2], false), facts())).toBeNull();
    const input = evidence();
    const tampered = { ...input, labelEvents: [{ ...input.labelEvents[0], eventHash: "0".repeat(64) }, ...input.labelEvents.slice(1)] };
    expect(assessVoidedLabelExclusion("shipping-provider-label:41", tampered, facts())).toBeNull();
  });

  it("keeps a voided package with carrier possession in reconciliation", () => {
    const input = { ...evidence(), confirmedCarrierEvents: [{ id: 999, shippingProviderLabelId: 41,
      dispatchEvidence: "confirmed" as const, currentMatchStatus: "voided_label" as const,
      eventOccurredAt: "2026-09-10T16:00:00Z", receivedAt: "2026-09-10T19:00:00Z" }] };
    expect(assessVoidedLabelExclusion("shipping-provider-label:41", input, facts())).toBeNull();
  });

  it("plans two one-unit parcels, retains the voided conflict in audit, and is deterministic", () => {
    const packages = [{ evidenceKey: "shipping-provider-label:41", persistedEvidence: evidence(), voidedLabelPostingFacts: facts() },
      ...[42, 43].map(id => ({ evidenceKey: `shipping-provider-label:${id}`, persistedEvidence: evidence(id, [1], false) }))];
    const result = resolve(packages);
    expect(result.resolution).toMatchObject({ outcome: "proposed", reviews: [] });
    expect(result.excludedVoidedLabelEvidence).toHaveLength(1);
    expect(result.packages).toHaveLength(3);
    expect(result.readiness.packageAssessments.find(pkg => pkg.evidenceKey === "shipping-provider-label:41")?.authoritativeContents).toEqual([]);
    expect(result.resolution!.plannerResult.state.desiredEffectIntents.filter(intent => intent.effectType === "commercial_fulfillment")
      .map(intent => intent.quantity).sort()).toEqual([1, 1]);
    expect(resolve([...packages].reverse())).toEqual(result);
    const previous = previousPlanFor(result);
    expect(resolve(packages, previous).resolution?.outcome).toBe("unchanged");
  });

  it("does not bypass the source quantity cap", () => {
    const result = resolve([{ evidenceKey: "shipping-provider-label:41", persistedEvidence: evidence(), voidedLabelPostingFacts: facts() },
      ...[42, 43, 44].map(id => ({ evidenceKey: `shipping-provider-label:${id}`, persistedEvidence: evidence(id, [1], false) }))]);
    expect(result.resolution?.outcome).toBe("review");
  });

  it("never drops a package already held by a previous plan", () => {
    const first = resolve([{ evidenceKey: "shipping-provider-label:41", persistedEvidence: evidence(41, [2]) }]);
    const previous = previousPlanFor(first);
    const result = resolve([{ evidenceKey: "shipping-provider-label:41", persistedEvidence: evidence(41, [2, 1]), voidedLabelPostingFacts: facts() }], previous);
    expect(result.excludedVoidedLabelEvidence).toEqual([]);
    expect(result.resolution?.outcome).toBe("review");
  });
});
