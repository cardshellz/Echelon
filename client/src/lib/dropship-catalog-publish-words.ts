/**
 * The vendor's words for Catalog step 3, "Publish", on publish runs (step 1
 * plan S2-5, PR A, §4.11). Every string is marked "Stage 2 (step 1 plan
 * S2-5)" and PROPOSED: new in stage 2 and kept in this one file, so a later
 * change edits one place. Where the server sends the same words
 * (server/modules/dropship/domain/listing-push-run-words.ts,
 * catalog-read-words.ts), the key names match. Pure: no React, no network,
 * no clock. Counts read "1,200", as everywhere else in the Catalog.
 */
import { DROPSHIP_SITE_UPDATING_MESSAGE } from "./dropship-ops-surface";

/** "1,200": every count the step shows. */
export function formatPublishCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** The parts of a run's counts line, left out when zero (§4.11 runCounts). */
export interface RunCountParts {
  /** Published so buyers can see them (completed, less the drafts). */
  completed: number;
  /** Completed, but saved as unpublished drafts (the store's listing mode is not live; review round 2 DUX3). */
  drafts?: number;
  notReady: number;
  review: number;
  failed: number;
  skipped: number;
}

export const PUBLISH_WORDS = Object.freeze({
  // Stage 2 (step 1 plan S2-5): PROPOSED. The step's line under "Step 3 · Publish"; replaces "Preview and queue your selected listings to {store}.".
  stepIntro: (store: string) => `Check and publish your selected listings to ${store}.`,
  // Stage 2 (step 1 plan S2-5): PROPOSED. The card's heading; replaces "Listing preview and push".
  heading: "Check and publish",
  // Stage 2 (step 1 plan S2-5): PROPOSED (publishLine).
  publishLine: "Each size is checked and sent to eBay, 500 at a time. Thousands of listings can take a few hours; you can leave this page.",
  // Stage 2 (step 1 plan S2-5): PROPOSED (checkButton).
  checkButton: "Check listings",
  // Stage 2 (step 1 plan S2-5): PROPOSED (checkHint).
  checkHint: "Optional. Publishing checks each listing again as it goes.",
  // Stage 2 (step 1 plan S2-5): PROPOSED (checking).
  checking: (done: number, total: number) => `Checking ${formatPublishCount(done)} of ${formatPublishCount(total)}…`,
  // Stage 2 (step 1 plan S2-5): PROPOSED (stopCheck).
  stopCheck: "Stop checking",
  // Stage 2 (step 1 plan S2-5): PROPOSED (checkSummary).
  checkSummary: (total: number, ready: number, warnings: number, blocked: number) =>
    `Checked ${formatPublishCount(total)}: ${formatPublishCount(ready)} ready · ${formatPublishCount(warnings)} with warnings · ${formatPublishCount(blocked)} not ready`,
  // Stage 2 (step 1 plan S2-5): PROPOSED (checkFailed).
  checkFailed: (done: number, total: number) => `Checking stopped at ${formatPublishCount(done)} of ${formatPublishCount(total)}. Try again.`,
  // Stage 2 (step 1 plan S2-5): PROPOSED. The check's results after a Listing settings save started; replaces "This preview is out of date…".
  checkStale: "These results are out of date. Check again to see current details.",
  // Kept (step 3's words since PR 12, Interim PROPOSAL): a Listing settings save is still running.
  settingsSaving: "Saving your listing settings…",
  // Stage 2 (step 1 plan S2-5): PROPOSED. A Listing settings save holds publishing; replaces "…then queue again.".
  waitForSettings: "Wait for your listing settings to finish saving, then publish again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED (publishNew). Hidden when nothing is new.
  publishNew: (count: number) => `Publish ${formatPublishCount(count)} new`,
  // Stage 2 (step 1 plan S2-5): PROPOSED (publishAll).
  publishAll: (count: number) => `Publish all ${formatPublishCount(count)}`,
  // Stage 2 (step 1 plan S2-5): PROPOSED (publishAllHint).
  publishAllHint: (live: number) =>
    `Also re-sends the ${formatPublishCount(live)} already on eBay. Use it after you change prices or listing settings, or if a listing was changed or ended on eBay directly.`,
  // Stage 2 (step 1 plan S2-5): PROPOSED. While the press is sent (the step-up and the request).
  starting: "Starting…",
  // The step-up's states on the pressed button, as the queue button had them.
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  sendingCode: "Sending code",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  verifyingCode: "Verifying code",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  waitingForPasskey: "Waiting for passkey",
  // Stage 2 (step 1 plan S2-5): PROPOSED. The code box's label; replaces "Verification code to push listings".
  codeLabel: "Verification code to publish listings",
  // Stage 2 (step 1 plan S2-5): PROPOSED. The code box's line; replaces "…then verify and queue the push."
  codeLine: "Enter the 6-digit code sent to your email, then press Publish again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED (was the page banner's "Verification code sent.").
  codeSent: "Verification code sent.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. Replaces "…before queueing a listing push."
  codeIncomplete: "Enter the 6-digit verification code before publishing.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. Replaces "MFA is requested only when you queue ready listings."
  verifyLine: "Checking needs no verification. A code is asked for only when you publish.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. The proof expired between the page and the server; replaces "…Choose Queue ready listings again to verify."
  stepUpExpired: "Your verification expired before publishing started. Press Publish again to verify.",
  // Stage 2 (step 1 plan S2-5): PROPOSED (runProgress).
  runProgress: (store: string, done: number, total: number) =>
    `Publishing to ${store}: ${formatPublishCount(done)} of ${formatPublishCount(total)} done`,
  // Stage 2 (step 1 plan S2-5): PROPOSED (runCounts), zero parts left out.
  runCounts: (parts: RunCountParts) => [
    parts.completed > 0 ? `${formatPublishCount(parts.completed)} published` : null,
    (parts.drafts ?? 0) > 0 ? `${formatPublishCount(parts.drafts ?? 0)} saved as unpublished drafts` : null,
    parts.notReady > 0 ? `${formatPublishCount(parts.notReady)} not ready` : null,
    parts.review > 0 ? `${formatPublishCount(parts.review)} price needs your review` : null,
    parts.failed > 0 ? `${formatPublishCount(parts.failed)} failed` : null,
    parts.skipped > 0 ? `${formatPublishCount(parts.skipped)} skipped` : null,
  ].filter((part): part is string => part !== null).join(" · "),
  // Stage 2 (step 1 plan S2-5): PROPOSED (runStop).
  runStop: "Stop publishing",
  // Stage 2 (step 1 plan S2-5): PROPOSED (runStopping).
  runStopping: "Stopping… The listing being sent right now finishes first.",
  // Stage 2 (step 1 plan S2-5): PROPOSED (runStopped); "was" when one was done (verify VC13).
  runStopped: (done: number, total: number) =>
    `Publishing stopped. ${formatPublishCount(done)} of ${formatPublishCount(total)} ${done === 1 ? "was" : "were"} done before you stopped.`,
  // Stage 2 (step 1 plan S2-5): PROPOSED (runProviderDown); "was" when one was done (verify VC13).
  runProviderDown: (done: number, total: number) =>
    `eBay wasn't answering, so publishing stopped. ${formatPublishCount(done)} of ${formatPublishCount(total)} ${done === 1 ? "was" : "were"} done. Publish again later.`,
  // Stage 2 (step 1 plan S2-5): PROPOSED (runFinished).
  runFinished: "Publishing finished.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. A run that ended with nothing published (review round 2 DUX6); the counts say why.
  runNothingPublished: "Publishing finished, but nothing was published.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. A paused run's next try (review round 2 DUX3; the server's waitingUntil).
  runWaiting: (time: string) => `eBay is busy. Publishing waits and goes on by itself at ${time}.`,
  // Stage 2 (step 1 plan S2-5): PROPOSED. Some sizes were saved as drafts (review round 2 DUX3; HEAD's draft notice, for runs).
  runDrafts: "Your store is set to save drafts instead of publishing, so buyers can't see those yet. Ask Card Shellz support to switch your store to live listings, then publish again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. The live region's words while a run goes on: said once, not on every poll (review round 2 DUX10).
  runAnnounce: (store: string) => `Publishing to ${store} started. Progress shows on this page.`,
  // Stage 2 (step 1 plan S2-5): PROPOSED. Hides a finished run's card that this page showed again after a reload (review round 2 DUX1).
  runHide: "Hide",
  // Stage 2 (step 1 plan S2-5): PROPOSED. "Show more" failed (review round 2 DUX12).
  moreProblemsFailed: "More couldn't be loaded. Press Show more again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. The stop could not be sent; the run goes on.
  stopFailed: "Stopping didn't go through. Press Stop publishing again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. The run could not be read; the page keeps asking.
  runUnread: "Publishing is running, but its progress couldn't be loaded. This page keeps trying.",
  // Stage 2 (step 1 plan S2-5): PROPOSED (runProblems).
  runProblems: (count: number) => `Didn't publish (${formatPublishCount(count)})`,
  // Stage 2 (step 1 plan S2-5): PROPOSED. Reads the next 50 problem sizes.
  moreProblems: "Show more",
  // Stage 2 (step 1 plan S2-5): PROPOSED (priceReviewRow).
  priceReviewRow: "Its price changed after you pressed Publish, and your cost-change setting waits for your review. Check it, then publish again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. A target the run's chunk could not take (§4.12 CHUNK_CONFLICT), or one that changed meanwhile.
  staleRow: "It changed while publishing. Publish again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. A failed size the store gave no reason for.
  failedRow: "It couldn't be sent. Publish again, or contact Card Shellz support if it keeps failing.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. A size whose product's stock could not be read; only that product's sizes fail (verify V6, VC8).
  stockUnreadRow: "Its stock couldn't be read, so it wasn't sent.",
  // The "Didn't publish" rows' reasons and next steps for codes the server's message is not written for the vendor
  // (review round 2 DUX5; HEAD's listingPushNextStep and STOCK_GATE_REFUSALS words, for runs: "publish again").
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  shipFromRow: "Card Shellz changed the warehouse your listings ship from.",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  shipFromStep: "In Listing settings, choose Update now under Shipping policy, then publish again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  priorOutcomeRow: "An earlier stock update for this listing on eBay still has to be confirmed by Card Shellz.",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  priorOutcomeStep: "Nothing to fix on your side. Contact Card Shellz support with this message; once they confirm that earlier update, publish again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  cooldownRow: "eBay asked for a pause after the last attempt.",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  laterStep: "Publish again in a few minutes.",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  ebayTemporaryStep: "This was a temporary problem at eBay. Publish again in a few minutes.",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  ebayFixStep: "Fix what eBay named, then publish again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  blockedFixStep: "Fix what's named, then publish again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  accountStep: "Your account or store cannot list right now. See the notice at the top of this card.",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  retryStep: "Publish again in a few minutes. Contact Card Shellz support with this message if it keeps failing.",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  fixStep: "Fix the reason and publish again, or contact Card Shellz support with this message.",
  // The next steps of the rows whose reasons are PR 1b's refusal words (listingPushRefusalWords), for runs: "publish
  // again". The eBay account check: the settings button reads "Reconnect <store name>", and without a name of its own
  // the words name the button (1b's unverifiedAccountWords).
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  accountCheckStep: (storeName: string | null) => {
    const name = storeName?.trim();
    return name
      ? `Publish again. If it fails the same way, choose Reconnect ${name} in Settings first, then publish again.`
      : "Publish again. If it fails the same way, choose the store's Reconnect button in Settings first, then publish again.";
  },
  // Stage 2 (step 1 plan S2-5): PROPOSED. The listing already on eBay belongs to the other eBay site (1b's words).
  ebaySiteStep: "Publishing again will not help. Contact Card Shellz support with this message.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. A stock-gate refusal only Card Shellz can clear (1b's permanent stock words).
  stockSetupStep: "Nothing to fix on your side. Contact Card Shellz support with this message; once they fix it, publish again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. Card Shellz paused stock updates for now (1b's paused stock words): later, not in a few minutes.
  pausedStockStep: "Publish again later. Contact Card Shellz support with this message if it keeps failing.",
  // The next steps of the automatic stock link's refusals (Fix PR 2a, shared/dropship/stock-link-refusals) that the
  // vendor acts on, for runs: "publish again". The store's eBay account is not provider-verified: reconnecting it
  // clears it, publishing again first does not (the stock link refuses it the same way; its words say reconnect first).
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  reconnectStep: (storeName: string | null) => {
    const name = storeName?.trim();
    return name
      ? `Choose Reconnect ${name} in Settings, then publish again.`
      : "Choose the store's Reconnect button in Settings, then publish again.";
  },
  // Stage 2 (step 1 plan S2-5): PROPOSED. The item's link to Card Shellz stock changed after it was set up (2a's words: try again first).
  publishAgainStep: "Publish again. Contact Card Shellz support with this message if it fails the same way.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. Card Shellz is not offering stock for this item on the store right now (2a's words).
  notOfferedStep: "Check that the item is still in your selection in step 1 and your store isn't paused, then publish again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. An automatic re-send met a published eBay listing with this SKU (2a's words).
  listingFoundStep: "Check that listing on eBay. To let Card Shellz manage it (its title, price and stock), publish again. Contact Card Shellz support with this message if you are not sure.",
  // A refusal of Card Shellz's eBay connection that sending again cannot clear; its own message is written for Card
  // Shellz staff, so the row never shows it (merge review ADV-1).
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  ebayCheckRow: "Card Shellz has to check this listing on eBay before it can be published.",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  ebayCheckStep: "Contact Card Shellz support with this message; once they've checked it, publish again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED (runSnapshotDiff).
  runSnapshotDiff: (count: number) =>
    `${formatPublishCount(count)} of your selected items ${count === 1 ? "is" : "are"} no longer offered by Card Shellz and ${count === 1 ? "was" : "were"} left out.`,
  // Stage 2 (step 1 plan S2-5): PROPOSED. "Publish new" left sizes out: they became live meanwhile, or are no longer offered (review round 2 DUX8).
  runSnapshotDiffNew: (count: number) =>
    `${formatPublishCount(count)} of your selected items ${count === 1 ? "was" : "were"} left out: already on eBay, or no longer offered by Card Shellz.`,
  // Stage 2 (step 1 plan S2-5): PROPOSED (runActive); the server's words too.
  runActive: "A publish is already running for this store. It's shown below.",
  // Stage 2 (step 1 plan S2-5): PROPOSED (selectionChanged); the server's words too.
  selectionChanged: "Your choices changed since this page loaded. Check the count and publish again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED (runTooLarge); the server's words too.
  runTooLarge: "More than 10,000 sizes are selected. Remove some in step 1, then publish.",
  // Stage 2 (step 1 plan S2-5): PROPOSED (runEmptyNew); the server's words too.
  runEmptyNew: "Everything selected is already on eBay. Use Publish all to re-send it.",
  // Stage 2 (step 1 plan S2-5): PROPOSED (runEmpty); the server's words too. Replaces "Choose items in step 1, Choose what to sell…".
  runEmpty: "Choose what to sell in step 1 first.",
  // Stage 2 (step 1 plan S2-5): PROPOSED (notSent).
  notSent: "Publishing didn't start. Check your connection and press Publish again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED (rateLimited); the server's words too. Too many presses in a minute (verify VC6).
  runRateLimited: "Too many publish requests in a minute. Wait a moment and try again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. Every try went unanswered or said "try again", so a run may exist (review round 2 DUX7).
  notConfirmed: "We couldn't confirm that publishing started. Press Publish again; it won't publish anything twice.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. A Listing settings save while a publish press is sent (moved here, review round 2 DUX14).
  waitForPublishStart: "Wait for publishing to finish starting, then save.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. The code box's line, naming the button pressed (review round 2 DUX9).
  codeLineFor: (button: string) => `Enter the 6-digit code sent to your email, then press ${button} again.`,
  // Stage 2 (step 1 plan S2-5): PROPOSED. "Publish all" while the count is read (review round 2 DUX9).
  publishAllUncounted: "Publish all",
  // Stage 2 (step 1 plan S2-5): PROPOSED. The Check's progress bar's name (review round 2 DUX10).
  checkProgressLabel: "Checking progress",
  // Stage 2 (step 1 plan S2-5): PROPOSED. A checked listing's full details are read when its preview opens (review round 2 DUX2).
  detailsLoading: "Loading this listing's details…",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  detailsFailed: "This listing's details couldn't be loaded.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. The preview sheet's last line on step 3; replaces "…does not queue listings.".
  sheetFooter: (generatedAt: string) => `Preview generated ${generatedAt}. Viewing this preview or estimating shipping doesn't publish anything.`,
  // Stage 2 (step 1 plan S2-5): PROPOSED (emailTitle); the server sends the email (listing-push-run-words.ts).
  emailTitle: "Some listings didn't publish",
  // Stage 2 (step 1 plan S2-5): PROPOSED (siteUpdating), the words readDropshipJson's error carries.
  siteUpdating: DROPSHIP_SITE_UPDATING_MESSAGE,
  // Stage 2 (step 1 plan S2-5): PROPOSED. The selection count couldn't be read.
  countFailed: "Your selected count couldn't be loaded.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. The count's read failed for a passing reason and is read again by itself (verify VC5).
  countRetrying: "Your selected count couldn't be loaded yet. Trying again…",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  tryAgain: "Try again",
  // The metric tiles over the buttons.
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  selectedMetric: "Selected",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  liveMetric: "Already on eBay",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  newMetric: "Not on eBay yet",
  // Kept: the list's heading.
  selectedHeading: "Selected items",
  // Stage 2 (step 1 plan S2-5): PROPOSED. Replaces "These items are checked when you preview or queue them."
  selectedLine: "These items are checked again when you publish them.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. The list's count line (200 a page, at most 1,000 shown).
  selectedShown: (shown: number, total: number) => (shown < total
    ? `Showing ${formatPublishCount(shown)} of ${formatPublishCount(total)}`
    : `Showing all ${formatPublishCount(total)}`),
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  loadMore: "Load more",
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  loadingMore: "Loading…",
  // Stage 2 (step 1 plan S2-5): PROPOSED. The list couldn't be read.
  listFailed: "Your selected items couldn't be loaded.",
  // Kept: the list's columns.
  columns: Object.freeze({ product: "Product", variant: "Variant", sku: "SKU", quantity: "Quantity" }),
  // Kept: a size with no SKU.
  sizeFallback: (productVariantId: number) => `Variant ${productVariantId}`,
  // Stage 2 (step 1 plan S2-5): PROPOSED. No ready eBay store; replaces "…before previewing or pushing listings."
  storeNotReady: "Connect your eBay store and finish its setup before checking or publishing listings.",
});
