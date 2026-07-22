import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repositorySource = readFileSync(
  join(here, "..", "..", "carrier-tracking.repository.ts"),
  "utf8",
);

describe("carrier tracking repository concurrency contract", () => {
  it("serializes provider-label observation on tracking identity before label identity", () => {
    const observationStart = repositorySource.indexOf("async observeProviderLabel(observation)");
    const reconciliationStart = repositorySource.indexOf(
      "async reconcileProviderLabelLinks(provider, providerLabelId, reconciledAt)",
    );
    const observationSource = repositorySource.slice(observationStart, reconciliationStart);
    const trackingLock = observationSource.indexOf("carrier_tracking:${observation.provider}");
    const labelLock = observationSource.indexOf("shipping_provider_label:${observation.provider}");

    expect(observationStart).toBeGreaterThan(-1);
    expect(trackingLock).toBeGreaterThan(-1);
    expect(labelLock).toBeGreaterThan(trackingLock);
  });

  it("reopens prior matches when a provider-label candidate changes", () => {
    expect(repositorySource).toContain(
      "LEFT JOIN wms.carrier_tracking_reconciliation_state AS state",
    );
    expect(repositorySource).toContain(
      "label.updated_at > state.last_reconciled_at",
    );
    expect(repositorySource).toMatch(
      /\.onConflictDoUpdate\(\{\s+target: carrierTrackingReconciliationState\.carrierTrackingEventId/,
    );
  });

  it("requires carrier identity when matching by tracking-number fallback", () => {
    expect(repositorySource).toContain(
      "AND ${event.carrier}::text IS NOT NULL",
    );
    expect(repositorySource).toContain(
      "AND LOWER(BTRIM(label.carrier)) = ${event.carrier}",
    );
  });

  it("does not fall back when an exact provider label exists with conflicting carrier identity", () => {
    const matchStart = repositorySource.indexOf("async findMatchCandidates(event)");
    const appendStart = repositorySource.indexOf("async appendMatchAttempt(", matchStart);
    const matchSource = repositorySource.slice(matchStart, appendStart);

    expect(matchStart).toBeGreaterThan(-1);
    expect(matchSource).toContain("WITH provider_identity AS");
    expect(matchSource).toContain("NOT EXISTS (SELECT 1 FROM provider_identity)");
    expect(matchSource).not.toContain("NOT EXISTS (SELECT 1 FROM exact_identity)");
  });

  it("requires the immutable tracking identity even for an exact provider label match", () => {
    const matchStart = repositorySource.indexOf("async findMatchCandidates(event)");
    const appendStart = repositorySource.indexOf("async appendMatchAttempt(", matchStart);
    const matchSource = repositorySource.slice(matchStart, appendStart);

    expect(matchSource).toContain(
      "AND label.normalized_tracking_number = ${event.normalizedTrackingNumber}",
    );
  });

  it("links a combined provider label to every exact Echelon shipment-item owner", () => {
    const reconciliationStart = repositorySource.indexOf(
      "async reconcileProviderLabelLinks(provider, providerLabelId, reconciledAt)",
    );
    const reconciliationSource = repositorySource.slice(reconciliationStart);

    expect(reconciliationStart).toBeGreaterThan(-1);
    expect(reconciliationSource).toContain("provider_item_targets AS");
    expect(reconciliationSource).toContain("jsonb_array_elements(");
    expect(reconciliationSource).toContain("'^wms-item-[1-9][0-9]*$'");
    expect(reconciliationSource).toContain("JOIN wms.outbound_shipment_items AS source_item");
    expect(reconciliationSource).toContain("'provider_line_item_identity'::text AS source");
  });

  it("claims subscription work with leases and row-level skip locking", () => {
    expect(repositorySource).toContain("async claimTrackingSubscriptions(");
    expect(repositorySource).toContain("FOR UPDATE SKIP LOCKED");
    expect(repositorySource).toContain("subscription_status = 'processing'");
    expect(repositorySource).toContain("lease_expires_at <= ${asOf}");
  });

  it("claims webhook hydration work with leases and row-level skip locking", () => {
    const claimStart = repositorySource.indexOf("async claimWebhookHydrations(");
    const finalizeStart = repositorySource.indexOf("async finalizeWebhookHydrationAttempt(input)");
    const claimSource = repositorySource.slice(claimStart, finalizeStart);

    expect(claimStart).toBeGreaterThan(-1);
    expect(claimSource).toContain("FOR UPDATE SKIP LOCKED");
    expect(claimSource).toContain("hydration_status = 'processing'");
    expect(claimSource).toContain("lease_expires_at <= ${asOf}");
    expect(claimSource).toContain("receipt.verified_at AS webhook_verified_at");
  });

  it("enrolls only live label artifacts and never voided or superseded labels", () => {
    const preparationStart = repositorySource.indexOf("async prepareTrackingSubscriptions(");
    const claimStart = repositorySource.indexOf("async claimTrackingSubscriptions(");
    const preparationSource = repositorySource.slice(preparationStart, claimStart);

    expect(preparationStart).toBeGreaterThan(-1);
    expect(preparationSource.match(/label\.label_status IN \('active', 'unknown'\)/g))
      .toHaveLength(2);
  });

  it("appends each provider attempt before updating the mutable subscription projection", () => {
    const finalizationStart = repositorySource.indexOf(
      "async finalizeTrackingSubscriptionAttempt(input)",
    );
    const finalizationSource = repositorySource.slice(finalizationStart);
    const attemptInsert = finalizationSource.indexOf(".insert(carrierTrackingSubscriptionAttempts)");
    const projectionUpdate = finalizationSource.indexOf(".update(carrierTrackingSubscriptions)");

    expect(finalizationStart).toBeGreaterThan(-1);
    expect(attemptInsert).toBeGreaterThan(-1);
    expect(projectionUpdate).toBeGreaterThan(attemptInsert);
  });

  it("atomically appends hydrated evidence and its attempt before updating the hydration projection", () => {
    const finalizationStart = repositorySource.indexOf(
      "async finalizeWebhookHydrationAttempt(input)",
    );
    const observationStart = repositorySource.indexOf("async observeProviderLabel(observation)");
    const finalizationSource = repositorySource.slice(finalizationStart, observationStart);
    const eventInsert = finalizationSource.indexOf("insertOrGetCarrierTrackingEvent");
    const parseInsert = finalizationSource.indexOf("insertOrGetCarrierTrackingWebhookReceiptParse");
    const attemptInsert = finalizationSource.indexOf(
      ".insert(carrierTrackingWebhookHydrationAttempts)",
    );
    const projectionUpdate = finalizationSource.indexOf(
      ".update(carrierTrackingWebhookHydrations)",
    );

    expect(finalizationStart).toBeGreaterThan(-1);
    expect(finalizationSource).toContain("FOR UPDATE");
    expect(eventInsert).toBeGreaterThan(-1);
    expect(parseInsert).toBeGreaterThan(eventInsert);
    expect(attemptInsert).toBeGreaterThan(parseInsert);
    expect(projectionUpdate).toBeGreaterThan(attemptInsert);
  });
});
