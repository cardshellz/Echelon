import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repositorySource = readFileSync(
  join(here, "..", "..", "carrier-tracking.repository.ts"),
  "utf8",
);
const migrationSource = readFileSync(
  join(
    here,
    "..",
    "..",
    "..",
    "..",
    "..",
    "migrations",
    "165_carrier_dispatch_authority_cutover.sql",
  ),
  "utf8",
);
const requeueMigrationSource = readFileSync(
  join(
    here,
    "..",
    "..",
    "..",
    "..",
    "..",
    "migrations",
    "0594_carrier_tracking_subscription_requeues.sql",
  ),
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

  it("matches tracking identity without equating carrier-account and tracking-carrier codes", () => {
    const matchStart = repositorySource.indexOf("async findMatchCandidates(event)");
    const appendStart = repositorySource.indexOf("async appendMatchAttempt(", matchStart);
    const matchSource = repositorySource.slice(matchStart, appendStart);

    expect(matchStart).toBeGreaterThan(-1);
    expect(matchSource).toContain(
      "AND label.normalized_tracking_number = ${event.normalizedTrackingNumber}",
    );
    expect(matchSource).not.toContain(
      "AND LOWER(BTRIM(label.carrier)) = ${event.carrier}",
    );
    expect(matchSource).not.toContain(
      "AND ${event.carrier}::text IS NOT NULL",
    );
  });

  it("does not fall back when a provider label id exists with conflicting tracking identity", () => {
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

  it("keeps delayed link reconciliation arithmetic in timestamptz", () => {
    expect(repositorySource).toContain(
      "${reconciledAt}::timestamptz + INTERVAL '30 minutes'",
    );
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

  it("audits guarded subscription requeues before moving review state back to pending", () => {
    const requeueStart = repositorySource.indexOf(
      "async requeueReviewedTrackingSubscriptions(input)",
    );
    const nextMethod = repositorySource.indexOf(
      "async claimDispatchCommands(",
      requeueStart,
    );
    const requeueSource = repositorySource.slice(requeueStart, nextMethod);
    const auditInsert = requeueSource.indexOf(".insert(carrierTrackingSubscriptionRequeues)");
    const projectionUpdate = requeueSource.indexOf(".update(carrierTrackingSubscriptions)");

    expect(requeueStart).toBeGreaterThan(-1);
    expect(requeueSource).toContain("FOR UPDATE OF subscription SKIP LOCKED");
    expect(requeueSource).toContain("rerun dry-run");
    expect(auditInsert).toBeGreaterThan(-1);
    expect(projectionUpdate).toBeGreaterThan(auditInsert);
    expect(requeueMigrationSource).toContain(
      "uq_carrier_tracking_subscription_requeues_idempotency",
    );
    expect(requeueMigrationSource).toContain("previous_status = 'review'");
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

  it("enqueues one dispatch command per immutable provider label", () => {
    const enqueueStart = repositorySource.indexOf("async enqueueDispatchCommand(");
    const transactionEnd = repositorySource.indexOf(
      "async function resolveProviderLabelLinks",
      enqueueStart,
    );
    const enqueueSource = repositorySource.slice(enqueueStart, transactionEnd);

    expect(enqueueStart).toBeGreaterThan(-1);
    expect(enqueueSource).toContain(".insert(carrierDispatchCommands)");
    expect(enqueueSource).toContain("shippingProviderLabelId");
    expect(enqueueSource).toContain("onConflictDoNothing");
    expect(migrationSource).toContain("UNIQUE(shipping_provider_label_id)");
    expect(migrationSource).toContain("source VARCHAR(60) NOT NULL");
    expect(migrationSource).toContain("created_by VARCHAR(200) NOT NULL");
    expect(enqueueSource).toContain('source: "carrier_tracking_reconciler"');
    expect(enqueueSource).toContain('createdBy: "system:carrier_tracking"');
  });

  it("claims dispatch work with expired-lease recovery and row-level skip locking", () => {
    const claimStart = repositorySource.indexOf("async claimDispatchCommands(");
    const finalizeStart = repositorySource.indexOf("async finalizeDispatchAttempt(input)");
    const claimSource = repositorySource.slice(claimStart, finalizeStart);

    expect(claimStart).toBeGreaterThan(-1);
    expect(claimSource).toContain("FOR UPDATE SKIP LOCKED");
    expect(claimSource).toContain("command.status = 'processing'");
    expect(claimSource).toContain("command.lease_expires_at <= ${asOf}");
    expect(claimSource).toContain("normalizedLeaseOwner.length > 150");
    expect(claimSource).toContain("txid_current()::text");
    expect(claimSource).toContain("|| ':' || command.id::text");
  });

  it("appends a dispatch attempt before projection finalization and replays its persisted outcome", () => {
    const finalizationStart = repositorySource.indexOf(
      "async finalizeDispatchAttempt(input)",
    );
    const finalizationSource = repositorySource.slice(finalizationStart);
    const attemptInsert = finalizationSource.indexOf(".insert(carrierDispatchAttempts)");
    const projectionUpdate = finalizationSource.indexOf(".update(carrierDispatchCommands)");

    expect(finalizationStart).toBeGreaterThan(-1);
    expect(finalizationSource).toContain("FOR UPDATE");
    expect(finalizationSource).toContain(
      "state.lease_owner !== input.leaseOwner",
    );
    expect(finalizationSource).toContain(
      "Number(state.attempt_count) !== input.attemptNumber",
    );
    expect(finalizationSource).toContain(
      "outcome: carrierDispatchAttempts.attemptOutcome",
    );
    expect(finalizationSource).toContain(
      "outcome: carrierDispatchAttemptOutcome(existing[0].outcome)",
    );
    expect(attemptInsert).toBeGreaterThan(-1);
    expect(projectionUpdate).toBeGreaterThan(attemptInsert);
  });

  it("makes dispatch attempts append-only at the database boundary", () => {
    expect(migrationSource).toContain(
      "CREATE TRIGGER carrier_dispatch_attempts_immutable",
    );
    expect(migrationSource).toContain(
      "EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation()",
    );
  });
});
