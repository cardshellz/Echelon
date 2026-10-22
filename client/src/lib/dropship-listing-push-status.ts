import { z } from "zod";
import { formatListingPreviewIssue } from "./dropship-listing-preview";
import {
  EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE,
  EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_MESSAGE,
  EBAY_PUBLICATION_ENVIRONMENT_MISMATCH_MESSAGE,
} from "@shared/dropship/ebay-publication-account";
import {
  DROPSHIP_STOCK_LINK_MANUAL_RETRY_NEXT_STEPS,
  DROPSHIP_STOCK_LINK_REFUSAL_WORDS,
} from "@shared/dropship/stock-link-refusals";

/**
 * What became of a push the vendor queued, read from
 * GET /api/dropship/listing-push-jobs/:jobId and put into the vendor's words.
 */

/**
 * A row queued while its preview was blocked: the server stores its blocker
 * codes as one comma-separated list in `error_message`
 * (dropship-listing-preview.repository, insertJobItemForPreview), so the
 * vendor would read raw codes. Each code gets step 3's words instead.
 */
const PREVIEW_BLOCKED_CODE = "DROPSHIP_LISTING_PREVIEW_BLOCKED";

/** The blocker codes of a blocked item, each in the vendor's words, once; empty when the list is blank. */
export function listingPushBlockedReasons(errorMessage: string | null): string[] {
  const codes = (errorMessage ?? "").split(",").map((code) => code.trim()).filter((code) => code.length > 0);
  return [...new Set(codes.map(formatListingPreviewIssue))];
}

const positiveInteger = z.number().int().positive();

const listingPushItemSchema = z.object({
  itemId: positiveInteger,
  listingId: positiveInteger.nullable(),
  productVariantId: positiveInteger,
  sku: z.string().nullable(),
  productName: z.string(),
  variantName: z.string(),
  status: z.string().min(1),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retryable: z.boolean().nullable(),
  externalListingId: z.string().nullable(),
  /** false: the store saved a draft that buyers cannot see; null: the push did not say. */
  published: z.boolean().nullable(),
  // Rendered as a link: only an https page is ever accepted.
  listingUrl: z.string().url().regex(/^https:\/\//).nullable(),
  /**
   * True only when the push sweep will queue this failed item again by itself
   * (review V2-2). Optional: a server without it, or a false value, means no
   * automatic retry is promised, so the words never claim one that is not coming.
   */
  automaticRetryPending: z.boolean().optional(),
}).strict();

const listingPushJobSchema = z.object({
  jobId: positiveInteger,
  storeConnectionId: positiveInteger,
  platform: z.string().min(1),
  /** eBay's sandbox is a test site: a listing there is not on the real eBay. */
  environment: z.enum(["sandbox", "production"]).nullable(),
  status: z.string().min(1),
  finished: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  items: z.array(listingPushItemSchema),
}).strict();

export type DropshipListingPushItem = z.infer<typeof listingPushItemSchema>;
export type DropshipListingPushJob = z.infer<typeof listingPushJobSchema>;

export function listingPushJobUrl(jobId: number): string {
  if (!positiveInteger.safeParse(jobId).success) throw new Error("The listing push id is invalid.");
  return `/api/dropship/listing-push-jobs/${jobId}`;
}

export function parseDropshipListingPushJob(value: unknown): DropshipListingPushJob {
  const result = z.object({ job: listingPushJobSchema }).strict().safeParse(value);
  if (!result.success) throw new Error("The listing push status response was invalid. Refresh the page to see the result.");
  return result.data.job;
}

/** The page asks every few seconds; after this many answers (about five minutes) it stops and says where else to look. */
export const LISTING_PUSH_POLL_INTERVAL_MS = 3_000;
export const LISTING_PUSH_MAX_POLLS = 100;

/** Whether the page should ask again: the job is unfinished (or not yet read) and the answer limit is not reached. */
export function listingPushPollingContinues(job: DropshipListingPushJob | undefined, answers: number): boolean {
  if (job?.finished) return false;
  return answers < LISTING_PUSH_MAX_POLLS;
}

/** Whether the page stopped asking with the job still unfinished: the answer limit was reached first. */
export function listingPushPollingGaveUp(job: DropshipListingPushJob | undefined, answers: number): boolean {
  if (job === undefined || job.finished) return false;
  return answers >= LISTING_PUSH_MAX_POLLS;
}

export type ListingPushOutcomeTone = "pending" | "success" | "partial" | "failed";

export interface ListingPushItemOutcome {
  itemId: number;
  /** "Armalope Envelope Single Pocket · Pack of 50 · ARM-ENV-SGL-P50" */
  name: string;
  state: "pending" | "live" | "draft" | "failed";
  /** One sentence in the vendor's words. */
  line: string;
  /** The step to take, for a failed item or a draft. */
  nextStep: string | null;
  listingUrl: string | null;
  /** The words on the link, when there is one. */
  listingUrlLabel: string | null;
}

export interface ListingPushOutcome {
  tone: ListingPushOutcomeTone;
  title: string;
  items: ListingPushItemOutcome[];
}

const LIVE_ITEM_STATUSES = new Set(["completed"]);
const FAILED_ITEM_STATUSES = new Set(["failed", "blocked", "cancelled"]);

/** The store's name as the vendor sees it: eBay is a public marketplace, the rest are "your store". */
export function listingPushStoreLabel(platform: string, storeName: string | null): string {
  if (storeName && storeName.trim()) return storeName.trim();
  return platform === "ebay" ? "eBay" : "your store";
}

const SANDBOX_NOTE = "This is eBay's sandbox test site, not the real eBay.";

export function describeListingPushOutcome(job: DropshipListingPushJob, storeName: string | null): ListingPushOutcome {
  const store = listingPushStoreLabel(job.platform, storeName);
  const sandbox = job.environment === "sandbox";
  const linkLabel = job.platform === "ebay" ? (sandbox ? "View on eBay sandbox" : "View on eBay") : "View listing";
  const items = job.items.map((item): ListingPushItemOutcome => {
    const name = [item.productName, item.variantName, item.sku].filter((part) => part && part.trim()).join(" · ");
    const base = { itemId: item.itemId, name, listingUrl: null, listingUrlLabel: null };
    if (LIVE_ITEM_STATUSES.has(item.status) && item.published === false) {
      return {
        ...base, state: "draft", line: `Saved on ${store} as an unpublished draft. Buyers cannot see it yet.`,
        nextStep: "Your store is set to save drafts instead of publishing. Ask support to switch your store to live listings, then queue it again.",
      };
    }
    if (LIVE_ITEM_STATUSES.has(item.status)) {
      return {
        ...base, state: "live", line: sandbox ? `Live on ${store} (eBay sandbox).` : `Live on ${store}.`, nextStep: null,
        listingUrl: item.listingUrl, listingUrlLabel: item.listingUrl ? linkLabel : null,
      };
    }
    if (FAILED_ITEM_STATUSES.has(item.status)) {
      const gate = listingPushRefusalWords(item, storeName);
      const blocked = item.errorCode === PREVIEW_BLOCKED_CODE ? listingPushBlockedReasons(item.errorMessage) : [];
      const reason = gate?.reason ?? (blocked.length > 0 ? blocked.join(" ") : (item.errorMessage?.trim() || "the store did not say why"));
      return { ...base, state: "failed", line: `Could not list: ${reason}`, nextStep: gate?.nextStep ?? listingPushNextStep(item.errorCode, item.retryable) };
    }
    return { ...base, state: "pending", line: `Sending to ${store}…`, nextStep: null };
  });
  const total = items.length;
  const count = (state: ListingPushItemOutcome["state"]) => items.filter((item) => item.state === state).length;
  const live = count("live");
  const draft = count("draft");
  const failed = count("failed");
  const noun = (n: number) => `${n} listing${n === 1 ? "" : "s"}`;
  if (!job.finished) {
    const pending = total - live - draft - failed;
    const title = pending > 0
      ? `Sending ${noun(pending)} to ${store}. This usually takes under a minute; the result shows here.`
      : `Finishing up at ${store}…`;
    return { tone: "pending", title, items };
  }
  if (total > 0 && live === total) {
    return { tone: "success", title: `Live on ${store}: ${noun(live)}.${sandbox ? ` ${SANDBOX_NOTE}` : ""}`, items };
  }
  if (total > 0 && draft === total) {
    return { tone: "partial", title: `Saved on ${store} as unpublished drafts: ${noun(draft)}. Buyers cannot see them yet.`, items };
  }
  if (live === 0 && draft === 0) {
    return { tone: "failed", title: `Could not list ${noun(total)} on ${store}.`, items };
  }
  const parts = [
    live > 0 ? `${live} live` : null,
    draft > 0 ? `${draft} saved as ${draft === 1 ? "a draft" : "drafts"}` : null,
    failed > 0 ? `${failed} could not be listed` : null,
  ].filter((part): part is string => part !== null);
  return { tone: "partial", title: `Of ${noun(total)} on ${store}: ${parts.join(", ")}.${sandbox ? ` ${SANDBOX_NOTE}` : ""}`, items };
}

/**
 * The step to take after a refusal. The reason itself comes from the store
 * (already in the item's line); this says what to do about it.
 */
interface RefusalWords { reason: string; nextStep: string }

/** Stock work that was running clears by itself. */
const BUSY_STOCK_WORDS: RefusalWords = Object.freeze({
  reason: "Card Shellz was busy updating stock for this listing.",
  nextStep: "Queue the listing again in a few minutes.",
});

/** Card Shellz paused stock updates for a while. */
const PAUSED_STOCK_WORDS: RefusalWords = Object.freeze({
  reason: "Card Shellz has paused stock updates for now.",
  nextStep: "Queue the listing again later. Contact support with this message if it keeps failing.",
});

/** A stock-gate refusal raised after eBay was asked to change the quantity: it may already show the new stock. */
const UNCONFIRMED_STOCK_WORDS: RefusalWords = Object.freeze({
  reason: "Card Shellz could not confirm the stock update for this listing. eBay may already show the new quantity.",
  nextStep: "Queue the listing again in a few minutes. Contact support with this message if it keeps failing.",
});

/**
 * Refusals from Card Shellz's own stock gate. Most come before the quantity
 * request; the "could not confirm" ones come after eBay answered it
 * (inventory-planning quantity-publication-request assertBulkSuccess, the
 * admission's completion and connection cleanup). Their server messages are
 * written for operators; the vendor gets what happened and the step in plain
 * words. Whether a code is retried is the server's
 * (dropship-listing-push-worker-service classifyStockGateRefusal); these words
 * say the same thing.
 */
const STOCK_GATE_REFUSALS: Record<string, RefusalWords> = {
  PUBLICATION_PRIOR_OUTCOME_UNRESOLVED: {
    reason: "an earlier stock update for this listing on eBay still has to be confirmed by Card Shellz.",
    nextStep: "Nothing to fix on your side. Contact support with this message; once they confirm that earlier update, queue the listing again.",
  },
  PUBLICATION_PROVIDER_COOLDOWN: {
    reason: "eBay asked for a pause after the last attempt.",
    nextStep: "Queue the listing again in a few minutes.",
  },
  // Permanent: no stock mapping for this listing yet. Card Shellz sets it up; queueing again cannot help until then.
  // Kept as PR 1b wrote it (review TW-2): only failures from before the automatic stock link
  // existed are re-sent by themselves (owner Q4), once, and a re-sent item leaves this state;
  // "queue the listing again" stays true for every item still showing these words.
  PUBLICATION_LISTING_TARGET_UNMAPPED: {
    reason: "Card Shellz has not finished setting up stock updates for this listing yet.",
    nextStep: "Nothing to fix on your side. Contact support with this message; once stock updates are set up, queue the listing again.",
  },
  // Permanent: Card Shellz's current stock plan leaves this listing out. Nothing re-runs it, so the vendor queues it again after the fix.
  PUBLICATION_LISTING_PLAN_OMITTED: {
    reason: "Card Shellz's stock plan does not include this listing right now.",
    nextStep: "Nothing to fix on your side. Contact support with this message; once they fix it, queue the listing again.",
  },
  // Transient: another stock update or Card Shellz's own stock work was running; it clears by itself.
  // PUBLICATION_SCOPE_BUSY alone is re-queued by the push sweep by itself (server domain
  // listing-push-automatic-requeue AUTOMATIC_REQUEUE_POLICY, plan F2 2.10), so its step says
  // the retry is automatic while the server says one is pending (AUTOMATIC_RETRY_WORDS below);
  // the other busy codes are not, and keep BUSY_STOCK_WORDS.
  PUBLICATION_SCOPE_BUSY: BUSY_STOCK_WORDS,
  QUANTITY_PUBLICATION_DRAIN_BUSY: BUSY_STOCK_WORDS,
  PUBLICATION_ADMISSION_CAPACITY_BUSY: BUSY_STOCK_WORDS,
  PUBLICATION_AUTHORITY_CHANGED: BUSY_STOCK_WORDS,
  PUBLICATION_CANONICAL_LISTING_PLAN_CHANGED: BUSY_STOCK_WORDS,
  QUANTITY_PUBLICATION_SUPPRESSED: PAUSED_STOCK_WORDS,
  PUBLICATION_GLOBAL_STOP_ACTIVE: PAUSED_STOCK_WORDS,
  // Transient, raised after eBay answered the quantity request.
  PUBLICATION_LISTING_MEMBERSHIP_UNPROVEN: UNCONFIRMED_STOCK_WORDS,
  PUBLICATION_COMPLETION_CONFLICT: UNCONFIRMED_STOCK_WORDS,
  PUBLICATION_CONNECTION_CLEANUP_UNCERTAIN: UNCONFIRMED_STOCK_WORDS,
  // The automatic stock link's refusals (Fix PR 2a-2), raised before any eBay
  // offer, inventory-item or quantity write. One source with the server's
  // messages (shared/dropship/stock-link-refusals); the two transient ones say
  // the retry is automatic only while the server says one is pending for the
  // item (AUTOMATIC_RETRY_WORDS below, review V2-2).
  ...DROPSHIP_STOCK_LINK_REFUSAL_WORDS,
};

/**
 * Codes the push sweep re-queues by itself: their "Nothing to do: Card Shellz will
 * try this listing again automatically" step is shown only while the server says an
 * automatic retry is pending for the item (`automaticRetryPending`, review V2-2).
 * Otherwise (its automatic re-queues are over, the sweep's guards exclude it, or an
 * older server did not say) the vendor gets the manual step of STOCK_GATE_REFUSALS.
 */
const AUTOMATIC_RETRY_WORDS: Readonly<Record<string, { manual: string; automatic: string }>> = Object.freeze({
  PUBLICATION_SCOPE_BUSY: {
    manual: BUSY_STOCK_WORDS.nextStep,
    automatic: DROPSHIP_STOCK_LINK_REFUSAL_WORDS.DROPSHIP_STOCK_LINK_BUSY.nextStep,
  },
  DROPSHIP_STOCK_LINK_BUSY: {
    manual: DROPSHIP_STOCK_LINK_MANUAL_RETRY_NEXT_STEPS.DROPSHIP_STOCK_LINK_BUSY,
    automatic: DROPSHIP_STOCK_LINK_REFUSAL_WORDS.DROPSHIP_STOCK_LINK_BUSY.nextStep,
  },
  DROPSHIP_STOCK_UPDATES_PAUSED: {
    manual: DROPSHIP_STOCK_LINK_MANUAL_RETRY_NEXT_STEPS.DROPSHIP_STOCK_UPDATES_PAUSED,
    automatic: DROPSHIP_STOCK_LINK_REFUSAL_WORDS.DROPSHIP_STOCK_UPDATES_PAUSED.nextStep,
  },
});

/**
 * True for a refusal worded as Card Shellz having paused stock updates (PAUSED_STOCK_WORDS): the vendor tries again
 * later, not in a few minutes, though the server retries these. The publish run card reads it for its own step.
 */
export function isPausedStockRefusal(code: string | null): boolean {
  return code !== null && STOCK_GATE_REFUSALS[code] === PAUSED_STOCK_WORDS;
}

/** Stock-gate codes not named above: the server message is operator text, so the vendor gets general words. */
const STOCK_GATE_CODE_PREFIXES = ["PUBLICATION_", "QUANTITY_PUBLICATION_"] as const;

/**
 * The account refusal's words, true whether or not the store is verified now:
 * before part 1 the account check refused every store with this message,
 * verified or not (items the recovery leaves failed still show it, from
 * listing-intent receipts too); after it, the message means the store had no
 * verified eBay identity, which reconnecting fixes. So the vendor queues it
 * again first and reconnects only if it fails the same way. The Settings
 * button reads "Reconnect <store name>" (DropshipPortalSettings
 * reauthorizeButtonLabel, intent refresh_connection); without a store name of
 * its own it reads a placeholder, so these words then name the button.
 */
function unverifiedAccountWords(storeName: string | null): RefusalWords {
  const name = storeName?.trim();
  return name
    ? { reason: `Card Shellz could not confirm ${name}'s eBay account for this listing.`,
      nextStep: `Queue the listing again. If it fails the same way, choose Reconnect ${name} in Settings first, then queue it again.` }
    : { reason: "Card Shellz could not confirm this store's eBay account for this listing.",
      nextStep: "Queue the listing again. If it fails the same way, choose the store's Reconnect button in Settings first, then queue it again." };
}

/**
 * Plain words for a refusal whose server message is not written for vendors,
 * or undefined when the server's own message is the reason to show.
 */
export function listingPushRefusalWords(
  item: Pick<DropshipListingPushItem, "errorCode" | "errorMessage" | "retryable" | "automaticRetryPending">,
  storeName: string | null,
): RefusalWords | undefined {
  const code = item.errorCode;
  if (!code) return undefined;
  if (code === EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE || code === "PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED") {
    if (code === EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE && item.errorMessage?.trim() === EBAY_PUBLICATION_ENVIRONMENT_MISMATCH_MESSAGE) {
      return {
        reason: "the listing already on eBay belongs to a different eBay site (the sandbox test site or the real eBay) than this store's connection.",
        nextStep: "Queueing it again will not help. Contact support with this message.",
      };
    }
    if (code === "PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED"
      || item.errorMessage?.trim() === EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_MESSAGE) {
      return unverifiedAccountWords(storeName);
    }
    return undefined;
  }
  const known = STOCK_GATE_REFUSALS[code];
  const retryWords = AUTOMATIC_RETRY_WORDS[code];
  if (known && retryWords) {
    return { reason: known.reason, nextStep: item.automaticRetryPending === true ? retryWords.automatic : retryWords.manual };
  }
  if (known) return known;
  if (STOCK_GATE_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) {
    // No claim about when it stopped: some stock-gate codes are raised after eBay was asked to change the quantity.
    return {
      reason: "Card Shellz's stock check stopped this listing update.",
      nextStep: item.retryable === false
        ? "Nothing to fix on your side. Contact support with this message."
        : "Queue the listing again in a few minutes. Contact support with this message if it keeps failing.",
    };
  }
  return undefined;
}

export function listingPushNextStep(errorCode: string | null, retryable: boolean | null): string {
  switch (errorCode) {
    case "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR":
    case "DROPSHIP_SHOPIFY_LISTING_PUSH_HTTP_ERROR":
      return retryable
        ? "This was a temporary problem at the store. Queue the listing again in a few minutes."
        : "Fix what the store named, then queue the listing again.";
    case "DROPSHIP_LISTING_PRICE_AWAITING_REVIEW":
      return "Its price moved after it was queued. Check the price on this page, then queue the listing again.";
    case "DROPSHIP_LISTING_PREVIEW_DRIFT":
      return "The listing changed while it was queued. Queue it again.";
    case PREVIEW_BLOCKED_CODE:
      // Interim (PR 10 PROPOSAL): the reasons above name where each fix is (Listing settings, step 1, or support).
      return "Fix what's named above, then preview the listing again and queue it.";
    case "DROPSHIP_EBAY_MANAGED_LOCATION_CONFIG_MISMATCH":
      // Interim (PR 12 PROPOSAL): the step's [Update now] under the Shipping policy row (ShipFromRepairNote); the
      // "Update ship-from location" button went with the old setup panel (verify VC1).
      return "Card Shellz changed the warehouse your listings ship from. In Listing settings, choose Update now under Shipping policy, then queue the listing again.";
    case "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED":
    case "DROPSHIP_LISTING_STORE_BLOCKED":
    case "DROPSHIP_LISTING_VENDOR_BLOCKED":
      return "Your account or store cannot list right now. See the notice at the top of this card.";
    default:
      return retryable
        ? "Queue the listing again in a few minutes. Contact support with this message if it keeps failing."
        : "Fix the reason above and queue the listing again, or contact support with this message.";
  }
}
