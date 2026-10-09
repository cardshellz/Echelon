import {
  LISTING_SETTINGS_FIELDS,
  type ListingSettingsDescriptionTemplateValue,
  type ListingSettingsEbayCategoryValue,
  type ListingSettingsField,
  type ListingSettingsFixCode,
  type ListingSettingsMainTextValue,
  type ListingSettingsPolicyKind,
  type ListingSettingsPolicyValue,
  type ListingSettingsProductRow,
  type ListingSettingsSettingKey,
  type ListingSettingsStoreShelfValue,
  type ListingSettingsValueSource,
} from "@shared/dropship/listing-settings";
import { MAX_NAMED_CATALOG_GROUP_ITEMS } from "@shared/dropship/catalog-scope";
import type { ConnectionBanner, ListingSettingsReadState, ListingSettingsRightReason } from "./dropship-listing-settings-access";
import { LISTING_SETUP_RELOAD_MESSAGE } from "./dropship-ebay-listing-setup";
import { listingAccessLink, type ListingAccessLink } from "./dropship-listing-access";
import type {
  DropshipEbayFulfillmentCapability,
  DropshipEbayFulfillmentPolicyOption,
  DropshipEbayListingSetupResponse,
  DropshipEbayStoreCategoryOption,
} from "./dropship-ops-surface";

/**
 * The vendor's words for the Listing settings step outside prices (Listing
 * settings PR 7, sub-part 1C): the connection banner, why a row can't be
 * changed, the store default values, the shipping policy checks, and the
 * product drawer's sources and statuses. Price words live in
 * dropship-listing-settings-price-words.ts.
 *
 * Words come from the design record (Listing settings redesign, R:497-597)
 * unless marked interim. Interim words live here only, so a later PR can
 * change them in one place. No function returns a raw code, an id or a
 * category number (C10). Pure: no React, no network, no clock.
 */

/** Beside a value that needs the live eBay read, while it loads (R:497). */
export const CHECKING_EBAY = "Checking eBay…";
/** A store policy that isn't chosen yet (R:579). */
export const NOT_SET_NEEDED_TO_LIST = "Not set · Needed to list";
/** A saved store policy whose name can't be read because eBay can't be read (A4: names come only from the live read). */
export const POLICY_SET_UNNAMED = "Set";
/** Beside a shipping policy that fits (R:124). */
export const WORKS_WITH_CARD_SHELLZ_SHIPPING = "✓ Works with Card Shellz shipping";

/** The store's name in a sentence; a blank name reads "your eBay store". */
function storeName(name: string): string {
  const trimmed = name.trim();
  return trimmed || "your eBay store";
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// The connection banner (plan 4.4)
// ---------------------------------------------------------------------------

export type ConnectionBannerAction =
  | { kind: "link"; link: ListingAccessLink }
  /** Read the eBay setup and shelves again. */
  | { kind: "retry"; label: string }
  /** Go to step 1 (Choose what to sell). */
  | { kind: "go_to_step_1"; label: string };

export interface ConnectionBannerWords {
  message: string;
  action: ConnectionBannerAction;
}

function requiredLink(resolution: Parameters<typeof listingAccessLink>[0]): ListingAccessLink {
  const link = listingAccessLink(resolution);
  if (!link) throw new Error(`The listing access link for ${resolution} is missing.`);
  return link;
}

const SUPPORT: ConnectionBannerAction = { kind: "link", link: requiredLink("contact_support") };
const STORE_CONNECTION: ConnectionBannerAction = { kind: "link", link: requiredLink("reconnect_store") };
const WALLET: ConnectionBannerAction = { kind: "link", link: requiredLink("resolve_pause") };
// The store connection page is where a vendor signs in to eBay again (C7).
const RECONNECT_EBAY: ConnectionBannerAction = { kind: "link", link: { ...requiredLink("reconnect_store"), label: "Reconnect eBay" } };
const TRY_AGAIN: ConnectionBannerAction = { kind: "retry", label: "Try again" };
const GO_TO_STEP_1: ConnectionBannerAction = { kind: "go_to_step_1", label: "Go to step 1" };

const SIZE_LIMIT = MAX_NAMED_CATALOG_GROUP_ITEMS.toLocaleString("en-US");

/** The banner's words and its one button (plan 4.4; R:500-507, R:521). */
export function connectionBannerWords(banner: ConnectionBanner, store: string): ConnectionBannerWords {
  const name = storeName(store);
  switch (banner.kind) {
    case "account_inactive":
      return { message: "Your dropship account isn't active, so listing settings can't be changed. Contact support.", action: SUPPORT };
    case "store_paused":
      // Only Card Shellz pauses a store connection, so only support lifts it (shared/dropship/listing-access.ts).
      return { message: `${capitalize(name)} is paused, so its settings can't be changed now.`, action: SUPPORT };
    case "store_disconnecting":
      return { message: `${capitalize(name)} is being disconnected, so its settings can't be changed now.`, action: STORE_CONNECTION };
    case "store_disconnected":
      return { message: `${capitalize(name)} is disconnected, so its settings can't be changed now.`, action: STORE_CONNECTION };
    case "too_large":
      return {
        message: `You've chosen more than ${SIZE_LIMIT} sizes. Settings can't be checked until you choose ${SIZE_LIMIT} or fewer.`,
        action: GO_TO_STEP_1,
      };
    case "other_site":
      return { message: `Card Shellz lists on eBay US only. ${capitalize(name)} is set up for another eBay site. Contact support.`, action: SUPPORT };
    case "selling_paused":
      // Interim (C5): the record has no words for a paused account on this step.
      return {
        message: "Selling is paused on your account. You can still change your policies and store shelf. "
          + "Prices, eBay categories and descriptions can't be changed until it resumes.",
        action: WALLET,
      };
    case "ops_inactive":
      // Interim: R:506 widened, since eBay categories and descriptions are refused too.
      return {
        message: "Your Shellz Club .ops access is inactive, so prices, eBay categories and descriptions can't be changed. Contact support.",
        action: SUPPORT,
      };
    case "sign_in":
      // Interim (C1): R:500 without the resets that come with PR 9.
      return {
        message: `eBay needs you to sign in again for ${name}. Your settings are safe. Until you do, you can still change prices and descriptions.`,
        action: RECONNECT_EBAY,
      };
    case "access_denied":
      return {
        message: banner.diagnosticReference
          ? `eBay won't let Card Shellz read ${name}. Signing in again won't fix this. Contact support and give this code: ${banner.diagnosticReference}.`
          : `eBay won't let Card Shellz read ${name}. Signing in again won't fix this. Contact support.`,
        action: SUPPORT,
      };
    case "unreachable":
      return { message: "Can't reach eBay right now. Your saved settings still apply.", action: TRY_AGAIN };
  }
}

// ---------------------------------------------------------------------------
// Why a row can't be changed (plan 4.3)
// ---------------------------------------------------------------------------

/** The line under a row that can't be changed, or null when the banner says why or nothing needs doing. */
export function rightReasonLine(reason: ListingSettingsRightReason): string | null {
  switch (reason) {
    case "loading":
      // Interim: the rail's word for a read still loading.
      return "Checking…";
    case "checking_ebay":
      return CHECKING_EBAY;
    case "banner":
    case "not_needed":
      return null;
    case "sign_in":
      return "Reconnect eBay to change this.";
    case "ebay_access_denied":
      // Interim: only shown while a wider banner hides the eBay access one.
      return "eBay won't let Card Shellz read this store. Contact support.";
    case "unreachable":
      return "Can't check eBay right now.";
    case "reload":
      return LISTING_SETUP_RELOAD_MESSAGE;
    case "shipping_setup":
      return "Card Shellz is finishing shipping setup for your store. You can pick a shipping policy when it's done.";
    case "shipping_unavailable":
      // Interim: the old panel's words without its button name.
      return "Can't check Card Shellz shipping right now. Try again in a few minutes.";
    case "save_policy_first":
      // Interim (C19).
      return "Save or cancel your policy change first.";
  }
}

// ---------------------------------------------------------------------------
// Store default values (R:577-583)
// ---------------------------------------------------------------------------

type PolicyField = "fulfillmentPolicyId" | "returnPolicyId" | "paymentPolicyId";

const POLICY_FIELD: Readonly<Record<ListingSettingsPolicyKind, PolicyField>> = {
  shipping: "fulfillmentPolicyId",
  return: "returnPolicyId",
  payment: "paymentPolicyId",
};
const POLICY_NAME_FIELD = {
  fulfillmentPolicyId: "fulfillmentPolicyName",
  returnPolicyId: "returnPolicyName",
  paymentPolicyId: "paymentPolicyName",
} as const;
const POLICY_OPTIONS = {
  fulfillmentPolicyId: "fulfillmentPolicies",
  returnPolicyId: "returnPolicies",
  paymentPolicyId: "paymentPolicies",
} as const;

export type PolicySetupFacts = Pick<DropshipEbayListingSetupResponse, "selection" | "storedNames" | "options" | "checks">;

function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Whether this answer carries eBay's live lists (a server from before the checks always read eBay). */
function ebayRead(setup: Pick<DropshipEbayListingSetupResponse, "checks">): boolean {
  return setup.checks === undefined || setup.checks.ebay === "checked";
}

/** A policy's name: eBay's live name when eBay was read, else the name stored at the last save. */
function policyName(setup: PolicySetupFacts, field: PolicyField, policyId: string): { name: string | null; onEbay: boolean | null } {
  const stored = setup.selection[field] === policyId ? nonBlank(setup.storedNames?.[POLICY_NAME_FIELD[field]]) : null;
  if (!ebayRead(setup)) return { name: stored, onEbay: null };
  const options: ReadonlyArray<{ id: string; name: string }> = setup.options[POLICY_OPTIONS[field]];
  const live = options.find((option) => option.id === policyId);
  return live ? { name: nonBlank(live.name) ?? stored, onEbay: true } : { name: stored, onEbay: false };
}

/**
 * A store policy row's value (R:579): the policy's name, "Not set · Needed to
 * list", "Checking eBay…" while the live read loads, or "Set" when it can't be
 * named. A4: names come only from the live setup read; the summary says only
 * whether a policy is saved.
 */
export function storeDefaultPolicyValue(input: {
  kind: ListingSettingsPolicyKind;
  /** The summary's saved policy id. */
  savedPolicyId: string | null;
  setup: ListingSettingsReadState<PolicySetupFacts>;
}): string {
  const field = POLICY_FIELD[input.kind];
  const failed = input.setup.error !== undefined && input.setup.error !== null;
  if (failed || input.setup.data === undefined) {
    if (input.savedPolicyId === null) return NOT_SET_NEEDED_TO_LIST;
    return failed ? POLICY_SET_UNNAMED : CHECKING_EBAY;
  }
  const setup = input.setup.data;
  const policyId = setup.selection[field];
  if (!policyId) return NOT_SET_NEEDED_TO_LIST;
  return policyName(setup, field, policyId).name ?? POLICY_SET_UNNAMED;
}

// Interim: an eBay category whose name was not resolved; the number is never shown.
const UNNAMED_EBAY_CATEGORY = "An eBay category";
// Interim: a saved shelf with no name stored and none on eBay.
const UNNAMED_SHELF = "A shelf";

/** The eBay category store default (R:580). Names and paths only, never the number. */
export function storeDefaultEbayCategoryValue(category: { categoryName: string; path?: readonly string[] } | null): string {
  if (category === null) return "Card Shellz picks one for each product (recommended)";
  const path = (category.path ?? []).map((part) => part.trim()).filter((part) => part.length > 0);
  return path.length > 0 ? path.join(" › ") : nonBlank(category.categoryName) ?? UNNAMED_EBAY_CATEGORY;
}

/**
 * The store shelf default (R:581): "None", "Toploaders" or "Toploaders ·
 * second: Penny Sleeves". A saved shelf missing from the live list reads
 * "<name> (no longer in your eBay store)". Null while the setup read hasn't
 * answered (the summary doesn't carry the shelf).
 */
export function storeShelfValue(
  shelfDefault: { ids: readonly string[]; names: readonly string[] } | null | undefined,
  liveShelves: ReadonlyArray<Pick<DropshipEbayStoreCategoryOption, "categoryId" | "categoryName">> | null,
): string | null {
  if (shelfDefault === undefined) return null;
  if (shelfDefault === null || shelfDefault.ids.length === 0) return "None";
  const names = shelfDefault.ids.slice(0, 2).map((id, index) => {
    const live = liveShelves?.find((shelf) => shelf.categoryId === id) ?? null;
    const name = nonBlank(shelfDefault.names[index]) ?? nonBlank(live?.categoryName) ?? UNNAMED_SHELF;
    return liveShelves !== null && live === null ? `${name} (no longer in your eBay store)` : name;
  });
  return names.length === 2 ? `${names[0]} · second: ${names[1]}` : names[0];
}

/** The description store default (R:582); the phone form is "Card Shellz text + above" (R:442). */
export function storeDefaultDescriptionValue(
  text: { hasIntroduction: boolean; hasFooter: boolean },
  form: "full" | "phone" = "full",
): string {
  const where = text.hasIntroduction && text.hasFooter ? "above and below"
    : text.hasIntroduction ? "above"
      : text.hasFooter ? "below" : null;
  if (where === null) return "Card Shellz text";
  return form === "phone" ? `Card Shellz text + ${where}` : `Card Shellz text, with your text ${where}`;
}

// ---------------------------------------------------------------------------
// Shipping policy checks (R:573, R:575; C10)
// ---------------------------------------------------------------------------

/** The issue code eBay policy services carry a suffix on (`shipping_service_unsupported:<code>`). */
const SERVICE_UNSUPPORTED_PREFIX = "shipping_service_unsupported:";
/** Card Shellz's gap, not the vendor's: such a policy can't be checked yet, it is not "Can't use". */
const COVERAGE_INCOMPLETE = "destination_coverage_incomplete";

function businessDays(days: number): string {
  return days === 1 ? "1 business day" : `${days} business days`;
}

function requiredHandlingDays(capability: Pick<DropshipEbayFulfillmentCapability, "requiredHandlingTimeBusinessDays"> | null): number | null {
  const days = capability?.requiredHandlingTimeBusinessDays;
  return typeof days === "number" && Number.isSafeInteger(days) && days > 0 ? days : null;
}

/** Why Card Shellz can't use a shipping policy, for one issue (R:575, completed for every code; C10). */
export function fulfillmentIssueReason(
  issue: { code: string },
  capability: Pick<DropshipEbayFulfillmentCapability, "requiredHandlingTimeBusinessDays"> | null,
): string {
  if (issue.code.startsWith(SERVICE_UNSUPPORTED_PREFIX)) {
    // Interim: the issue carries eBay's service code only, never a name.
    return "Card Shellz doesn't ship with one of this policy's services";
  }
  switch (issue.code) {
    case "marketplace_mismatch":
      return "this policy is for another eBay site";
    case "marketplace_missing":
      // Interim.
      return "this policy's eBay site can't be checked";
    case COVERAGE_INCOMPLETE:
      // Interim: a Card Shellz gap.
      return "Card Shellz can't check this policy yet";
    case "handling_time_missing":
      // Interim.
      return "set a handling time in business days";
    case "handling_time_unit_unsupported":
      // Interim.
      return "handling time must be in business days";
    case "handling_time_too_short": {
      const days = requiredHandlingDays(capability);
      // Interim fallback for an answer without Card Shellz shipping.
      return days === null ? "handling time is too short for Card Shellz" : `handling time must be ${businessDays(days)} or more`;
    }
    case "local_pickup_unsupported":
    case "pickup_drop_off_unsupported":
      return "Card Shellz doesn't offer pickup";
    case "freight_shipping_unsupported":
      return "Card Shellz doesn't offer freight";
    case "international_direct_shipping_unsupported":
      return "Card Shellz ships to US addresses only";
    case "shipping_option_type_unsupported":
      // Interim.
      return "this policy has a shipping option Card Shellz can't use";
    case "domestic_shipping_service_required":
      return "this policy has no US shipping service";
    default:
      // Interim: a code this page doesn't know yet.
      return "Card Shellz can't use this policy";
  }
}

/** Every distinct reason a policy can't be used, in the server's order, leaving out Card Shellz's own coverage gap. */
export function fulfillmentIssueReasons(
  issues: ReadonlyArray<{ code: string }>,
  capability: Pick<DropshipEbayFulfillmentCapability, "requiredHandlingTimeBusinessDays"> | null,
): string[] {
  const reasons = issues.filter((issue) => issue.code !== COVERAGE_INCOMPLETE).map((issue) => fulfillmentIssueReason(issue, capability));
  return [...new Set(reasons)];
}

export type ShippingPolicyFit =
  | { fit: "works"; line: string }
  | { fit: "cant_use"; reason: string; line: string }
  /** Card Shellz couldn't check it: its shipping can't be read now, or its coverage is incomplete. Not the vendor's problem. */
  | { fit: "unchecked"; line: string };

/** What a shipping policy option says (R:192-193): "✓ Works with Card Shellz shipping" or "✗ Can't use: <reason>". */
export function shippingPolicyFit(
  option: Pick<DropshipEbayFulfillmentPolicyOption, "compatible" | "compatibilityChecked" | "compatibilityIssues">,
  capability: Pick<DropshipEbayFulfillmentCapability, "requiredHandlingTimeBusinessDays"> | null,
): ShippingPolicyFit {
  // Interim: Card Shellz shipping could not be read for this answer.
  if (option.compatibilityChecked === false) return { fit: "unchecked", line: "Card Shellz can't check this policy right now" };
  if (option.compatible) return { fit: "works", line: WORKS_WITH_CARD_SHELLZ_SHIPPING };
  const reasons = fulfillmentIssueReasons(option.compatibilityIssues, capability);
  if (reasons.length === 0 && option.compatibilityIssues.some((issue) => issue.code === COVERAGE_INCOMPLETE)) {
    return { fit: "unchecked", line: fulfillmentIssueReason({ code: COVERAGE_INCOMPLETE }, capability) };
  }
  const reason = reasons[0] ?? fulfillmentIssueReason({ code: "" }, capability);
  return { fit: "cant_use", reason, line: `✗ Can't use: ${reason}` };
}

export interface ShippingPolicyNeeds {
  title: string;
  intro: string;
  needs: string[];
  closing: string;
  /** The whole text as one paragraph (R:573). */
  text: string;
}

/**
 * "What your shipping policy needs" (R:573), from Card Shellz shipping as read
 * for this store. Null without it (the shipping row then says why).
 */
export function shippingPolicyNeeds(
  capability: Pick<DropshipEbayFulfillmentCapability, "requiredHandlingTimeBusinessDays" | "supportedServices"> | null,
): ShippingPolicyNeeds | null {
  const days = requiredHandlingDays(capability);
  if (capability === null || days === null) return null;
  const services = [...new Set(capability.supportedServices.map((service) => service.serviceName.trim()).filter(Boolean))];
  const intro = "Card Shellz ships your orders, so your eBay shipping policy must:";
  const needs = [
    `have a handling time of ${businessDays(days)} or more`,
    "ship to US addresses only (US territories and military addresses count)",
    "not offer local pickup or freight",
    // Interim fallback: no service is set up for this store yet.
    services.length > 0 ? `use only these services: ${services.join(", ")}` : "use only services Card Shellz ships with",
  ];
  const closing = "You decide what buyers pay for shipping.";
  return { title: "What your shipping policy needs", intro, needs, closing, text: `${intro} ${needs.join("; ")}. ${closing}` };
}

// ---------------------------------------------------------------------------
// The product drawer: values and where they come from (C16, C17)
// ---------------------------------------------------------------------------

/** Explains an older group rule's place in the order (C17). */
export const GROUP_RULE_ORDER_NOTE = "Older group rules come after a product's own settings and before your store defaults.";
/** Interim (C16): a setting whose value is not the same on every chosen size. */
export const SIZES_DIFFER_WORDS = "Sizes have different values. Each size keeps its own for now.";

/** "used by Pack of 100, Box of 5 and 3 more": the sizes that use one value (C16). */
export function usedByWords(sizeNames: readonly string[], shown = 3): string {
  const names = sizeNames.map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return "used by no chosen size";
  const limit = Math.max(1, Math.trunc(shown));
  if (names.length > limit) return `used by ${names.slice(0, limit).join(", ")} and ${names.length - limit} more`;
  if (names.length === 1) return `used by ${names[0]}`;
  return `used by ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export interface DrawerSourceWords {
  /** The tag beside the value ("Store default"); null when the value says it all. */
  tag: string | null;
  /** A line under the tag; only an older group rule has one. */
  note: string | null;
}

/** Where a drawer value comes from, in the vendor's words (C17). `none` is said by the value itself. */
export function drawerSourceWords(
  key: ListingSettingsSettingKey,
  source: { source: ListingSettingsValueSource; ruleName: string | null },
): DrawerSourceWords {
  switch (source.source) {
    case "store_default":
      return { tag: "Store default", note: null };
    case "group_rule":
      return {
        tag: source.ruleName ? `From your older group rule “${source.ruleName}”` : "From one of your older group rules",
        note: GROUP_RULE_ORDER_NOTE,
      };
    case "size":
      // Interim: the values left on single sizes by today's per-size settings.
      return { tag: "Set on each size", note: null };
    case "catalog":
      // The main text says "Card Shellz text" itself.
      return { tag: key === "ebayCategory" ? "Card Shellz picks" : null, note: null };
    case "none":
      return { tag: null, note: null };
  }
}

const DRAWER_POLICY_KIND = { shippingPolicy: "shipping", returnPolicy: "return", paymentPolicy: "payment" } as const;

/**
 * A policy in the drawer, by name only (A4): eBay's live name, or the name
 * stored for the store default; "<name> (no longer on eBay)" or "A policy
 * that's no longer on eBay" when eBay was read and doesn't have it.
 */
export function drawerPolicyValue(
  key: keyof typeof DRAWER_POLICY_KIND,
  value: ListingSettingsPolicyValue,
  setup: ListingSettingsReadState<PolicySetupFacts>,
): string {
  if (value.policyId === null) return "Not set";
  const failed = setup.error !== undefined && setup.error !== null;
  if (failed) return POLICY_SET_UNNAMED;
  if (setup.data === undefined) return CHECKING_EBAY;
  const { name, onEbay } = policyName(setup.data, POLICY_FIELD[DRAWER_POLICY_KIND[key]], value.policyId);
  if (onEbay === false) {
    // Interim.
    return name ? `${name} (no longer on eBay)` : "A policy that's no longer on eBay";
  }
  return name ?? POLICY_SET_UNNAMED;
}

/** The eBay category in the drawer: its name, never its number. */
export function drawerEbayCategoryValue(value: ListingSettingsEbayCategoryValue): string {
  if (value.categoryId === null) return "No eBay category";
  return nonBlank(value.categoryName) ?? UNNAMED_EBAY_CATEGORY;
}

/** The store shelves in the drawer, first then second. */
export function drawerStoreShelfValue(value: ListingSettingsStoreShelfValue): string {
  const names = value.names.map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return "None";
  return names.length >= 2 ? `${names[0]} · second: ${names[1]}` : names[0];
}

/** The text added above and below the main text, in the drawer. */
export function drawerDescriptionTemplateValue(value: ListingSettingsDescriptionTemplateValue): string {
  // Interim.
  if (value.groupConflict) return "Two older rules tie, so no text is added";
  return storeDefaultDescriptionValue(value);
}

/** The main text in the drawer (interim). */
export function drawerMainTextValue(value: ListingSettingsMainTextValue): string {
  return value.own ? "Main text: your own (set in step 3)" : "Main text: Card Shellz text";
}

// ---------------------------------------------------------------------------
// Products list: fixes, status, own settings (C15)
// ---------------------------------------------------------------------------

/** Why a product needs a fix, after "Needs a fix: " (R:523). */
export function fixReasonWords(code: ListingSettingsFixCode): string {
  switch (code) {
    case "no_ebay_category":
      return "no eBay category";
    case "size_cannot_be_priced":
      return "a size can't be priced";
    case "own_text_needs_check":
      return "check your own text";
    case "description_group_conflict":
      // Interim.
      return "two older description rules tie";
  }
}

export type ProductStatusTone = "ok" | "fix" | "differ";

/**
 * A product's status (C15): "Needs a fix: <reasons>", else "Sizes differ",
 * else "No fixes needed" (interim, instead of "All set", since step 3 still
 * checks stock, photos and the wallet).
 */
export function productStatusWords(row: Pick<ListingSettingsProductRow, "fixes" | "sizesDiffer">): { tone: ProductStatusTone; text: string } {
  if (row.fixes.length > 0) {
    const reasons = [...new Set(row.fixes.map(fixReasonWords))];
    return { tone: "fix", text: `Needs a fix: ${reasons.join(", ")}` };
  }
  if (row.sizesDiffer.length > 0) return { tone: "differ", text: "Sizes differ" };
  return { tone: "ok", text: "No fixes needed" };
}

/** Each setting's name inside a sentence or a list. */
export const LISTING_SETTINGS_FIELD_WORDS: Readonly<Record<ListingSettingsField, string>> = {
  shipping_policy: "shipping policy",
  return_policy: "return policy",
  payment_policy: "payment policy",
  ebay_category: "eBay category",
  store_shelf: "store shelf",
  description: "description",
};

/** The product's own settings as a list: "2 exact prices, shipping policy"; empty when it has none. */
function ownSettingsList(row: Pick<ListingSettingsProductRow, "ownSettings" | "exactPriceCount">): string[] {
  const parts: string[] = [];
  if (row.exactPriceCount === 1) parts.push("1 exact price");
  else if (row.exactPriceCount > 1) parts.push(`${row.exactPriceCount} exact prices`);
  // In the contract's order, whatever order the answer lists them in.
  for (const field of LISTING_SETTINGS_FIELDS) {
    if (row.ownSettings.includes(field)) parts.push(LISTING_SETTINGS_FIELD_WORDS[field]);
  }
  return parts;
}

/** The Products tab's "Own settings" cell: "1 exact price, shipping policy", or "—". */
export function ownSettingsWords(row: Pick<ListingSettingsProductRow, "ownSettings" | "exactPriceCount">): string {
  const parts = ownSettingsList(row);
  if (parts.length === 0) return "—";
  const text = parts.join(", ");
  // "eBay" keeps its small e.
  return text.startsWith("eBay") ? text : capitalize(text);
}

/** The drawer header's line (R:591): "Own settings: …. Everything else uses your store defaults." */
export function ownSettingsSentence(row: Pick<ListingSettingsProductRow, "ownSettings" | "exactPriceCount">): string {
  const parts = ownSettingsList(row);
  return parts.length === 0
    ? "Everything uses your store defaults."
    : `Own settings: ${parts.join(", ")}. Everything else uses your store defaults.`;
}
