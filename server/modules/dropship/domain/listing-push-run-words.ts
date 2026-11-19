// Stage 2 (step 1 plan S2-5)
/**
 * The vendor's words for publish runs that the server sends: refusals the
 * page shows as they are, the text kept on an item a stop cancelled, and the
 * one email a run sends. Every string here is PROPOSED (plan §4.11): new in
 * stage 2 and kept in this one file so a later change edits one place. Where
 * the page has the same words (client/src/lib/dropship-catalog-publish-words.ts,
 * PR A3), the key names match the plan's.
 */
export const LISTING_PUSH_RUN_WORDS = {
  /** runActive */
  runActive: "A publish is already running for this store. It's shown below.",
  /** selectionChanged */
  selectionChanged: "Your choices changed since this page loaded. Check the count and publish again.",
  /** runTooLarge (also SEL's refusal, LISTING_PUSH_RUN_TOO_LARGE_MESSAGE) */
  runTooLarge: "More than 10,000 sizes are selected. Remove some in step 1, then publish.",
  /** runEmptyNew */
  runEmptyNew: "Everything selected is already on eBay. Use Publish all to re-send it.",
  /** runEmpty */
  runEmpty: "Choose what to sell in step 1 first.",
  /** A selection save holds the vendor's lock; the page retries with the same key and shows nothing new. */
  runBusy: "Your choices are being saved. Publishing will start in a moment.",
  /** reused publish key */
  keyReused: "This publish request key was already used for a different publish.",
  /** a run of another vendor, or one that does not exist */
  runNotFound: "That publish was not found.",
  /** an invalid body or query */
  invalidInput: "The publish request was not valid.",
  /** a push job key a vendor may not send */
  keyReserved: "This request key is reserved. Send a different Idempotency-Key.",
  /** kept on an item a stop cancelled */
  itemStopped: "Publishing was stopped before this size was sent.",
  /** kept on an item eBay stayed unavailable for */
  itemProviderUnavailable: "eBay wasn't answering, so this size wasn't sent. Publish again later.",
  /** kept on an item whose size is no longer chosen when its turn to be sent came */
  itemNotSelected: "This size is no longer chosen to sell, so it wasn't sent.",
  /** emailTitle */
  emailTitle: "Some listings didn't publish",
  /** a member's publish budget for the minute is spent (moved here from the routes, review DUX12) */
  rateLimited: "Too many publish requests in a minute. Wait a moment and try again.",
  /** a database failure that passes (a deadlock, a lock or statement timeout); the page sends it again (review CT9) */
  unavailable: "Publishing is busy for a moment. Try again.",
  /** a fault on Card Shellz's side that needs a human (moved here from the routes, review DUX12) */
  requestFailed: "Publishing could not be read or started. Try again.",
} as const;

/** A problem size as the run's email names it (the first rows of the run's problem list). */
export interface ListingPushRunNoticeProblem {
  productVariantId: number;
  productName: string | null;
  variantName: string | null;
  sku: string | null;
  outcome: "failed" | "blocked" | "price_review" | "stale";
  code: string | null;
}

/** The longest name a row of the email shows, and the whole message's budget (the notification's limit is 5,000). */
export const RUN_NOTICE_NAME_MAX_CHARS = 80;
export const RUN_NOTICE_MESSAGE_MAX_CHARS = 4_000;

/** Why one size didn't publish, for the email (review DUX1): plain words by outcome, never a code. */
export function runNoticeProblemReason(problem: Pick<ListingPushRunNoticeProblem, "outcome" | "code">): string {
  switch (problem.outcome) {
    case "price_review": return "Its price changed after you pressed Publish, and your cost-change setting waits for your review.";
    case "stale": return "It changed while publishing.";
    case "blocked": return "It isn't ready to list yet.";
    case "failed":
      if (problem.code === "DROPSHIP_LISTING_PUSH_PROVIDER_UNAVAILABLE") return "eBay wasn't answering.";
      // A failure the vendor fixes themselves gets its step (review round 2 DUX5): before runs, the per-job email
      // carried this message as written; a run's child sends no email of its own.
      if (problem.code === "DROPSHIP_EBAY_MANAGED_LOCATION_CONFIG_MISMATCH") return RUN_NOTICE_SHIP_FROM_REASON;
      return "It couldn't be sent.";
  }
}

/** The email's reason for a size the warehouse move failed; the same words as step 3's row and step (PUBLISH_WORDS). */
export const RUN_NOTICE_SHIP_FROM_REASON =
  "Card Shellz changed the warehouse your listings ship from. In Listing settings, choose Update now under Shipping policy, then publish again.";

function noticeProblemName(problem: ListingPushRunNoticeProblem): string {
  const name = [problem.productName, problem.variantName, problem.sku]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "").join(" · ")
    || `Variant ${problem.productVariantId}`;
  return name.length > RUN_NOTICE_NAME_MAX_CHARS ? `${name.slice(0, RUN_NOTICE_NAME_MAX_CHARS - 1)}…` : name;
}

/**
 * The run's one email (§4.5): how many did not publish out of how many, to
 * which store, why the run stopped when it stopped early, and the first
 * problem sizes with their reasons, one per line (review DUX1: the sizes were
 * only in the payload, which neither the email nor the portal shows). Rows
 * that would pass the message budget are counted instead.
 */
export function describeListingPushRunProblems(input: {
  problemCount: number;
  targetCount: number;
  stopReason: "vendor_stop" | "provider_unavailable" | null;
  /** The store's name on eBay; null names it "your eBay store". */
  storeName?: string | null;
  problems?: readonly ListingPushRunNoticeProblem[];
}): string {
  const store = input.storeName?.trim() ? input.storeName.trim() : "your eBay store";
  const lead = `${input.problemCount.toLocaleString("en-US")} of ${input.targetCount.toLocaleString("en-US")} `
    + `listing${input.targetCount === 1 ? "" : "s"} didn't publish to ${store}.`;
  const stopped = input.stopReason === "provider_unavailable"
    ? " eBay wasn't answering, so publishing stopped. Publish again later."
    : input.stopReason === "vendor_stop" ? " You stopped publishing." : "";
  let message = `${lead}${stopped} Catalog step 3 shows each one and why.`;
  const problems = input.problems ?? [];
  let shown = 0;
  for (const problem of problems) {
    const row = `\n${noticeProblemName(problem)}: ${runNoticeProblemReason(problem)}`;
    // Room is kept for the "and n more" line.
    if (message.length + row.length > RUN_NOTICE_MESSAGE_MAX_CHARS - 60) break;
    message += row;
    shown += 1;
  }
  const more = input.problemCount - shown;
  if (shown > 0 && more > 0) message += `\nAnd ${more.toLocaleString("en-US")} more in Catalog step 3.`;
  return message;
}
