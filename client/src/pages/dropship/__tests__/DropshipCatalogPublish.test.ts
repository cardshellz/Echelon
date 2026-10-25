import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyListingPushRunCounts, type ListingPushRunDetail, type ListingPushRunView } from "@shared/dropship/listing-push-runs";
import type { DropshipCatalogSelectionSummary } from "@shared/dropship/vendor-catalog-reads";
import { checkContextKey, checkResult, describePublishChoices, toCheckRow } from "@/lib/dropship-catalog-publish";
import { PUBLISH_WORDS } from "@/lib/dropship-catalog-publish-words";
import { dropshipStockLinkServerMessage, type DropshipStockLinkRefusalCode } from "@shared/dropship/stock-link-refusals";
import { describeListingAccess } from "@/lib/dropship-listing-access";
import { PublishPanel, type PublishPanelProps } from "../catalog/PublishStep";
import { PublishRunCard, type PublishRunCardProps } from "../catalog/PublishRunCard";

/**
 * Catalog step 3 on publish runs (step 1 plan S2-5, PR A, §4.10): the static
 * markup of the step's card and the run card, and the source pins that moved
 * from DropshipPortalCatalog.test.ts with the step body.
 */

afterEach(() => { vi.unstubAllGlobals(); });

const STAMP = "2026-10-20T12:00:00.000Z";

function render(node: React.ReactElement): string {
  vi.stubGlobal("React", React);
  const client = new QueryClient();
  return renderToStaticMarkup(React.createElement(Router, { ssrPath: "/dropship-portal/catalog/publish",
    children: React.createElement(QueryClientProvider, { client }, node) }));
}

/** "Card Shellz's" in static markup. */
function html(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function summary(overrides: Partial<DropshipCatalogSelectionSummary> = {}): DropshipCatalogSelectionSummary {
  return { selectionRevisionId: 3, selectedTotal: 1_234, cap: 10_000, overCap: false,
    store: { storeConnectionId: 5, live: 234, notLive: 1_000 }, ...overrides };
}

function panel(overrides: Partial<PublishPanelProps> = {}): string {
  const shown = overrides.summary === undefined ? summary() : overrides.summary;
  return render(React.createElement(PublishPanel, {
    storeReady: true, storeName: "marz_cards", storeOwnName: "marz_cards", accessNotice: null, checkBlocked: false, publishBlocked: false, priceSavePending: false,
    summary: shown, summaryFailed: false, onRetrySummary: () => undefined, siteUpdating: false,
    choices: describePublishChoices(shown, 5), error: null, info: null, pending: null, runGoing: false,
    emailCodeSent: false, verificationCode: "", onVerificationCodeChange: () => undefined, onPublish: () => undefined,
    checking: null, checkFailed: null, check: null, onCheck: () => undefined, onStopCheck: () => undefined, run: null,
    selected: { rows: [{ productVariantId: 101, productName: "Envelope Single Pocket", variantName: "Pack of 50", variantSku: "ENV-SGL-P50",
      selectionDecision: { marketplaceQuantity: 25 } }], total: 1_234 },
    selectedFailed: false, selectedHasMore: true, selectedLoadingMore: false, onLoadMoreSelected: () => undefined, onRetrySelected: () => undefined,
    portalHref: (path: string) => `/dropship-portal${path}`,
    ...overrides,
  }));
}

function run(overrides: Partial<ListingPushRunView> = {}): ListingPushRunView {
  return { runId: 7, storeConnectionId: 5, scope: "not_live", status: "processing", stopReason: null, selectionRevisionId: 3, targetCount: 1_234,
    chunkSize: 500, chunkCount: 3, nextChunkIndex: 1, cancelRequestedAt: null, createdAt: STAMP, updatedAt: STAMP, completedAt: null, ...overrides };
}

function card(detail: ListingPushRunDetail | null, overrides: Partial<PublishRunCardProps> = {}): string {
  return render(React.createElement(PublishRunCard, {
    detail, unread: false, storeName: "marz_cards", storeOwnName: "marz_cards", expectedCount: null, moreProblems: [], nextProblemsCursor: null,
    loadingMoreProblems: false, onLoadMoreProblems: () => undefined, stopping: false, stopFailed: false, onStop: () => undefined, ...overrides,
  }));
}

describe("PublishPanel", () => {
  it("offers Publish {n} new, Publish all {n} and Check, with the counts and the hint, and every button 44 px high (P7)", () => {
    const markup = panel();
    expect(markup).toContain(PUBLISH_WORDS.heading);
    expect(markup).toContain(html(PUBLISH_WORDS.publishLine));
    expect(markup).toContain("Publish 1,000 new");
    expect(markup).toContain("Publish all 1,234");
    expect(markup).toContain(PUBLISH_WORDS.checkButton);
    expect(markup).toContain(html(PUBLISH_WORDS.publishAllHint(234)));
    expect(markup).toContain(html(PUBLISH_WORDS.checkHint));
    for (const testId of ["publish-new", "publish-all", "publish-check"]) {
      const button = markup.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
      expect(button, testId).toContain("h-11");
      expect(button, testId).not.toContain('disabled=""');
    }
    // The server-paged list, with Load more.
    expect(markup).toContain(PUBLISH_WORDS.selectedHeading);
    expect(markup).toContain("Showing 1 of 1,234");
    expect(markup).toContain(PUBLISH_WORDS.loadMore);
  });

  it("P11 hides Publish new when everything selected is live, and has no hint when nothing is", () => {
    const allLive = panel({ summary: summary({ store: { storeConnectionId: 5, live: 1_234, notLive: 0 } }) });
    expect(allLive).not.toContain('data-testid="publish-new"');
    expect(allLive).toContain("Publish all 1,234");
    const noneLive = panel({ summary: summary({ store: { storeConnectionId: 5, live: 0, notLive: 1_234 } }) });
    expect(noneLive).not.toContain('data-testid="publish-all-hint"');
  });

  it("P8 over the cap: both buttons off and the plan's words; nothing selected: step 1's words, no list", () => {
    const over = panel({ summary: summary({ selectedTotal: 10_001, overCap: true, store: { storeConnectionId: 5, live: 1, notLive: 10_000 } }) });
    expect(over).toContain(html(PUBLISH_WORDS.runTooLarge));
    for (const testId of ["publish-new", "publish-all", "publish-check"]) {
      expect(over.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0], testId).toContain('disabled=""');
    }
    const none = panel({ summary: summary({ selectedTotal: 0, store: { storeConnectionId: 5, live: 0, notLive: 0 } }) });
    expect(none).toContain(PUBLISH_WORDS.runEmpty);
    expect(none).not.toContain(PUBLISH_WORDS.selectedHeading);
  });

  it("waits for this store's count, a run going on, a code to be typed and a settings save", () => {
    const loading = panel({ choices: null });
    expect(loading.match(/<button[^>]*data-testid="publish-all"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(panel({ runGoing: true }).match(/<button[^>]*data-testid="publish-new"[^>]*>/)?.[0]).toContain('disabled=""');
    const code = panel({ emailCodeSent: true, verificationCode: "123" });
    expect(code).toContain(PUBLISH_WORDS.codeLabel);
    expect(code.match(/<button[^>]*data-testid="publish-new"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(panel({ priceSavePending: true }).match(/<button[^>]*data-testid="publish-check"[^>]*>/)?.[0]).toContain('disabled=""');
  });

  it("explains a blocked account, a store not ready, a refusal and site updating in its own card", () => {
    const notice = describeListingAccess({ status: "paused", entitlementStatus: "active" }, "push");
    const blocked = panel({ accessNotice: notice, publishBlocked: true, checkBlocked: true });
    expect(blocked).toContain('data-testid="listing-access-notice"');
    expect(blocked.match(/<button[^>]*data-testid="publish-check"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(panel({ storeReady: false })).toContain(html(PUBLISH_WORDS.storeNotReady));
    expect(panel({ error: { message: PUBLISH_WORDS.selectionChanged, notice: null } })).toContain(html(PUBLISH_WORDS.selectionChanged));
    expect(panel({ siteUpdating: true })).toContain(html(PUBLISH_WORDS.siteUpdating));
    expect(panel({ summaryFailed: true, summary: null })).toContain(html(PUBLISH_WORDS.countFailed));
  });

  it("shows the Check's progress with Stop checking, its failure, and its summary over step 3's table", () => {
    const progress = panel({ checking: { done: 400, total: 1_234 } });
    expect(progress).toContain("Checking 400 of 1,234…");
    expect(progress).toContain(PUBLISH_WORDS.stopCheck);
    expect(panel({ checkFailed: { done: 400, total: 1_234 } })).toContain("Checking stopped at 400 of 1,234. Try again.");
    const row = toCheckRow({ productVariantId: 101, productId: 11, sku: "ENV-SGL-P50", title: "Envelope Single Pocket, Pack of 50", platform: "ebay",
      listingMode: "create", currentListingStatus: "not_listed", previewStatus: "blocked", blockers: ["catalog_package_data_required"], warnings: [],
      marketplaceQuantity: 25, priceCents: 699, marketplaceCategoryId: null, marketplaceCategoryName: null, storeCategoryNames: [],
      businessPolicySelection: null, previewHash: "h" });
    const result = checkResult({ contextKey: checkContextKey(5, 3), vendorId: 1, storeConnectionId: 5, platform: "ebay", generatedAt: STAMP, rows: [row] });
    const checked = panel({ check: { result, stale: false } });
    expect(checked).toContain("Checked 1: 0 ready · 0 with warnings · 1 not ready");
    expect(checked).toContain("Envelope Single Pocket, Pack of 50");
    // The selected list gives way to the check's table.
    expect(checked).not.toContain(PUBLISH_WORDS.selectedHeading);
    expect(panel({ check: { result, stale: true } })).toContain(PUBLISH_WORDS.checkStale);
    expect(panel({ check: { result, stale: true }, priceSavePending: true })).toContain(PUBLISH_WORDS.settingsSaving);
  });
});

describe("PublishRunCard", () => {
  it("shows the progress and Stop publishing (44 px) while the run goes on", () => {
    const markup = card({ run: run(), counts: { ...emptyListingPushRunCounts(), completed: 1_200, queued: 34 }, problems: { items: [], nextCursor: null }, waitingUntil: null, drafts: 0 });
    expect(markup).toContain("Publishing to marz_cards: 1,200 of 1,234 done");
    expect(markup).toContain("1,200 published");
    expect(markup.match(/<button[^>]*>Stop publishing<\/button>/)?.[0]).toContain("h-11");
    expect(markup).toContain('data-phase="publishing"');
  });

  it("P5 says Stopping, then the stopped words, with no Stop", () => {
    const stopping = card({ run: run({ cancelRequestedAt: STAMP }), counts: emptyListingPushRunCounts(), problems: { items: [], nextCursor: null }, waitingUntil: null, drafts: 0 });
    expect(stopping).toContain(html(PUBLISH_WORDS.runStopping));
    expect(stopping).not.toContain(PUBLISH_WORDS.runStop);
    const stopped = card({ run: run({ status: "cancelled", stopReason: "vendor_stop", cancelRequestedAt: STAMP, targetCount: 1_000 }),
      counts: { ...emptyListingPushRunCounts(), completed: 3, cancelled: 997 }, problems: { items: [], nextCursor: null }, waitingUntil: null, drafts: 0 });
    expect(stopped).toContain("Publishing stopped. 3 of 1,000 were done before you stopped.");
  });

  it("P6 lists what didn't publish with reasons in words, Show more, and the snapshot difference (P9)", () => {
    const problems = [
      { productVariantId: 101, productId: 11, productName: "Envelope", variantName: "Pack of 50", sku: "ENV-50", outcome: "failed" as const,
        code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", message: "eBay refused the price.", retryable: false },
      { productVariantId: 102, productId: 11, productName: "Envelope", variantName: "Pack of 100", sku: "ENV-100", outcome: "blocked" as const,
        code: "DROPSHIP_LISTING_PREVIEW_BLOCKED", message: "catalog_package_data_required", retryable: false },
      { productVariantId: 103, productId: 11, productName: "Envelope", variantName: "Pack of 200", sku: "ENV-200", outcome: "price_review" as const,
        code: "DROPSHIP_LISTING_PRICE_AWAITING_REVIEW", message: null, retryable: false },
    ];
    const markup = card({ run: run({ status: "partial", targetCount: 1_232 }), counts: { ...emptyListingPushRunCounts(), completed: 1_229, failed: 1, blocked: 1, price_review: 1 },
      problems: { items: problems, nextCursor: 103 }, waitingUntil: null, drafts: 0 }, { expectedCount: 1_234, nextProblemsCursor: 103 });
    expect(markup).toContain(PUBLISH_WORDS.runFinished);
    expect(markup).toContain('data-phase="finishedPartial"');
    expect(markup).toContain("Didn&#x27;t publish (3)");
    expect(markup).toContain("eBay refused the price.");
    // The next step under each row (review round 2 DUX5).
    expect(markup).toContain(html(PUBLISH_WORDS.ebayFixStep));
    expect(markup).toContain(html(PUBLISH_WORDS.blockedFixStep));
    expect(markup).toContain(html("Card Shellz hasn't added this size's package size yet. Contact support."));
    expect(markup).toContain(html(PUBLISH_WORDS.priceReviewRow));
    expect(markup).not.toContain("DROPSHIP_");
    expect(markup).not.toContain("catalog_package_data_required");
    expect(markup).toContain(PUBLISH_WORDS.moreProblems);
    // "Publish new" (the run's scope): both reasons a size can be left out (review round 2 DUX8).
    expect(markup).toContain("2 of your selected items were left out: already on eBay, or no longer offered by Card Shellz.");
  });

  // Rebase of PR A onto PR 1b: 1b's refusal words reach the run results, with the store's own name.
  it("shows the stock gate's and the eBay account check's refusals in PR 1b's words", () => {
    const problems = [
      { productVariantId: 201, productId: 21, productName: "Toploader", variantName: "Pack of 25", sku: "TL-25", outcome: "failed" as const,
        code: "PUBLICATION_LISTING_TARGET_UNMAPPED", message: "Publication listing target is not mapped.", retryable: false },
      { productVariantId: 202, productId: 21, productName: "Toploader", variantName: "Pack of 100", sku: "TL-100", outcome: "failed" as const,
        code: "DROPSHIP_EBAY_PUBLICATION_ACCOUNT_UNVERIFIED",
        message: "The published offer cannot be adopted without this store's verified eBay account. Reconnect the intended store account.",
        retryable: false },
    ];
    const finished = { run: run({ status: "partial", targetCount: 3 }), counts: { ...emptyListingPushRunCounts(), completed: 1, failed: 2 },
      problems: { items: problems, nextCursor: null }, waitingUntil: null, drafts: 0 };
    const named = card(finished, { storeOwnName: "Marz Cards" });
    expect(named).toContain(html("Card Shellz has not finished setting up stock updates for this listing yet."));
    expect(named).toContain(html(PUBLISH_WORDS.stockSetupStep));
    expect(named).toContain(html("Card Shellz could not confirm Marz Cards's eBay account for this listing."));
    expect(named).toContain(html(PUBLISH_WORDS.accountCheckStep("Marz Cards")));
    expect(named).not.toContain("Publication listing target is not mapped.");
    expect(named).not.toMatch(/queue/i);
    const nameless = card(finished, { storeOwnName: null });
    expect(nameless).toContain(html(PUBLISH_WORDS.accountCheckStep(null)));
    // The panel hands the store's own name to the card.
    expect(panel({ storeOwnName: "Marz Cards", run: { detail: finished, unread: false, expectedCount: null, moreProblems: [],
      nextProblemsCursor: null, loadingMoreProblems: false, onLoadMoreProblems: () => undefined, stopping: false, stopFailed: false,
      onStop: () => undefined } })).toContain(html(PUBLISH_WORDS.accountCheckStep("Marz Cards")));
  });

  // Merge review ADV-1 and ADV-RB-2: the eBay connector's own text never reaches the row; paused stock says "later".
  it("shows the eBay connector's refusals and Card Shellz's stock pause in the vendor's words", () => {
    const row = (productVariantId: number, code: string, message: string, retryable: boolean) => ({ productVariantId, productId: 31,
      productName: "Sleeve", variantName: `Pack ${productVariantId}`, sku: `SL-${productVariantId}`, outcome: "failed" as const, code, message, retryable });
    const mapping = "Existing published eBay offers require a complete provider listing identity check before any further write. Use the listing's Sync or reviewed recovery action.";
    const limited = "eBay is limiting listing identity checks. Wait before checking again.";
    const suppressed = "Quantity publication is suppressed for this scope.";
    const problems = [row(301, "EBAY_SYNC_MAPPING_INVALID", mapping, false), row(302, "EBAY_PROVIDER_RATE_LIMITED", limited, true),
      row(303, "QUANTITY_PUBLICATION_SUPPRESSED", suppressed, true)];
    const markup = card({ run: run({ status: "partial", targetCount: 4 }), counts: { ...emptyListingPushRunCounts(), completed: 1, failed: 3 },
      problems: { items: problems, nextCursor: null }, waitingUntil: null, drafts: 0 });
    expect(markup).toContain(html(PUBLISH_WORDS.ebayCheckRow));
    expect(markup).toContain(html(PUBLISH_WORDS.ebayCheckStep));
    expect(markup).toContain(html(PUBLISH_WORDS.failedRow));
    expect(markup).toContain(html("Card Shellz has paused stock updates for now."));
    expect(markup).toContain(html(PUBLISH_WORDS.pausedStockStep));
    for (const operatorText of [mapping, limited, suppressed, "EBAY_", "QUANTITY_PUBLICATION_"]) expect(markup).not.toContain(html(operatorText));
    expect(markup).not.toMatch(/queue/i);
  });

  // Rebase of PR A onto Fix PR 2a: the automatic stock link's refusals in 2a's words, with no automatic retry promised
  // (a run's chunk is never re-queued by the push sweep).
  it("shows the automatic stock link's refusals in 2a's words, a publish step, and no automatic retry", () => {
    const row = (productVariantId: number, code: DropshipStockLinkRefusalCode, retryable: boolean) => ({ productVariantId, productId: 41,
      productName: "Binder", variantName: `Pack ${productVariantId}`, sku: `BN-${productVariantId}`, outcome: "failed" as const, code,
      message: dropshipStockLinkServerMessage(code), retryable });
    const problems = [row(401, "DROPSHIP_STOCK_LINK_BUSY", true), row(402, "DROPSHIP_STOCK_UPDATES_PAUSED", true),
      row(403, "DROPSHIP_STOCK_STORE_ACCOUNT_UNVERIFIED", false), row(404, "DROPSHIP_STOCK_DESTINATION_NOT_READY", false),
      row(405, "DROPSHIP_STOCK_SKU_CHANGED", false)];
    const markup = card({ run: run({ status: "partial", targetCount: 6 }), counts: { ...emptyListingPushRunCounts(), completed: 1, failed: 5 },
      problems: { items: problems, nextCursor: null }, waitingUntil: null, drafts: 0 }, { storeOwnName: "Marz Cards" });
    for (const code of ["DROPSHIP_STOCK_LINK_BUSY", "DROPSHIP_STOCK_UPDATES_PAUSED", "DROPSHIP_STOCK_STORE_ACCOUNT_UNVERIFIED",
      "DROPSHIP_STOCK_DESTINATION_NOT_READY"] as const) {
      expect(markup, code).toContain(html(dropshipStockLinkServerMessage(code)));
    }
    expect(markup).toContain(html(PUBLISH_WORDS.retryStep));
    expect(markup).toContain(html(PUBLISH_WORDS.pausedStockStep));
    expect(markup).toContain(html(PUBLISH_WORDS.reconnectStep("Marz Cards")));
    expect(markup).toContain(html(PUBLISH_WORDS.stockSetupStep));
    expect(markup).toContain(html(PUBLISH_WORDS.staleRow));
    expect(markup).not.toMatch(/automatically|queue|DROPSHIP_/i);
  });

  it("P11 words a run eBay stopped answering for; before the first read it says Starting", () => {
    const down = card({ run: run({ status: "failed", stopReason: "provider_unavailable", targetCount: 10 }),
      counts: { ...emptyListingPushRunCounts(), completed: 4, failed: 6 }, problems: { items: [], nextCursor: null }, waitingUntil: null, drafts: 0 });
    expect(down).toContain(html("eBay wasn't answering, so publishing stopped. 4 of 10 were done. Publish again later."));
    expect(card(null)).toContain(PUBLISH_WORDS.starting);
    expect(card(null, { unread: true })).toContain(html(PUBLISH_WORDS.runUnread));
  });
});

describe("review round 2 (step 1 plan S2-5, PR A)", () => {
  const empty = { items: [], nextCursor: null };

  it("DUX6 colours a finished run by what it did: green all published, amber partial or drafts, rose nothing published", () => {
    const all = card({ run: run({ status: "completed" }), counts: { ...emptyListingPushRunCounts(), completed: 1_234 }, problems: empty, waitingUntil: null, drafts: 0 });
    expect(all).toContain('data-phase="finished"');
    expect(all).toContain("border-emerald-200");
    const partial = card({ run: run({ status: "partial" }), counts: { ...emptyListingPushRunCounts(), completed: 1_000, failed: 234 }, problems: empty, waitingUntil: null, drafts: 0 });
    expect(partial).toContain('data-phase="finishedPartial"');
    expect(partial).toContain("border-amber-300");
    expect(partial).toContain(PUBLISH_WORDS.runFinished);
    const nothing = card({ run: run({ status: "failed", targetCount: 500 }), counts: { ...emptyListingPushRunCounts(), blocked: 500 }, problems: empty, waitingUntil: null, drafts: 0 });
    expect(nothing).toContain('data-phase="finishedNothing"');
    expect(nothing).toContain("border-rose-200");
    expect(nothing).toContain(html(PUBLISH_WORDS.runNothingPublished));
    expect(nothing).not.toContain("border-emerald-200");
  });

  it("DUX3 says when a waiting run goes on, and counts drafts apart from published, amber", () => {
    const waiting = card({ run: run(), counts: { ...emptyListingPushRunCounts(), completed: 1_200, queued: 34 }, problems: empty,
      waitingUntil: "2026-10-20T12:30:00.000Z", drafts: 0 });
    expect(waiting).toContain('data-testid="publish-run-waiting"');
    expect(waiting).toContain("eBay is busy. Publishing waits and goes on by itself at ");
    const drafts = card({ run: run({ status: "completed" }), counts: { ...emptyListingPushRunCounts(), completed: 500 }, problems: empty,
      waitingUntil: null, drafts: 500 });
    expect(drafts).toContain("500 saved as unpublished drafts");
    expect(drafts).not.toContain("500 published");
    expect(drafts).toContain(html(PUBLISH_WORDS.runDrafts));
    expect(drafts).toContain('data-phase="finishedPartial"');
  });

  it("DUX10 the live region says the phase, not the counts that change on every poll; the Check's bar has a name", () => {
    const going = card({ run: run(), counts: { ...emptyListingPushRunCounts(), completed: 1_200 }, problems: empty, waitingUntil: null, drafts: 0 });
    const live = going.match(/<p role="status" aria-live="polite"[^>]*>([^<]*)<\/p>/)?.[1] ?? "";
    expect(live).toBe(PUBLISH_WORDS.runAnnounce("marz_cards"));
    expect(going.match(/<p[^>]*data-testid="publish-run-title"[^>]*>/)?.[0]).not.toContain("aria-live");
    expect(panel({ checking: { done: 400, total: 1_234 } })).toContain(`aria-label="${PUBLISH_WORDS.checkProgressLabel}"`);
  });

  it("DUX1 and DUX12 a finished card can be hidden, and a failed Show more says so", () => {
    const finished = card({ run: run({ status: "completed" }), counts: { ...emptyListingPushRunCounts(), completed: 1 }, problems: empty, waitingUntil: null, drafts: 0 },
      { onHide: () => undefined, moreProblemsFailed: true });
    expect(finished).toContain('data-testid="publish-run-hide"');
    expect(finished).not.toContain('data-testid="publish-run-more-failed"');
    const going = card({ run: run(), counts: emptyListingPushRunCounts(), problems: empty, waitingUntil: null, drafts: 0 }, { onHide: () => undefined });
    expect(going).not.toContain('data-testid="publish-run-hide"');
    const problems = [{ productVariantId: 101, productId: 11, productName: "Envelope", variantName: "Pack of 50", sku: "ENV-50", outcome: "failed" as const,
      code: "DROPSHIP_EBAY_MANAGED_LOCATION_CONFIG_MISMATCH", message: "…then queue the listing again.", retryable: false }];
    const failedMore = card({ run: run({ status: "partial" }), counts: { ...emptyListingPushRunCounts(), completed: 1, failed: 1 },
      problems: { items: problems, nextCursor: 101 }, waitingUntil: null, drafts: 0 }, { nextProblemsCursor: 101, moreProblemsFailed: true });
    expect(failedMore).toContain(html(PUBLISH_WORDS.moreProblemsFailed));
    // DUX5: the ship-from failure gets the vendor's words and step, never "queue".
    expect(failedMore).toContain(html(PUBLISH_WORDS.shipFromRow));
    expect(failedMore).toContain(html(PUBLISH_WORDS.shipFromStep));
    expect(failedMore).not.toContain("queue");
  });

  it("DUX8 'Publish new' names both reasons a size was left out", () => {
    const left = card({ run: run({ scope: "not_live", targetCount: 38 }), counts: emptyListingPushRunCounts(), problems: empty, waitingUntil: null, drafts: 0 },
      { expectedCount: 40 });
    expect(left).toContain(html(PUBLISH_WORDS.runSnapshotDiffNew(2)));
    const leftAll = card({ run: run({ scope: "all", targetCount: 38 }), counts: emptyListingPushRunCounts(), problems: empty, waitingUntil: null, drafts: 0 },
      { expectedCount: 40 });
    expect(leftAll).toContain(html(PUBLISH_WORDS.runSnapshotDiff(2)));
  });

  it("DUX9 the step-up state shows on the pressed button only, the code line names it, and Publish all has no count until read", () => {
    const pressedAll = panel({ pending: "send-code", pressedScope: "all" });
    expect(pressedAll.match(/<button[^>]*data-testid="publish-all"[^>]*>[\s\S]*?<\/button>/)?.[0]).toContain(PUBLISH_WORDS.sendingCode);
    expect(pressedAll.match(/<button[^>]*data-testid="publish-new"[^>]*>[\s\S]*?<\/button>/)?.[0]).toContain("Publish 1,000 new");
    const code = panel({ emailCodeSent: true, pressedScope: "not_live" });
    expect(code).toContain(PUBLISH_WORDS.codeLineFor("Publish 1,000 new"));
    const loading = panel({ choices: null, summary: null });
    expect(loading.match(/<button[^>]*data-testid="publish-all"[^>]*>[\s\S]*?<\/button>/)?.[0]).toContain(`${PUBLISH_WORDS.publishAllUncounted}</button>`);
    expect(loading).not.toContain("Publish all 0");
  });

  it("DUX4, DUX11, DUX13, DUX14: the page's save doesn't wait for the count, step 1's count says updating and Try again, alerts keep line breaks", () => {
    const page = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipPortalCatalog.tsx"), "utf8");
    const saved = page.slice(page.indexOf("async function afterSelectionSaved()"), page.indexOf("const afterSelectionSavedRef"));
    expect(saved).toContain("void queryClient.invalidateQueries({ queryKey: [...SELECTION_SUMMARY_QUERY_KEY] });");
    expect(saved.slice(saved.indexOf("await Promise.allSettled"))).not.toContain("SELECTION_SUMMARY_QUERY_KEY");
    expect(page).toContain('data-testid="catalog-count-updating"');
    expect(page).toContain("onClick={() => { void selectionSummaryQuery.refetch(); }}");
    expect(page).toContain("throw new Error(PUBLISH_WORDS.waitForPublishStart);");
    expect(page).not.toContain("Wait for publishing to start before saving listing changes.");
    const alerts = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipPortalNotifications.tsx"), "utf8");
    expect(alerts).toContain('<p className="mt-1 whitespace-pre-line text-sm text-zinc-600">{notification.message}</p>');
  });

  it("DUX2 a checked row has no empty image box, and its sheet reads the size's full preview", () => {
    const preview = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipListingPreview.tsx"), "utf8");
    expect(preview).toContain("{row.presentation !== undefined && (");
    expect(preview).toContain("enabled: needsDetail,");
    expect(preview).toContain("PUBLISH_WORDS.detailsLoading");
    expect(preview).toContain("PUBLISH_WORDS.sheetFooter(");
    expect(preview).not.toContain("Queueing is disabled");
    expect(preview).not.toContain("does not queue listings");
    const step = readFileSync(join(process.cwd(), "client/src/pages/dropship/catalog/PublishStep.tsx"), "utf8");
    expect(step).toContain("loadRowDetail={props.loadCheckDetail}");
  });
});

describe("step 3 sources (moved from DropshipPortalCatalog.test.ts)", () => {
  const page = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipPortalCatalog.tsx"), "utf8");
  const step = readFileSync(join(process.cwd(), "client/src/pages/dropship/catalog/PublishStep.tsx"), "utf8");
  const ops = readFileSync(join(process.cwd(), "client/src/lib/dropship-ops-surface.ts"), "utf8");

  it("mounts PublishStep on step 3, with no 500 limit and no selected rows of its own", () => {
    expect(page).toContain("<PublishStep");
    for (const gone of ["fetchAllSelectedCatalogRows", "SELECTED_CATALOG_PAGE_LIMIT", "previewContextKey", "pushListings", "queueListingsOnce",
      "ListingPreviewPanel", "ListingQueueResultNotice", "buildListingQueueRequest", "/api/dropship/listing-push-jobs\""]) {
      expect(page, gone).not.toContain(gone);
    }
    for (const gone of ["MAX_LISTING_QUEUE_VARIANTS", "buildListingQueueRequest", "describeListingQueueResult"]) expect(ops, gone).not.toContain(gone);
    expect(step).not.toMatch(/productVariantIds:\s*selected/);
    // A run is the server's snapshot: the page sends a scope and a revision, never ids.
    expect(step).toContain("publishRunBody({ ...request, idempotencyKey: key })");
  });

  it("hands the run card the store's own name (PR 1b catalogStoreOwnName), never the placeholder", () => {
    expect(page).toContain("const selectedStoreOwnName = catalogStoreOwnName(selectedStoreConnection);");
    expect(page).toContain("storeOwnName={selectedStoreOwnName}");
    expect(step).toContain("storeOwnName={props.storeOwnName}");
  });

  it("keeps the verification for publishing only, and never emails a code for a blocked publish", () => {
    expect(PUBLISH_WORDS.verifyLine).toBe("Checking needs no verification. A code is asked for only when you publish.");
    expect(step).toContain('verifyPasskeyStepUp("bulk_listing_push")');
    expect(step).toContain('startEmailStepUp("bulk_listing_push")');
    const handler = step.slice(step.indexOf("async function publish("), step.indexOf("async function runCheck("));
    expect(handler.indexOf("if (props.pushAccessNotice) return;")).toBeGreaterThan(-1);
    expect(handler.indexOf("if (props.pushAccessNotice) return;")).toBeLessThan(handler.indexOf("startEmailStepUp"));
    // A refused proof is read again, so the next press asks for a new one.
    expect(handler).toContain("props.onProofRefused();");
    // Any Listing settings save holds publishing (Interim, PR 12 PROPOSAL), in the words module.
    expect(handler).toContain("if (props.priceSavePending) {");
    expect(handler).toContain("PUBLISH_WORDS.waitForSettings");
    expect(PUBLISH_WORDS.waitForSettings).toBe("Wait for your listing settings to finish saving, then publish again.");
  });

  it("keeps listing failures inside the step's card, and reuses an unconfirmed press's key only for the same choice", () => {
    expect(step).toContain("{props.error && (props.error.notice");
    expect(step).toContain("unconfirmedRef.current?.fingerprint === fingerprint");
    expect(step).toContain('createDropshipIdempotencyKey("listing-push-run")');
  });

  it("verify VC1, VC2, VC6, VC9, VC15: a newer run replaces the card; the newest run is read again; the limiter keeps the key", () => {
    // A newer run (ids grow) replaces the shown card; the shown one or an older one never does (VC1).
    expect(step).toContain("if (shownRun?.storeConnectionId === storeConnectionId && found.run.runId <= shownRun.runId) return;");
    // After a create and when a run ends, the store's newest run is read again (VC2); an unconfirmed press too (VC1).
    const publish = step.slice(step.indexOf("async function publish("), step.indexOf("async function runCheck("));
    expect(publish.match(/refreshLatest\(\);/g)?.length).toBe(3);
    expect(step).toContain("    refreshLatest();\n  }, [runDetail, onSelectionStale, refreshLatest]);");
    // A 429 from the create keeps the press's key (VC6).
    const limited = publish.slice(publish.indexOf('refusal.kind === "rateLimited"'));
    expect(limited.slice(0, limited.indexOf("return;"))).toContain("unconfirmedRef.current = { fingerprint, key };");
    // Stop and Show more classify their failures (VC9).
    expect(step.match(/handleRunActionError\(caught, runId, /g)).toHaveLength(2);
    // A hide is stored with its time, and expired ones are removed as they are read (VC15).
    expect(step).toContain("window.localStorage.setItem(hiddenRunStorageKey(runId), String(nowMs));");
    expect(step).toContain("for (const key of expired) window.localStorage.removeItem(key);");
  });
});

describe("verify round (client)", () => {
  it("VC5 says the count is being read again for any passing failure, apart from site updating", () => {
    const retrying = panel({ countRetrying: true });
    expect(retrying).toContain('data-testid="publish-count-retrying"');
    expect(retrying).toContain(html(PUBLISH_WORDS.countRetrying));
    // Site updating says its own words instead, once.
    const updating = panel({ countRetrying: true, siteUpdating: true });
    expect(updating).not.toContain('data-testid="publish-count-retrying"');
    expect(updating).toContain(html(PUBLISH_WORDS.siteUpdating));
    expect(panel({})).not.toContain('data-testid="publish-count-retrying"');
    const page = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipPortalCatalog.tsx"), "utf8");
    expect(page).toContain('data-testid="catalog-count-retrying"');
    expect(page).toContain("|| selectionSummaryQuery.isPaused);");
  });

  it("VC10 the retired page's Reload reloads without the browser's leave prompt", () => {
    const table = readFileSync(join(process.cwd(), "client/src/pages/dropship/catalog/ChooseTable.tsx"), "utf8");
    expect(table).toContain("onClick={() => reloadPageWithoutLeavePrompt()}");
    expect(table).not.toContain("window.location.reload()");
    const guard = readFileSync(join(process.cwd(), "client/src/pages/dropship/catalog/UnsavedChangesGuard.tsx"), "utf8");
    expect(guard).toContain("if (reloadingOnPurpose) return;");
  });
});
