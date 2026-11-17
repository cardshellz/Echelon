import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the test-typecheck ratchet.
 *
 * `tsconfig.tests.json` holds the exclusion list: test files that were already
 * failing when tests were first type-checked. It is debt and must only ever
 * shrink — adding an entry silences a real type error instead of fixing it, and
 * hands back the protection every unlisted file has.
 *
 * The check runs as two halves (server and client) because sources plus every
 * test file exhausts Node's default heap on a CI runner. Both halves inherit the
 * one exclusion list, and between them they must cover everything the base
 * tsconfig compiles, or a whole area could stop being checked unnoticed.
 *
 * If this fails because the count went UP, remove the entry you added and fix
 * the file. If it went DOWN, lower BASELINE — that is the ratchet working.
 */
const BASELINE_EXCLUDED_TEST_FILES = 164;

const LOCKED_EXCLUDED_TEST_FILES = Object.freeze([
  "server/modules/dropship/__tests__/integration/dropship-listing-price.integration.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-admin-carrier-claim.routes.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-admin-carrier-protection.routes.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-admin-ebay-oauth-branding.routes.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-admin-order-ops.routes.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-admin-worker-ops.routes.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-basic-cartonization.provider.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-carrier-claim.repository.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-carrier-protection-service.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-carrier-protection.repository.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-ebay-managed-location.provider.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-ebay-oauth-branding.repository.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-ebay-order-intake.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-ebay-store-category.routes.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-listing-content.routes.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-listing-content.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-listing-media.routes.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-listing-presentation.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-listing-preview-service.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-listing-price-service.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-listing-push-job-runner.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-listing-push-ops.repository.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-listing-shipping-estimate-service.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-listing-shipping-estimate.routes.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-marketplace-registration-adapters.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-notification-ops.repository.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-ops-surface.repository.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-order-acceptance-workflow-service.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-order-acceptance.repository.transaction.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-order-intake-health-notifications.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-order-intake-health.repository.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-order-intake-service.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-order-intake.repository.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-order-ops-service.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-order-ops.repository.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-order-processing-runner.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-passkey-service.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-pricing-rules-service.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-return-fee-engine.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-return-policy-supersede.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-return-service.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-shipping-config-service.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-shipping-config.repository.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-shipping-shadow-comparison.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-shopify-uninstall-webhook.routes.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-shopify-webhook-subscription-provider.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-store-connection-health-severity.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-store-connection-service.test.ts",
  "server/modules/dropship/__tests__/unit/dropship-vendor-catalog.routes.test.ts",
  "server/modules/dropship/__tests__/unit/shared-engine-dropship-shipping.provider.test.ts",
  "server/modules/inventory-planning/__tests__/integration/inventory-availability-foundation.integration.test.ts",
  "server/modules/inventory-planning/__tests__/integration/inventory-publication-target-resume.integration.test.ts",
  "server/modules/inventory-planning/__tests__/integration/quantity-publication-admission.integration.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-availability-activation-dry-run.repository.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-availability-activation-dry-run.service.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-availability-activation.service.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-availability-channel-preview.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-availability-claim.repository.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-availability-foundation.migration-contract.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-availability-master-data.contracts.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-availability-master-data.service.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-availability-phase4.routes.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-availability-runtime-atp.service.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-availability-runtime-claim.repository.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-availability-runtime-claim.service.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-availability-runtime-publication.service.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-availability-runtime-shipment.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-channel-exposure-admin.service.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-channel-exposure.routes.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-channel-quantity-runtime.service.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-cutover-commit.routes.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-cutover-completion.routes.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-cutover-opening.routes.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-cutover-preflight.repository.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-cutover-preflight.routes.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-open-build-cutover-preflight.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-opening-capture.routes.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-publication-outbox.service.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-publication-readback.service.test.ts",
  "server/modules/inventory-planning/__tests__/unit/inventory-runtime-authority.routes.test.ts",
  "server/modules/inventory-planning/__tests__/unit/quantity-publication-recovery.routes.test.ts",
  "server/modules/oms/__tests__/integration/inventory-cutover-receipt-evidence.integration.test.ts",
  "server/modules/oms/__tests__/unit/c2-tx-aware-pipeline.test.ts",
  "server/modules/oms/__tests__/unit/canonical-fulfillment-origin-account.test.ts",
  "server/modules/oms/__tests__/unit/channel-fulfillment-authority.service.test.ts",
  "server/modules/oms/__tests__/unit/channel-fulfillment-conflict.test.ts",
  "server/modules/oms/__tests__/unit/channel-fulfillment-receipt-retry.test.ts",
  "server/modules/oms/__tests__/unit/channel-fulfillment-review-retry.test.ts",
  "server/modules/oms/__tests__/unit/channel-writeback.service.test.ts",
  "server/modules/oms/__tests__/unit/ebay-order-poll-recovery.test.ts",
  "server/modules/oms/__tests__/unit/ebay-tracking-push-regression.test.ts",
  "server/modules/oms/__tests__/unit/fulfillment-sweeper.scheduler.test.ts",
  "server/modules/oms/__tests__/unit/get-external-order-id.test.ts",
  "server/modules/oms/__tests__/unit/historical-shipstation-split-repair.repository.test.ts",
  "server/modules/oms/__tests__/unit/historical-shipstation-split-repair.service.test.ts",
  "server/modules/oms/__tests__/unit/ingest-risk.test.ts",
  "server/modules/oms/__tests__/unit/oms-ops-alert.service.test.ts",
  "server/modules/oms/__tests__/unit/package-allocation-commercial-inheritance.domain.test.ts",
  "server/modules/oms/__tests__/unit/push-shipment.test.ts",
  "server/modules/oms/__tests__/unit/push-shopify-fulfillment.test.ts",
  "server/modules/oms/__tests__/unit/reconcile-v2.test.ts",
  "server/modules/oms/__tests__/unit/refunds-create-cascade.test.ts",
  "server/modules/oms/__tests__/unit/ship-notify-retry.test.ts",
  "server/modules/oms/__tests__/unit/shipstation-physical-recovery.service.test.ts",
  "server/modules/oms/__tests__/unit/shipstation-unmapped-physical.test.ts",
  "server/modules/oms/__tests__/unit/shipstation-unmapped-remediation.service.test.ts",
  "server/modules/procurement/__tests__/audit/receiving-cost-application.audit.test.ts",
  "server/modules/procurement/__tests__/integration/invoice-cost-review.integration.test.ts",
  "server/modules/procurement/__tests__/integration/purchase-approval-authority.integration.test.ts",
  "server/modules/procurement/__tests__/integration/shipment-cost-commands.integration.test.ts",
  "server/modules/procurement/__tests__/integration/shipment-line-commands.integration.test.ts",
  "server/modules/procurement/__tests__/unit/demand-events.routes.test.ts",
  "server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts",
  "server/modules/procurement/__tests__/unit/po-email-outbox.service.test.ts",
  "server/modules/procurement/__tests__/unit/po-email-outbox.worker.test.ts",
  "server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts",
  "server/modules/procurement/__tests__/unit/po-receive-options.routes.test.ts",
  "server/modules/procurement/__tests__/unit/procurement-health.routes.test.ts",
  "server/modules/procurement/__tests__/unit/procurement-health.service.test.ts",
  "server/modules/procurement/__tests__/unit/procurement-report.routes.test.ts",
  "server/modules/procurement/__tests__/unit/purchase-order-duplicate-quotes.service.test.ts",
  "server/modules/procurement/__tests__/unit/purchase-replacement-forecast.test.ts",
  "server/modules/procurement/__tests__/unit/purchase-workspace.repository.test.ts",
  "server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts",
  "server/modules/procurement/__tests__/unit/receiving-mills.test.ts",
  "server/modules/procurement/__tests__/unit/receiving.routes.test.ts",
  "server/modules/procurement/__tests__/unit/recommendation-po-handoff-delete-guards.service.test.ts",
  "server/modules/procurement/__tests__/unit/rfq-workflow.routes.test.ts",
  "server/modules/procurement/__tests__/unit/shipment-close-atomicity.test.ts",
  "server/modules/procurement/__tests__/unit/shipment-cost-http.test.ts",
  "server/modules/procurement/__tests__/unit/shipment-line-http.test.ts",
  "server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts",
  "server/modules/procurement/__tests__/unit/shippable-lines.routes.test.ts",
  "server/modules/shipping-engine/__tests__/unit/carrier-callback.test.ts",
  "server/modules/shipping-engine/__tests__/unit/fulfillment-provider-connections.service.test.ts",
  "server/modules/shipping-engine/__tests__/unit/fulfillment-routing.repository.test.ts",
  "server/modules/shipping-engine/__tests__/unit/fulfillment-routing.service.test.ts",
  "server/modules/shipping-engine/__tests__/unit/manual-rate-quote.test.ts",
  "server/modules/shipping-engine/__tests__/unit/rate-program-clone.routes.test.ts",
  "server/modules/shipping-engine/__tests__/unit/rate-program-clone.service.test.ts",
  "server/modules/shipping-engine/__tests__/unit/shadow-quote.test.ts",
  "server/modules/shipping-engine/__tests__/unit/shipment-quote.test.ts",
  "server/modules/shipping-engine/__tests__/unit/storefront-rate-preview.routes.test.ts",
  "server/modules/shipping/__tests__/integration/package-allocation-ledger.repository.integration.test.ts",
  "server/modules/shipping/__tests__/unit/c9-engine-port.test.ts",
  "server/modules/shipping/__tests__/unit/carrier-tracking-label-poll.service.test.ts",
  "server/modules/shipping/__tests__/unit/carrier-tracking.service.test.ts",
  "server/modules/shipping/__tests__/unit/declared-package-lifecycle.domain.test.ts",
  "server/modules/shipping/__tests__/unit/historical-shipstation-contents-attestation.service.test.ts",
  "server/modules/shipping/__tests__/unit/historical-shipstation-contents-audit.client.test.ts",
  "server/modules/shipping/__tests__/unit/historical-shipstation-contents-audit.repository.test.ts",
  "server/modules/shipping/__tests__/unit/historical-shipstation-contents-correction.service.test.ts",
  "server/modules/shipping/__tests__/unit/historical-shipstation-contents-review.service.test.ts",
  "server/modules/shipping/__tests__/unit/historical-shipstation-contents-system-recovery.service.test.ts",
  "server/modules/shipping/__tests__/unit/package-allocation-authority-discovery-execution-audit.repository.test.ts",
  "server/modules/shipping/__tests__/unit/package-allocation-authority-discovery-plan-audit.repository.test.ts",
  "server/modules/shipping/__tests__/unit/package-allocation-authority-readiness.domain.test.ts",
  "server/modules/shipping/__tests__/unit/package-allocation-authority-resolution.domain.test.ts",
  "server/modules/shipping/__tests__/unit/package-allocation-ledger.repository.test.ts",
  "server/modules/shipping/__tests__/unit/package-allocation-planning.service.test.ts",
  "server/modules/shipping/__tests__/unit/reconcile-derive.test.ts",
  "server/modules/shipping/__tests__/unit/shipping-engine.test.ts",
  "server/modules/shipping/__tests__/unit/shipstation-physical-recovery.client.test.ts",
  "server/modules/shipping/__tests__/unit/shipstation-tracking-webhook.routes.test.ts",
]);
const LOCKED_EXCLUDED_TEST_FILES_SET = new Set<string>(LOCKED_EXCLUDED_TEST_FILES);

const FIXED_EXCLUSIONS = ["node_modules", "build", "dist"];
const HALVES = ["tsconfig.tests.server.json", "tsconfig.tests.client.json"];

/** These configs are JSON with a leading comment block, which JSON.parse rejects. */
function readConfig(name: string): { include?: string[]; exclude?: string[]; extends?: string } {
  const raw = readFileSync(join(process.cwd(), name), "utf8");
  return JSON.parse(raw.slice(raw.indexOf("{")));
}

function ratchetExclusions(): string[] {
  return (readConfig("tsconfig.tests.json").exclude ?? [])
    .filter((entry) => !FIXED_EXCLUSIONS.includes(entry));
}

describe("test typecheck ratchet", () => {
  it("never grows the exclusion list", () => {
    expect(ratchetExclusions().length).toBeLessThanOrEqual(BASELINE_EXCLUDED_TEST_FILES);
  });

  it("keeps BASELINE honest so the ratchet cannot silently slacken", () => {
    expect(ratchetExclusions().length).toBe(BASELINE_EXCLUDED_TEST_FILES);
  });

  it("excludes only real test files, so no source file can hide in the list", () => {
    for (const entry of ratchetExclusions()) {
      expect(entry).toMatch(/\.test\.tsx?$/);
    }
  });

  it("locks the exact excluded test paths so no newly broken test can be swapped in", () => {
    expect(LOCKED_EXCLUDED_TEST_FILES.length).toBe(BASELINE_EXCLUDED_TEST_FILES);
    const current = ratchetExclusions();
    expect(new Set(current).size).toBe(current.length);
    const unauthorized = current.filter((entry) => !LOCKED_EXCLUDED_TEST_FILES_SET.has(entry));
    expect(unauthorized).toEqual([]);
  });

  it("covers every area the base tsconfig compiles, so no half is left unchecked", () => {
    const base = new Set(readConfig("tsconfig.json").include ?? []);
    const covered = new Set(HALVES.flatMap((half) => readConfig(half).include ?? []));
    expect(base.size).toBeGreaterThan(0);
    for (const area of base) {
      expect(covered).toContain(area);
    }
  });

  it("keeps both halves on the single shared exclusion list", () => {
    for (const half of HALVES) {
      const config = readConfig(half);
      expect(config.extends).toBe("./tsconfig.tests.json");
      // An own `exclude` would replace the inherited list rather than extend it.
      expect(config.exclude).toBeUndefined();
    }
  });
});
