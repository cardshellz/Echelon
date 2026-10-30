import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { POSTGRES_SHARD_COUNT, POSTGRES_TEST_FILES } from "../../../scripts/ci/postgres-test-manifest";
import { MAX_POSTGRES_FILE_DURATION_MS, planPostgresShards } from "../../../scripts/ci/postgres-shard-planner";
import { POSTGRES_TEST_DURATION_MS, POSTGRES_TIMING_SNAPSHOT, parsePostgresTimingSnapshot } from "../../../scripts/ci/postgres-test-timings";
import {
  POSTGRES_REPOSITORY_ROOT,
  buildPostgresVitestArgs,
  createOwnedDatabaseName,
  parsePostgresShard,
  runPostgresShard,
  selectPostgresShardFiles,
  validatePostgresManifest,
  validatePostgresTestEnvironment,
  type PostgresAdminConnection,
  type PostgresRunnerDependencies,
} from "../../../scripts/ci/postgres-tests";

const firstShardFileCount = selectPostgresShardFiles({ index: 1, count: POSTGRES_SHARD_COUNT }).length;
const disposableEnvironment: NodeJS.ProcessEnv = {
  ECHELON_TEST_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/echelon_test",
  ECHELON_TEST_DATABASE_DISPOSABLE: "true",
};

function runnerFixture() {
  const connections: Array<{
    connect: ReturnType<typeof vi.fn<PostgresAdminConnection["connect"]>>;
    query: ReturnType<typeof vi.fn<PostgresAdminConnection["query"]>>;
    end: ReturnType<typeof vi.fn<PostgresAdminConnection["end"]>>;
  }> = [];
  const events: string[] = [];
  let nextId = 0;
  const createAdminConnection = vi.fn((connectionString: string) => {
    expect(connectionString).toBe(disposableEnvironment.ECHELON_TEST_DATABASE_URL);
    const connection = {
      connect: vi.fn(async () => { events.push("connect"); }),
      query: vi.fn(async (statement: string) => { events.push(statement); }),
      end: vi.fn(async () => { events.push("end"); }),
    };
    connections.push(connection);
    return connection;
  });
  const dependencies: PostgresRunnerDependencies = {
    createAdminConnection,
    randomId: vi.fn(() => "00000000-0000-4000-8000-" + String(++nextId).padStart(12, "0")),
    runTest: vi.fn(() => {
      events.push("run");
      return { status: 0, signal: null, pid: 1, output: [], stdout: null, stderr: null };
    }),
    info: vi.fn(),
    error: vi.fn(),
  };
  return { dependencies, createAdminConnection, connections, events };
}

describe("PostgreSQL CI coverage and isolation", () => {
  it("preserves prior coverage with the explicitly retired duplicate invoice owner, the retired bulk policy writer suite and reviewed additions", () => {
    const addedSuites = [
      "server/modules/oms/__tests__/integration/shopify-paid-event-replay.integration.test.ts",
      "server/modules/catalog/__tests__/integration/shopify-product-connection.integration.test.ts",
      "server/modules/oms/__tests__/integration/package-reconciliation.integration.test.ts",
      "server/modules/procurement/__tests__/integration/shipment-cost-read-batching.integration.test.ts",
      "server/modules/shipping/__tests__/integration/package-dimensions.integration.test.ts",
      "server/modules/shipping/__tests__/integration/package-history.integration.test.ts",
      "server/modules/customer-account/__tests__/integration/order-action-projection.repository.test.ts",
      "server/modules/procurement/__tests__/integration/document-relationships.integration.test.ts",
      "server/modules/customer-account/__tests__/integration/customer-account-order-context.integration.test.ts",
      "server/modules/marketplace-listings/__tests__/integration/channel-sync-batch.integration.test.ts",
      "server/modules/channels/__tests__/integration/channel-listing-feed.integration.test.ts",
      "server/modules/procurement/__tests__/integration/rfq-work-list.integration.test.ts",
      "server/modules/procurement/__tests__/integration/supplier-credit.integration.test.ts",
      "server/modules/channels/__tests__/integration/channel-pricing-owner.integration.test.ts",
      "server/modules/channels/__tests__/integration/channel-pricing-routes.integration.test.ts",
      "server/modules/channels/__tests__/integration/channel-price-provenance.integration.test.ts",
      "server/modules/marketplace-listings/__tests__/integration/prepared-channel-intent.integration.test.ts",
      "server/modules/marketplace-listings/__tests__/integration/listing-intent-propagation.integration.test.ts",
      "server/modules/marketplace-listings/__tests__/integration/listing-intent-lifecycle.integration.test.ts",
      "server/modules/procurement/__tests__/integration/shipment-create-recovery.integration.test.ts",
      "server/modules/procurement/__tests__/integration/shipment-work-list.integration.test.ts",
      "server/modules/procurement/__tests__/integration/ap-work-lists.integration.test.ts",
      "server/modules/procurement/__tests__/integration/procurement-settings.integration.test.ts",
      "server/modules/procurement/__tests__/integration/supplier-evidence-import.integration.test.ts",
      "server/modules/procurement/__tests__/integration/purchase-rfq-requests.integration.test.ts",
      "server/modules/warehouse/__tests__/integration/warehouse-settings-ownership.integration.test.ts",
      "server/modules/marketplace-listings/__tests__/integration/walmart-recreation-stock.integration.test.ts",
      "server/modules/channels/__tests__/integration/channel-stock-selection.integration.test.ts",
      "server/modules/dropship/__tests__/integration/dropship-stock-publication-selection.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/publication-selection-work.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/quantity-publication-catchup-archive.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/stock-selection-publication-flow.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/inventory-publication-readback-selection.integration.test.ts",
      "server/modules/procurement/__tests__/integration/po-quantity-amendment.integration.test.ts",
      "server/modules/inventory/__tests__/integration/lot-cost-ownership.integration.test.ts",
      "server/modules/inventory/__tests__/integration/lot-number-allocation.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/inventory-cutover-history-reader.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/inventory-cutover-history.integration.test.ts",
      "server/modules/catalog/__tests__/integration/inventory-tracking-policy.integration.test.ts",
      "server/modules/orders/__tests__/integration/order-list.integration.test.ts",
      "server/modules/orders/__tests__/integration/order-country-integrity.integration.test.ts",
      "server/modules/orders/__tests__/integration/order-country-writers.integration.test.ts",
      "server/modules/orders/__tests__/integration/combining-country.integration.test.ts",
      "server/modules/orders/__tests__/integration/shipping-progress.integration.test.ts",
      "server/modules/oms/__tests__/integration/archon-order-delivery.test.ts",
      "server/modules/oms/__tests__/integration/order-line-catalog-identity.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/inventory-opening-capture.integration.test.ts",
      "server/modules/inventory/__tests__/integration/cost-report-reads.integration.test.ts",
      "server/modules/procurement/__tests__/integration/shipment-purchase-orders.integration.test.ts",
      "server/modules/procurement/__tests__/integration/receiving-close-integrity.integration.test.ts",
      "server/modules/procurement/__tests__/integration/receiving-audit-immutability.integration.test.ts",
      "server/modules/procurement/__tests__/integration/procurement-rfq-controlled-acceptance.integration.test.ts",
      "server/modules/procurement/__tests__/integration/procurement-flow-cost-controlled-acceptance.integration.test.ts",
      "server/modules/procurement/__tests__/integration/procurement-payment-controlled-acceptance.integration.test.ts",
      "server/modules/procurement/__tests__/integration/document-number-prefix-indexes.integration.test.ts",
      "server/modules/dropship/__tests__/integration/dropship-canonical-acceptance-stage.integration.test.ts",
      // eBay adoption account identity: the reader's SQL ownership proof and the loader/reader/CHECK agreement.
      "server/modules/dropship/__tests__/integration/dropship-ebay-push-publication-reader.integration.test.ts",
      "server/modules/dropship/__tests__/integration/dropship-ebay-publication-account-identity.integration.test.ts",
      // Live listings stay orderable through queued/failed updates; demoted rows, below-cost pauses and account-check refusals recover.
      "server/modules/dropship/__tests__/integration/dropship-listing-live-status.integration.test.ts",
      "server/modules/dropship/__tests__/integration/dropship-cost-change-hold-restore.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/inventory-publication-global-control.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/inventory-publication-target-resume.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/inventory-publication-target-enable.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/inventory-stock-send.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/inventory-product-sync.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/transformation-execution-authority.integration.test.ts",
      "server/modules/inventory/__tests__/integration/build-order-transformation-authority.integration.test.ts",
      "server/modules/catalog/__tests__/integration/piece-variant-backfill.integration.test.ts",
      "server/modules/catalog/__tests__/integration/product-asset-order.integration.test.ts",
      "server/modules/catalog/__tests__/integration/product-asset-scope.integration.test.ts",
      "server/modules/catalog/__tests__/integration/shared-product-photos.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/inventory-channel-publication-status.integration.test.ts",
      "server/modules/shipping/__tests__/integration/carrier-tracking-recovery.integration.test.ts",
      "server/modules/channels/__tests__/integration/walmart-connection.integration.test.ts",
      "server/modules/catalog/__tests__/integration/product-102-cleanup.integration.test.ts",
      "server/modules/returns/__tests__/integration/customer-return-order-access.repository.test.ts",
      "server/modules/returns/__tests__/integration/customer-return-customer-auth.repository.test.ts",
      "server/modules/returns/__tests__/integration/customer-return-customer-ownership.repository.test.ts",
      "server/modules/returns/__tests__/integration/customer-return-authorization.repository.test.ts",
      "server/modules/returns/__tests__/integration/customer-return-local-inspection.reader.test.ts",
      "server/modules/returns/__tests__/integration/customer-return-intake.repository.test.ts",
      "server/modules/returns/__tests__/integration/customer-return-complex-flow.test.ts",
      "server/modules/returns/__tests__/integration/customer-return-labels.repository.test.ts",
      "server/modules/returns/__tests__/integration/return-policy-archive.repository.test.ts",
      "server/modules/returns/__tests__/integration/return-policy-shipping.repository.test.ts",
      "server/modules/returns/__tests__/integration/return-policy-shipping-migration.test.ts",
      "server/modules/orders/__tests__/integration/pick-correction.integration.test.ts",
      "server/modules/orders/__tests__/integration/confirmed-pick-inventory.integration.test.ts",
      "server/modules/oms/__tests__/integration/channel-receipt-immutable-replay.integration.test.ts",
      "server/modules/oms/__tests__/integration/oms-disposition-cutover-replay.integration.test.ts",
      "server/modules/marketplace-listings/__tests__/integration/pg-listing-publication.integration.test.ts",
      "server/modules/marketplace-listings/__tests__/integration/pg-listing-update.integration.test.ts",
      "server/modules/marketplace-listings/__tests__/integration/listing-replacement-recovery.integration.test.ts",
      "server/modules/marketplace-listings/__tests__/integration/channel-listing-catalog.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/walmart-publication-membership.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/verified-listing-stock.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/inventory-publication-scope.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/inventory-publication-initial-scope.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/channel-quantity-read-only.integration.test.ts",
      "server/modules/dropship/__tests__/integration/dropship-cost-schedule.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/inventory-publication-failure-cleanup.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/canonical-pick-case-break.integration.test.ts",
      "server/modules/oms/__tests__/integration/oms-line-authority-grant.integration.test.ts",
      "server/modules/orders/__tests__/integration/picking-assignment-release.integration.test.ts",
      "server/modules/orders/__tests__/integration/picking-progress-owner.integration.test.ts",
      "server/modules/orders/__tests__/integration/warehouse-operation-commands.integration.test.ts",
      "server/modules/inventory/__tests__/integration/manual-transfer-command.integration.test.ts",
      "server/modules/inventory/__tests__/integration/inline-replenishment.integration.test.ts",
      "server/modules/membership/__tests__/integration/member-directory.integration.test.ts",
      "server/modules/dropship/__tests__/integration/dropship-finance.integration.test.ts",
      "server/modules/order-edits/__tests__/integration/order-edit-warehouse.integration.test.ts",
      "server/modules/oms/__tests__/integration/order-edit-paid-projection.integration.test.ts",
      "server/modules/oms/__tests__/integration/wms-sync-existing-shipment-claim.integration.test.ts",
      "server/modules/catalog/__tests__/integration/catalog-variant-publication-photos.integration.test.ts",
      "server/modules/channels/__tests__/integration/ebay-listing-photos.integration.test.ts",
      "server/modules/channels/__tests__/integration/ebay-listing-sync-recovery.integration.test.ts",
      "server/modules/channels/__tests__/integration/ebay-automatic-sync-recovery.integration.test.ts",
      "server/modules/channels/__tests__/integration/ebay-listing-policy-source.integration.test.ts",
  "server/modules/channels/__tests__/integration/ebay-business-policies.integration.test.ts",
  "server/modules/channels/__tests__/integration/ebay-policy-publication.integration.test.ts",
  "server/modules/channels/__tests__/integration/ebay-policy-connection-metadata.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/ebay-automatic-publication-recovery.integration.test.ts",
      "server/modules/shipping/__tests__/integration/ordinary-split-parcels.integration.test.ts",
      "server/modules/dropship/__tests__/integration/dropship-listing-settings.integration.test.ts",
      "server/modules/dropship/__tests__/integration/dropship-catalog-retail-price.integration.test.ts",
      "server/modules/procurement/__tests__/integration/invoice-po-quantities.integration.test.ts",
      "server/modules/procurement/__tests__/integration/ap-financial-safeguards.integration.test.ts",
      "server/modules/dropship/__tests__/integration/dropship-listing-config-revision.integration.test.ts",
      "server/modules/channels/__tests__/integration/ebay-listing-mapping-repair.integration.test.ts",
      "server/modules/channels/__tests__/integration/ebay-publication-stock.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/ebay-publication-readiness.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/ebay-listing-preparation-scope.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/ebay-archived-group-admission.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/ebay-listing-preparation-scope-authority.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/ebay-publication-preflight.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/ebay-publication-rejection.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/ebay-outbox-preflight-recovery.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/quantity-publication-listing-scope.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/quantity-provider-request-evidence.integration.test.ts",
      "server/modules/dropship/__tests__/integration/dropship-product-category-listing-settings.integration.test.ts",
      "server/modules/dropship/__tests__/integration/dropship-ebay-category-rules.integration.test.ts",
      "server/modules/procurement/__tests__/integration/supplier-po-document.integration.test.ts",
      "server/modules/marketplace-listings/__tests__/integration/listing-lifecycle.integration.test.ts",
      "server/modules/marketplace-listings/__tests__/integration/listing-member-lifecycle.integration.test.ts",
      "server/modules/marketplace-listings/__tests__/integration/listing-presence.integration.test.ts",
      "server/modules/dropship/__tests__/integration/dropship-listing-setting-writes.integration.test.ts",
      // Dropship eBay stock link: mapping-preparation destinations by store platform, the link writer, and row isolation.
      "server/modules/inventory-planning/__tests__/integration/publication-mapping-preparation-dropship-target.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/dropship-ebay-stock-readiness.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/runtime-publication-row-isolation.integration.test.ts",
      // Dropship eBay push end to end with its automatic stock link (real admission, planner and reader; fake eBay HTTP).
      "server/modules/dropship/__tests__/integration/dropship-ebay-push-stock-link.integration.test.ts",
      // Publish runs (step 1 plan S2-5, PR A): the new runs suite, and the worker repository suite that ran nowhere (TESTS5).
      "server/modules/dropship/__tests__/integration/dropship-listing-push-runs.integration.test.ts",
      "server/modules/dropship/__tests__/integration/dropship-listing-push-worker.repository.integration.test.ts",
      // Catalog reads, release readiness and orders during re-sends (step 1 plan S2-5, PR A2; TESTS2, §4.9, §4.7).
      "server/modules/dropship/__tests__/integration/dropship-vendor-catalog-read.integration.test.ts",
      "server/modules/dropship/__tests__/integration/dropship-release-readiness.integration.test.ts",
      "server/modules/dropship/__tests__/integration/dropship-order-listing-acceptability.integration.test.ts",
      // Channels PR1: a refused Shopify stock update dead-letters at once and shows on Ops Health (real outbox; fake Shopify HTTP).
      "server/modules/inventory-planning/__tests__/integration/channel-stock-update-dead-letter.integration.test.ts",
      // eBay sync-back (plan v4 §11 PG): the migration through the release executor, and its repositories.
      "server/modules/dropship/__tests__/integration/dropship-ebay-sync-back-migration.integration.test.ts",
      "server/modules/dropship/__tests__/integration/dropship-ebay-sync-back-repositories.integration.test.ts",
      // eBay sync-back's sweep (plan v4 §6): the adoption transaction, the quantity decision, selection, dead letters, ops-health SQL.
      "server/modules/dropship/__tests__/integration/dropship-ebay-sync-back-sweep.integration.test.ts",
      // eBay sync-back's order fixes (plan v4 §7): stuck orders, eBay cancels with OMS's stop and the refund, parked lines; OMS's stop.
      "server/modules/dropship/__tests__/integration/dropship-ebay-sync-back-orders.integration.test.ts",
      "server/modules/oms/__tests__/integration/dropship-marketplace-cancel.integration.test.ts",
      // One-time picks (step 1 plan S2-5, PR B, B1): the picks migration suite, its oracle and golden recorded at main first.
      "server/modules/dropship/__tests__/integration/dropship-selection-picks-migration.integration.test.ts",
      // One-time picks (PR B, B1): the picks save's transaction, gates, retries and 10,000-pick scale case.
      "server/modules/dropship/__tests__/integration/dropship-selection-change.integration.test.ts",
      // The new-items notice (PR B, B3): the arrivals ledger, marks, daily email and step 1 reads, and the conversion follow-up.
      "server/modules/dropship/__tests__/integration/dropship-catalog-arrivals.integration.test.ts",
      // Listing ends (PR C, C1): the end requests migration through the release executor, its CHECKs and triggers.
      "server/modules/dropship/__tests__/integration/dropship-listing-end.integration.test.ts",
      // Listing ends (PR C, C2): the push fence, the four writers that keep ended, stock, sync-back and catch-up interplay.
      "server/modules/dropship/__tests__/integration/dropship-listing-end-interplay.integration.test.ts",
      // Channels PR2 (P0): the Dropship eBay stock link's command lock and receipts, pinned on main before its wrapper conversion.
      "server/modules/inventory-planning/__tests__/integration/dropship-ebay-stock-command-lock.integration.test.ts",
      // Channels PR2 (P1+): the shared stock-link engine over real PostgreSQL, starting with migration M1 through the release executor.
      "server/modules/inventory-planning/__tests__/integration/stock-link.integration.test.ts",
      // Channels PR2 (P6): Channels' read-only SQL for the stock-link engine's Shopify destinations.
      "server/modules/channels/__tests__/integration/shopify-stock-link-source.integration.test.ts",
      // Channels PR3: Dropship eBay listing enrollment (the Dropship source SQL, the tick and the Dropship writer).
      "server/modules/dropship/__tests__/integration/dropship-ebay-stock-enrollment.integration.test.ts",
      // Channels PR5: catch-up parking (park, the sealer's wake, identity_retired settlement, retry classes, Ops Health SQL).
      "server/modules/inventory-planning/__tests__/integration/quantity-publication-catchup-parking.integration.test.ts",
    ];
    addedSuites.push(
      "server/modules/inventory/__tests__/integration/quantity-ledger-supplier-return.integration.test.ts",
      "server/modules/procurement/__tests__/integration/po-financial-evidence.integration.test.ts",
      "server/modules/procurement/__tests__/integration/po-financial-followup.integration.test.ts",
      "server/modules/procurement/__tests__/integration/po-financial-exceptions.integration.test.ts",
      "server/modules/procurement/__tests__/integration/po-exception-lifecycle.integration.test.ts",
      "server/modules/procurement/__tests__/integration/purchase-order-entry-recovery.integration.test.ts",
      "server/modules/procurement/__tests__/integration/po-financial-refresh.integration.test.ts",
      "server/modules/procurement/__tests__/integration/invoice-replacement.integration.test.ts",
      "server/modules/procurement/__tests__/integration/shipment-invoice-ownership-guard.integration.test.ts",
      "server/modules/procurement/__tests__/integration/shipment-billing-ownership.integration.test.ts",
      "server/modules/procurement/__tests__/integration/shipment-value-allocation.integration.test.ts",
      "server/modules/procurement/__tests__/integration/receiving-quarantine.integration.test.ts",
      "server/modules/procurement/__tests__/integration/procurement-lifecycle-quarantine.integration.test.ts",
      "server/modules/inventory/__tests__/integration/receiving-custody-count-guard.integration.test.ts",
      "server/modules/marketplace-listings/__tests__/integration/channel-package-propagation.integration.test.ts",
      "server/modules/marketplace-listings/__tests__/integration/channel-publication-weight.integration.test.ts",
      "server/modules/marketplace-listings/__tests__/integration/channel-identifiers-propagation.integration.test.ts",
      "server/modules/oms/__tests__/integration/channel-merchandise-quantity.integration.test.ts",
      "server/modules/oms/__tests__/integration/shopify-merchandise-refund.integration.test.ts",
    );
    const retiredInvoiceSuite = "server/modules/inventory/__tests__/integration/invoice-variance-cogs.integration.test.ts";
    expect(POSTGRES_TEST_FILES).not.toContain(retiredInvoiceSuite);
    // Listing settings PR 12 deleted the per-size eBay policy writer (its routes, service and
    // repository) this suite ran; the guarantees that hold for the surviving writers of those
    // rows are in dropship-listing-setting-writes.integration.test.ts.
    const retiredPolicyBulkSuite = "server/modules/dropship/__tests__/integration/dropship-ebay-listing-policy-bulk.integration.test.ts";
    expect(POSTGRES_TEST_FILES).not.toContain(retiredPolicyBulkSuite);
    const priorSuiteCount = 68;
    // Derive the total from the protected baseline and this independent review list,
    // so concurrent reviewed additions cannot leave a stale hardcoded total.
    const expectedSuiteCount = priorSuiteCount + addedSuites.length;
    expect(new Set(addedSuites).size).toBe(addedSuites.length);
    expect(POSTGRES_TEST_FILES).toHaveLength(expectedSuiteCount);
    expect(new Set(POSTGRES_TEST_FILES).size).toBe(expectedSuiteCount);
    expect(POSTGRES_TEST_FILES).toEqual(expect.arrayContaining(addedSuites));
    // Preserve the original inventory digest as well as the explicit additions;
    // adding hardening coverage must not silently remove an older suite.
    const priorFiles = POSTGRES_TEST_FILES.filter((file) => !addedSuites.includes(file));
    expect(priorFiles).toHaveLength(priorSuiteCount);
    // Include the two reviewed retirements when checking the original digest.
    // The live source-application suites replace that unused duplicate algorithm;
    // the bulk policy suite's writer no longer exists.
    const digest = createHash("sha256").update([...priorFiles, retiredInvoiceSuite, retiredPolicyBulkSuite].sort().join("\n")).digest("hex");
    expect(digest).toBe("8d6c96c5651ea0352e914985eb98ce15267503b535b50d63dec5a0780a80868a");
    expect(() => validatePostgresManifest(POSTGRES_REPOSITORY_ROOT, POSTGRES_TEST_FILES)).not.toThrow();
  });

  it("assigns every manifest file exactly once across 8 deterministic nonempty shards", () => {
    const shards = Array.from({ length: POSTGRES_SHARD_COUNT }, (_, index) => selectPostgresShardFiles({ index: index + 1, count: 8 }));
    expect(shards.every((files) => files.length > 0)).toBe(true);
    expect(shards.flat().sort()).toEqual([...POSTGRES_TEST_FILES].sort());
    expect(new Set(shards.flat()).size).toBe(POSTGRES_TEST_FILES.length);
    expect(selectPostgresShardFiles({ index: 1, count: 8 })).toEqual(shards[0]);
    expect(() => selectPostgresShardFiles({ index: 0, count: 8 })).toThrow();
  });

  it("reduces the measured longest shard without changing the measured work or coverage", () => {
    // Compare the two assignments using the same recorded successful run. This
    // is a planning regression, not a promise about GitHub queue/runtime speed.
    const measuredFiles = POSTGRES_TEST_FILES.filter((file) => Object.hasOwn(POSTGRES_TEST_DURATION_MS, file));
    const plan = planPostgresShards(measuredFiles, POSTGRES_TEST_DURATION_MS, 8);
    // Reconstruct the former modulo planner, rather than assuming later timing
    // refreshes were collected before duration balancing was introduced.
    const oldLoads = Array.from({ length: 8 }, (_, shard) => measuredFiles
      .filter((_, index) => index % 8 === shard).reduce((sum, file) => sum + POSTGRES_TEST_DURATION_MS[file], 0));
    const newLoads = plan.shards.map((shard) => shard.estimatedDurationMs);
    const totalMs = newLoads.reduce((sum, value) => sum + value, 0);
    expect(totalMs).toBe(oldLoads.reduce((sum, value) => sum + value, 0));
    // The modulo baseline depends on manifest order. Retiring a suite from the middle of the
    // manifest (Listing settings PR 12, the bulk policy suite) moves every later file to another
    // modulo shard, and today's order happens to balance modulo better (longest 190,050 ms, was
    // 233,562 ms), so a fixed 25% margin over it measured the order, not the planner. The margin is
    // gone (PR 12 review CT2): the planner must still beat modulo, and its shards must stay within
    // 1 s of each other, which also keeps the longest within 1 s of the mean load.
    expect(Math.max(...newLoads)).toBeLessThan(Math.max(...oldLoads));
    expect(Math.max(...newLoads) - Math.min(...newLoads)).toBeLessThan(1000);
    expect(plan.shards.flatMap((shard) => shard.files).sort()).toEqual([...measuredFiles].sort());
    expect(plan.unmeasuredFiles).toEqual([]);
  });

  it("keeps placement and tie breaks deterministic without mutating manifest or timing inputs", () => {
    const files = Object.freeze([...POSTGRES_TEST_FILES]);
    const weights = Object.freeze({ ...POSTGRES_TEST_DURATION_MS });
    const originalFiles = [...files];
    const originalWeights = { ...weights };
    const plan = planPostgresShards(files, weights, 8);
    expect(planPostgresShards([...files].reverse(), Object.fromEntries(Object.entries(weights).reverse()), 8)).toEqual(plan);
    expect(files).toEqual(originalFiles);
    expect(weights).toEqual(originalWeights);

    const tied = ["a", "b", "c", "d"].map((name) => `server/modules/example/__tests__/integration/${name}.test.ts`);
    expect(planPostgresShards([...tied].reverse(), Object.fromEntries(tied.map((file) => [file, 100])), 2).shards
      .map((shard) => shard.files)).toEqual([[tied[0], tied[2]], [tied[1], tied[3]]]);
  });

  it("includes new or renamed suites with the slowest observed fallback and never restores retired coverage", () => {
    const known = POSTGRES_TEST_FILES.slice(0, 8);
    const newFile = "server/modules/example/__tests__/integration/new-coverage.test.ts";
    const retiredFile = "server/modules/example/__tests__/integration/retired-coverage.test.ts";
    const weights = { ...Object.fromEntries(known.map((file, index) => [file, (index + 1) * 100])), [retiredFile]: 900 };
    const plan = planPostgresShards([...known, newFile], weights, 8);
    expect(plan.fallbackDurationMs).toBe(900);
    expect(plan.unmeasuredFiles).toEqual([newFile]);
    expect(plan.unusedTimingFiles).toEqual([retiredFile]);
    expect(plan.shards.flatMap((shard) => shard.files).sort()).toEqual([...known, newFile].sort());
    expect(plan.shards.some((shard) => shard.files.includes(retiredFile))).toBe(false);
    expect(plan.shards.find((shard) => shard.files.includes(newFile))?.estimatedDurationMs).toBeGreaterThanOrEqual(900);
    expect(plan.shards.every((shard) => shard.files.length > 0)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_POSTGRES_FILE_DURATION_MS + 1])(
    "rejects invalid timing weight %s before any shard runs", (duration) => {
      expect(() => planPostgresShards(POSTGRES_TEST_FILES, { [POSTGRES_TEST_FILES[0]]: duration }, 8)).toThrow(/timing weights/);
    },
  );

  it("rejects empty weights, malformed paths, duplicate coverage, and impossible shard counts", () => {
    expect(() => planPostgresShards(POSTGRES_TEST_FILES, {}, 8)).toThrow(/timing weights/);
    expect(() => planPostgresShards(POSTGRES_TEST_FILES, { "../outside.test.ts": 100 }, 8)).toThrow(/timing weights/);
    for (const count of [0, -1, 1.5, Number.NaN, POSTGRES_TEST_FILES.length + 1]) {
      expect(() => planPostgresShards(POSTGRES_TEST_FILES, POSTGRES_TEST_DURATION_MS, count)).toThrow();
    }
    expect(() => planPostgresShards([...POSTGRES_TEST_FILES, POSTGRES_TEST_FILES[0]], POSTGRES_TEST_DURATION_MS, 8)).toThrow();
    expect(() => planPostgresShards(["../outside.test.ts"], POSTGRES_TEST_DURATION_MS, 1)).toThrow();
  });

  it("rejects malformed, duplicated, or untraceable checked-in timing evidence", () => {
    const valid = POSTGRES_TIMING_SNAPSHOT;
    expect(() => parsePostgresTimingSnapshot({ ...valid, version: 0 })).toThrow();
    expect(() => parsePostgresTimingSnapshot({ ...valid, measurements: [] })).toThrow();
    expect(() => parsePostgresTimingSnapshot({ ...valid, source: { ...valid.source, headSha: "unverified" } })).toThrow();
    expect(() => parsePostgresTimingSnapshot({ ...valid, source: { ...valid.source, conclusion: "failure" } })).toThrow();
    expect(() => parsePostgresTimingSnapshot({ ...valid, source: { ...valid.source, jobIds: [...valid.source.jobIds, valid.source.jobIds[0]] } })).toThrow(/duplicate job/);
    expect(() => parsePostgresTimingSnapshot({ ...valid, measurements: [...valid.measurements, valid.measurements[0]] })).toThrow(/duplicate suite/);
    expect(() => parsePostgresTimingSnapshot({ ...valid, measurements: [{ ...valid.measurements[0], jobId: 1 }] })).toThrow(/unrecorded source job/);
    expect(() => parsePostgresTimingSnapshot({ ...valid, source: { ...valid.source, jobIds: [...valid.source.jobIds, 1] } })).toThrow(/no measurements/);
    expect(() => parsePostgresTimingSnapshot({ ...valid, measurements: [{ ...valid.measurements[0], durationMs: 0 }] })).toThrow();
  });

  it.each([[], ["0/8"], ["9/8"], ["1/0"], ["1/4"], ["01/8"], ["1/08"], ["1.5/8"], ["NaN/8"], ["1/8", "--passWithNoTests"], ["1/8; echo unsafe"], ["9007199254740992/8"]])("rejects invalid shard input %j", (...args: string[]) => {
    expect(() => parsePostgresShard(args)).toThrow();
  });

  it("runs one explicit file per isolated serial process with a unique JUnit output", () => {
    const reports: string[] = [];
    for (let index = 1; index <= POSTGRES_SHARD_COUNT; index += 1) {
      const shard = parsePostgresShard([index + "/8"]);
      const files = selectPostgresShardFiles(shard);
      for (const [fileIndex, file] of files.entries()) {
        const args = buildPostgresVitestArgs(shard, file);
        expect(args).toEqual([
          resolve(POSTGRES_REPOSITORY_ROOT, "node_modules/vitest/vitest.mjs"), "run", file,
          "--no-file-parallelism", "--maxWorkers=1", "--isolate",
          "--allowOnly=false", "--passWithNoTests=false", "--reporter=default", "--reporter=junit",
          "--outputFile.junit=test-results/postgres-hardening-" + index + "/" + (fileIndex + 1) + ".xml",
        ]);
        reports.push(args.at(-1)!);
      }
    }
    expect(new Set(reports).size).toBe(POSTGRES_TEST_FILES.length);
    const anotherShardFile = selectPostgresShardFiles({ index: 2, count: 8 })[0];
    expect(() => buildPostgresVitestArgs({ index: 1, count: 8 }, anotherShardFile)).toThrow();
    const source = readFileSync(resolve(POSTGRES_REPOSITORY_ROOT, "scripts/ci/postgres-tests.ts"), "utf8");
    expect(source).toContain("spawnSync(process.execPath, [...args]");
    expect(source).toContain("shell: false");
  });

  it.each([
    {},
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_DISPOSABLE: "false" },
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_DISPOSABLE: "TRUE" },
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_URL: "not-a-url-secret" },
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_URL: "postgres://user:secret@production.example/test" },
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_URL: "postgres://user:secret@localhost.example/test" },
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_URL: "postgres://localhost/test?host=production.example" },
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_URL: "postgres://localhost/test#fragment" },
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_URL: "https://localhost/test" },
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_URL: "postgres://localhost/" },
    { ...disposableEnvironment, DATABASE_URL: "postgresql://different:secret@localhost/echelon_test" },
    { ...disposableEnvironment, EXTERNAL_DATABASE_URL: "postgres://127.0.0.1:5432/echelon_test" },
  ])("rejects unsafe or absent DB configuration without exposing secrets", (env) => {
    let message = "";
    try { validatePostgresTestEnvironment(env); } catch (error) { message = (error as Error).message; }
    expect(message).not.toBe("");
    expect(message).not.toContain("secret");
  });

  it.each(["localhost", "127.0.0.1"])("allows an explicitly disposable database on %s", (host) => {
    expect(() => validatePostgresTestEnvironment({ ...disposableEnvironment, ECHELON_TEST_DATABASE_URL: "postgresql://postgres@" + host + ":55459/ci_shard_1" })).not.toThrow();
  });

  it("rejects missing, duplicate, wildcard and escaping manifest paths", () => {
    const invalidPaths = ["../other.test.ts", "server/**/integration/*.test.ts", "--exclude=anything", "server/modules/missing/__tests__/integration/missing.test.ts"];
    for (const invalid of invalidPaths) {
      expect(() => validatePostgresManifest(POSTGRES_REPOSITORY_ROOT, [...POSTGRES_TEST_FILES.slice(0, 8), invalid])).toThrow();
    }
    expect(() => validatePostgresManifest(POSTGRES_REPOSITORY_ROOT, [...POSTGRES_TEST_FILES, POSTGRES_TEST_FILES[0]])).toThrow();
    expect(() => validatePostgresManifest(POSTGRES_REPOSITORY_ROOT, [])).toThrow();
  });

  it("restricts owned names to a generated, bounded prefix; rejects identifier injection", () => {
    const name = createOwnedDatabaseName({ index: 8, count: 8 }, "00000000-0000-4000-8000-000000000001");
    expect(name).toBe("echelon_ci_s8_00000000000040008000000000000001");
    expect(name.length).toBeLessThan(63);
    expect(() => createOwnedDatabaseName({ index: 1, count: 8 }, 'postgres"; DROP DATABASE other;--')).toThrow();
    expect(() => createOwnedDatabaseName({ index: 1, count: 8 }, "postgres")).toThrow();
  });

  it("creates/runs/drops each file database serially, overrides only the child URL and leaves caller env unchanged", async () => {
    const fixture = runnerFixture();
    const environment: NodeJS.ProcessEnv = {
      ...disposableEnvironment,
      DATABASE_URL: "postgres://app:secret@application.example/production",
      EXTERNAL_DATABASE_URL: "postgres://app:secret@external.example/production",
      CI: "true",
    };
    const originalEnv = { ...environment };
    expect(await runPostgresShard(["1/8"], environment, fixture.dependencies)).toBe(0);
    expect(fixture.connections).toHaveLength(firstShardFileCount);
    expect(fixture.dependencies.runTest).toHaveBeenCalledTimes(firstShardFileCount);
    expect(fixture.dependencies.error).not.toHaveBeenCalled();
    expect(environment).toEqual(originalEnv);
    const databaseNames: string[] = [];
    for (const [index, connection] of fixture.connections.entries()) {
      const calls = connection.query.mock.calls.map(([statement]) => statement);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatch(/^CREATE DATABASE "echelon_ci_s1_[0-9a-f]{32}"$/);
      const identifier = calls[0].slice("CREATE DATABASE ".length);
      expect(calls[1]).toBe("DROP DATABASE " + identifier + " WITH (FORCE)");
      expect(connection.end).toHaveBeenCalledOnce();
      const [args, childEnv] = vi.mocked(fixture.dependencies.runTest).mock.calls[index];
      expect(args[2]).toBe(selectPostgresShardFiles({ index: 1, count: 8 })[index]);
      const childUrl = new URL(childEnv.ECHELON_TEST_DATABASE_URL!);
      expect(childUrl.pathname).toBe("/" + identifier.replaceAll('"', ""));
      expect(childUrl.hostname).toBe("127.0.0.1");
      expect(childUrl.port).toBe("5432");
      expect(childEnv.ECHELON_TEST_DATABASE_DISPOSABLE).toBe("true");
      expect(childEnv).not.toHaveProperty("DATABASE_URL");
      expect(childEnv).not.toHaveProperty("EXTERNAL_DATABASE_URL");
      expect(childEnv.CI).toBe("true");
      databaseNames.push(childUrl.pathname);
      expect(fixture.events.slice(index * 5, index * 5 + 5)).toEqual(["connect", calls[0], "run", calls[1], "end"]);
    }
    expect(new Set(databaseNames).size).toBe(firstShardFileCount);
  });

  it("executes a selected one-file plan in its own database and rejects mismatched or empty plans before connecting", async () => {
    const fixture = runnerFixture();
    const selected = POSTGRES_TEST_FILES[0];
    const environment = { ...disposableEnvironment, POSTGRES_SELECTED_TEST_FILES: JSON.stringify([selected]) };
    expect(await runPostgresShard(["1/1"], environment, fixture.dependencies)).toBe(0);
    expect(fixture.dependencies.runTest).toHaveBeenCalledOnce();
    expect(vi.mocked(fixture.dependencies.runTest).mock.calls[0][0]).toContain(selected);
    expect(fixture.connections).toHaveLength(1);
    expect(fixture.connections[0].query.mock.calls.map(call => call[0])).toEqual([
      'CREATE DATABASE "echelon_ci_s1_00000000000040008000000000000001"',
      'DROP DATABASE "echelon_ci_s1_00000000000040008000000000000001" WITH (FORCE)',
    ]);
    const invalid = runnerFixture();
    for (const args of [["1/8"], ["2/1"]])
      await expect(runPostgresShard(args, environment, invalid.dependencies)).rejects.toThrow("Shard index");
    await expect(runPostgresShard(["1/1"], { ...environment, POSTGRES_SELECTED_TEST_FILES: "[]" }, invalid.dependencies)).rejects.toThrow();
    expect(invalid.createAdminConnection).not.toHaveBeenCalled();
  });

  it("never drops a database when CREATE fails or collides, and continues the remaining files", async () => {
    const fixture = runnerFixture();
    const ordinaryCreate = fixture.createAdminConnection.getMockImplementation()!;
    fixture.createAdminConnection.mockImplementationOnce((url) => {
      const connection = ordinaryCreate(url);
      connection.query.mockRejectedValueOnce(Object.assign(new Error("contains secret"), { code: "42P04" }));
      return connection;
    });
    expect(await runPostgresShard(["1/8"], disposableEnvironment, fixture.dependencies)).toBe(1);
    expect(fixture.connections[0].query.mock.calls).toHaveLength(1);
    expect(fixture.connections[0].query.mock.calls[0][0]).toMatch(/^CREATE DATABASE /);
    expect(fixture.connections[0].end).toHaveBeenCalledOnce();
    expect(fixture.dependencies.runTest).toHaveBeenCalledTimes(firstShardFileCount - 1);
    expect(fixture.connections).toHaveLength(firstShardFileCount);
    const failure = JSON.parse(vi.mocked(fixture.dependencies.error).mock.calls[0][0]);
    expect(failure).toMatchObject({ phase: "database create", detail: "42P04" });
    expect(failure.database).toMatch(/^echelon_ci_s1_/);
    expect(vi.mocked(fixture.dependencies.error).mock.calls.flat().join(" ")).not.toContain("contains secret");
  });

  it.each([
    { status: 1, signal: null },
    { status: null, signal: "SIGTERM" },
    { status: null, signal: null, error: Object.assign(new Error("secret"), { code: "ENOENT" }) },
    { status: null, signal: null },
  ] as const)("cleans owned DB after failed child execution and continues all files: %j", async (result) => {
    const fixture = runnerFixture();
    vi.mocked(fixture.dependencies.runTest).mockReturnValueOnce({ pid: 0, output: [], stdout: null, stderr: null, ...result });
    expect(await runPostgresShard(["1/8"], disposableEnvironment, fixture.dependencies)).toBe(1);
    expect(fixture.connections[0].query.mock.calls[1][0]).toMatch(/^DROP DATABASE "echelon_ci_s1_/);
    expect(fixture.connections[0].end).toHaveBeenCalledOnce();
    expect(fixture.dependencies.runTest).toHaveBeenCalledTimes(firstShardFileCount);
    expect(vi.mocked(fixture.dependencies.error).mock.calls.flat().join(" ")).not.toContain("secret");
  });

  it("cleans owned DB after a thrown child startup error", async () => {
    const fixture = runnerFixture();
    vi.mocked(fixture.dependencies.runTest).mockImplementationOnce(() => { throw new Error("secret"); });
    expect(await runPostgresShard(["1/8"], disposableEnvironment, fixture.dependencies)).toBe(1);
    expect(fixture.connections[0].query.mock.calls[1][0]).toMatch(/^DROP DATABASE /);
    expect(fixture.dependencies.runTest).toHaveBeenCalledTimes(firstShardFileCount);
  });

  it("reports cleanup and connection-close failures without hiding passing child status", async () => {
    const fixture = runnerFixture();
    const ordinaryCreate = fixture.createAdminConnection.getMockImplementation()!;
    fixture.createAdminConnection.mockImplementationOnce((url) => {
      const connection = ordinaryCreate(url);
      connection.query.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error("secret"), { code: "55006" }));
      connection.end.mockRejectedValueOnce(Object.assign(new Error("secret"), { code: "ECONNRESET" }));
      return connection;
    });
    expect(await runPostgresShard(["1/8"], disposableEnvironment, fixture.dependencies)).toBe(1);
    expect(fixture.dependencies.runTest).toHaveBeenCalledTimes(firstShardFileCount);
    const failures = vi.mocked(fixture.dependencies.error).mock.calls.map(([event]) => JSON.parse(event));
    expect(failures.map((event) => event.phase)).toEqual(["database cleanup", "admin connection close"]);
    expect(failures[0].database).toMatch(/^echelon_ci_s1_/);
  });

  it("does not issue CREATE, DROP or a test after connection failure", async () => {
    const fixture = runnerFixture();
    const ordinaryCreate = fixture.createAdminConnection.getMockImplementation()!;
    fixture.createAdminConnection.mockImplementationOnce((url) => {
      const connection = ordinaryCreate(url);
      connection.connect.mockRejectedValueOnce(Object.assign(new Error("secret"), { code: "ECONNREFUSED" }));
      return connection;
    });
    expect(await runPostgresShard(["1/8"], disposableEnvironment, fixture.dependencies)).toBe(1);
    expect(fixture.connections[0].query).not.toHaveBeenCalled();
    expect(fixture.connections[0].end).toHaveBeenCalledOnce();
    expect(fixture.dependencies.runTest).toHaveBeenCalledTimes(firstShardFileCount - 1);
  });

  it("does not connect without safe configuration or a valid generated DB name", async () => {
    const fixture = runnerFixture();
    await expect(runPostgresShard(["1/8"], {}, fixture.dependencies)).rejects.toThrow();
    expect(fixture.createAdminConnection).not.toHaveBeenCalled();
    vi.mocked(fixture.dependencies.randomId).mockReturnValue("postgres");
    expect(await runPostgresShard(["1/8"], disposableEnvironment, fixture.dependencies)).toBe(1);
    expect(fixture.createAdminConnection).not.toHaveBeenCalled();
    expect(fixture.dependencies.runTest).not.toHaveBeenCalled();
  });

  it("uses an explicit selected plan and retains both stable check identities", () => {
    const workflow = readFileSync(resolve(POSTGRES_REPOSITORY_ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toMatch(/on:\s*pull_request:\s*push:\s*branches: \[main\]/);
    expect(workflow).not.toMatch(/paths(?:-ignore)?:|continue-on-error:/);
    expect(workflow).toContain("name: Typecheck + unit tests");
    expect(workflow).toContain("run: npm run check");
    expect(workflow).toContain("run: node scripts/ci/run-test-lane.mjs unit");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("timeout-minutes: 20");
    expect(workflow).toContain("matrix: ${{ fromJSON(needs.preflight.outputs.matrix) }}");
    expect(workflow).toContain("POSTGRES_SELECTED_TEST_FILES: ${{ needs.preflight.outputs.files }}");
    expect(workflow).toContain("POSTGRES_SHARD: ${{ matrix.shard }}/${{ matrix.count }}");
    expect(workflow).toContain('node --import tsx scripts/ci/postgres-tests.ts "$POSTGRES_SHARD"');
    expect(workflow).toContain("image: postgres:16");
    expect(workflow).toContain('ECHELON_TEST_DATABASE_DISPOSABLE: "true"');
    expect(workflow).toContain("path: test-results/postgres-hardening-" + "$" + "{{ matrix.shard }}/");
    expect(workflow).toContain("name: PostgreSQL hardening tests");
    expect(workflow).toContain("needs: [preflight, postgres-hardening-shard]");
    expect(workflow).toContain("if: " + "$" + "{{ always() }}");
    expect(workflow).toContain("node scripts/ci/require-selected-success.mjs postgres-hardening-shard");
  });
});
