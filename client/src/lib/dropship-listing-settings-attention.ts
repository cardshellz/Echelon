import type {
  ListingSettingsAttentionCode,
  ListingSettingsPolicyKind,
  ListingSettingsSummary,
} from "@shared/dropship/listing-settings";
import { LISTING_SETTINGS_SEND_TIMING } from "./dropship-catalog-steps";
import { listingAccessLink, type ListingAccessLink } from "./dropship-listing-access";
import type { ListingSettingsReadState } from "./dropship-listing-settings-access";

/**
 * The words at the top of the Listing settings step (Listing settings PR 7,
 * sub-part 2F): the header and its "When is that?" popover, the "Needs your
 * attention" strip, and the "Older settings" section around today's panels.
 *
 * Words come from the design record (R:87-89, R:111-114, R:508, R:565-570)
 * unless marked interim. Interim words live here only, so a later PR can
 * change them in one place. The strip is built from `summary.attention` only,
 * in the server's order (C4): it never re-sorts and never adds a line from
 * another read. Pure: no React, no network, no clock.
 */

/** The store's name in a sentence; a blank name reads "your eBay store". */
function storeName(name: string): string {
  const trimmed = name.trim();
  return trimmed || "your eBay store";
}

// ---------------------------------------------------------------------------
// Header (R:87, R:111-114; phone R:420-426)
// ---------------------------------------------------------------------------

export const LISTING_SETTINGS_HEADER_WORDS = Object.freeze({
  /** The phone title, and the title when the store has no name. */
  shortTitle: "Listing settings",
  // Interim: R:112 without "Change a category or a product", which comes with PRs 8-10.
  intro: "Set your store defaults once. Give any size an exact price in Products.",
  timing: LISTING_SETTINGS_SEND_TIMING,
  /** The phone's shorter timing line (R:424-425). */
  timingPhone: "Saved settings go to eBay the next time a listing is sent.",
  whenIsThat: "When is that?",
});

/** "Listing settings for MyShop" (R:111); the phone shows "Listing settings" (R:420). */
export function listingSettingsTitle(store: string, compact: boolean): string {
  const trimmed = store.trim();
  return compact || trimmed === "" ? LISTING_SETTINGS_HEADER_WORDS.shortTitle : `Listing settings for ${trimmed}`;
}

/**
 * The "When is that?" popover (R:565-570). The cost-change sentences are left
 * out: they come with the cost-policy fields, which PR 7 does not read (S2
 * dropped). A vendor with more than one eBay store is told these settings are
 * for this store only.
 */
export function sendTimingLines(store: string, ebayStoreCount: number): string[] {
  const lines = [
    "A listing goes to eBay when you publish it in step 3.",
    "Card Shellz also re-sends your live listings to keep their stock right.",
    "Each time, your settings are used as they are at that moment.",
  ];
  // A count that is not a whole number is treated as one store: the line is left out.
  if (Number.isSafeInteger(ebayStoreCount) && ebayStoreCount > 1) {
    const name = store.trim() || "this store";
    lines.push(`These settings are for ${name} only. Each store has its own.`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// "Needs your attention" (R:89, plan 2F)
// ---------------------------------------------------------------------------

export const ATTENTION_STRIP_WORDS = Object.freeze({
  title: "Needs your attention",
  empty: "✓ Nothing here needs you. Step 3 checks the rest, like stock, photos and your wallet.",
  loading: "Checking your products…",
  // Interim: the record has no words for a summary that failed to load.
  failed: "Couldn't check your products.",
  tryAgain: "Try again",
  seeAll: "See all",
});

/** What a line's one button does. The step carries it out. */
export type AttentionAction =
  /** Opens a Store defaults row's editor (R:508: [Choose] opens the first missing policy). */
  | { kind: "open_store_default"; label: string; field: ListingSettingsPolicyKind }
  /** Shows the Products tab filtered to "Needs a fix". */
  | { kind: "show_products"; label: string; show: "needs_fix" }
  /** Opens the product drawer; `fix` says which problem to open it on (a size that can't be priced opens on that size). */
  | { kind: "open_product"; label: string; productId: number; fix: ListingSettingsAttentionCode }
  /** Leaves for another portal page. */
  | { kind: "link"; link: ListingAccessLink };

export interface AttentionLine {
  /** Stable among the lines shown: the code, and the product for a product line. */
  key: string;
  code: ListingSettingsAttentionCode;
  text: string;
  action: AttentionAction;
}

export interface AttentionMore {
  /** How many lines the summary holds beyond those it sent. */
  count: number;
  text: string;
  action: AttentionAction;
}

export type AttentionStripContent =
  | { state: "loading"; text: string }
  | { state: "failed"; text: string; retryLabel: string }
  /** Nothing was checked (more than 10,000 sizes): the banner says why, so the strip shows nothing. */
  | { state: "not_checked" }
  | { state: "empty"; text: string }
  | { state: "lines"; lines: AttentionLine[]; more: AttentionMore | null };

export interface AttentionOptions {
  /** A connection banner is shown; it already says to reconnect eBay. */
  bannerShown: boolean;
  storeName: string;
}

const POLICY_WORDS: Readonly<Record<ListingSettingsPolicyKind, string>> = { shipping: "shipping", return: "return", payment: "payment" };
/** R:508: [Choose] opens Shipping policy when the summary doesn't name the first missing one. */
const FIRST_POLICY: ListingSettingsPolicyKind = "shipping";
// Interim: a product line whose product has no name in the answer.
const UNNAMED_PRODUCT = "A product";

const SHOW_NEEDS_FIX = (label: string): AttentionAction => ({ kind: "show_products", label, show: "needs_fix" });

function reconnectLink(): ListingAccessLink {
  const link = listingAccessLink("reconnect_store");
  if (!link) throw new Error("The listing access link for reconnect_store is missing.");
  // The store connection page is where a vendor signs in to eBay again (C7).
  return { ...link, label: "Reconnect eBay" };
}

function productName(name: string | null): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : UNNAMED_PRODUCT;
}

type AttentionItem = ListingSettingsSummary["attention"]["items"][number];

/** One line's words and button, or null for a line the strip leaves out. */
function attentionLine(
  item: AttentionItem,
  summary: Pick<ListingSettingsSummary, "rail">,
  options: AttentionOptions,
): AttentionLine | null {
  const key = item.productId === null ? item.code : `${item.code}:${item.productId}`;
  const product = productName(item.productName);
  // A product line without its product can't open the drawer, so it shows the products that need a fix.
  const fix = (code: ListingSettingsAttentionCode): AttentionAction => item.productId === null
    ? SHOW_NEEDS_FIX("Fix")
    : { kind: "open_product", label: "Fix", productId: item.productId, fix: code };
  switch (item.code) {
    case "reconnect_store":
      // The banner says the same while it shows (the summary adds this line for every store status but connected).
      if (options.bannerShown) return null;
      // Interim.
      return { key, code: item.code, text: `Reconnect eBay for ${storeName(options.storeName)}.`, action: { kind: "link", link: reconnectLink() } };
    case "choose_store_policies": {
      const missing = summary.rail.missingPolicy;
      // Interim: with one policy missing, the line names it.
      const text = item.count === 1 && missing !== null
        ? `Choose your ${POLICY_WORDS[missing]} policy. Nothing can be listed until you do.`
        : "Choose your shipping, return and payment policies. Nothing can be listed until you do.";
      return { key, code: item.code, text, action: { kind: "open_store_default", label: "Choose", field: missing ?? FIRST_POLICY } };
    }
    case "own_text_needs_check": {
      const text = item.count === 1
        ? "Card Shellz updated 1 product that has your own text. Check that it still fits."
        : `Card Shellz updated ${item.count} products that have your own text. Check that it still fits.`;
      // Interim button: the review sheet comes with PR 10.
      return { key, code: item.code, text, action: SHOW_NEEDS_FIX("Show products") };
    }
    case "no_ebay_category":
      return { key, code: item.code, text: `${product} can't be listed: it has no eBay category.`, action: fix(item.code) };
    case "size_cannot_be_priced":
      // Interim button.
      return { key, code: item.code, text: `${product} can't be listed: a size can't be priced.`, action: fix(item.code) };
    case "description_group_conflict":
      // Interim words and button.
      return { key, code: item.code, text: `${product}: two older description rules tie, so neither's text is used.`, action: fix(item.code) };
  }
}

/**
 * The strip's lines (R:89), in the server's order (`summary.attention`,
 * C4), and "And N more." when the summary holds more than it sent.
 * `reconnect_store` is left out only while a banner shows; with no banner
 * (a store whose sign-in refresh failed has none) the line stays.
 */
export function attentionLines(
  summary: Pick<ListingSettingsSummary, "attention" | "rail">,
  options: AttentionOptions,
): { lines: AttentionLine[]; more: AttentionMore | null } {
  const lines: AttentionLine[] = [];
  for (const item of summary.attention.items) {
    const line = attentionLine(item, summary, options);
    if (line !== null) lines.push(line);
  }
  // The lines left out are always at the end (the server sends the first few), so a dropped line never changes this count.
  const hidden = summary.attention.total - summary.attention.items.length;
  const more = hidden > 0 ? { count: hidden, text: `And ${hidden} more.`, action: SHOW_NEEDS_FIX(ATTENTION_STRIP_WORDS.seeAll) } : null;
  return { lines, more };
}

/**
 * What the strip shows for the summary read. The latest attempt wins: when a
 * refetch failed, the older answer it replaced is not shown as current.
 */
export function attentionStripContent(
  read: ListingSettingsReadState<Pick<ListingSettingsSummary, "attention" | "rail" | "catalog">>,
  options: AttentionOptions,
): AttentionStripContent {
  if (read.error !== undefined && read.error !== null) {
    return { state: "failed", text: ATTENTION_STRIP_WORDS.failed, retryLabel: ATTENTION_STRIP_WORDS.tryAgain };
  }
  const summary = read.data;
  if (summary === undefined) return { state: "loading", text: ATTENTION_STRIP_WORDS.loading };
  // More than 10,000 sizes: nothing was checked, so "Nothing here needs you" would not be true.
  if (summary.catalog.state === "too_large") return { state: "not_checked" };
  const { lines, more } = attentionLines(summary, options);
  if (lines.length === 0 && more === null) return { state: "empty", text: ATTENTION_STRIP_WORDS.empty };
  return { state: "lines", lines, more };
}

// ---------------------------------------------------------------------------
// "Older settings" (plan 2F; A1)
// ---------------------------------------------------------------------------

export const OLDER_SETTINGS_WORDS = Object.freeze({
  title: "Older settings",
  // Interim.
  intro: "Per-size policies and shelves, group rules and text templates. They still work.",
  show: "Show older settings",
  hide: "Hide older settings",
});
