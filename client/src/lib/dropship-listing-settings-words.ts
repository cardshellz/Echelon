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
import type { CategoryListingSettingField } from "@shared/dropship/listing-setting-values";
import type { ConnectionBanner, ListingSettingsReadState, ListingSettingsRightReason } from "./dropship-listing-settings-access";
import { LISTING_SETUP_RELOAD_MESSAGE } from "./dropship-ebay-listing-setup";
import { listingAccessLink, type ListingAccessLink } from "./dropship-listing-access";
import { displayListingPrice } from "./dropship-listing-price";
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
      // Interim (PR 10 PROPOSAL): the record has no words for a paused account on this step. It
      // names only what the pause locks (prices, a product's own settings, eBay categories and
      // descriptions); an eBay sign-in, an eBay refusal or eBay not answering can lock the store
      // policies and the shelf too, and those rows then say so on their own line.
      return {
        message: "Selling is paused on your account. Prices, products and categories can't be changed until it resumes.",
        action: WALLET,
      };
    case "ops_inactive":
      // Interim (PR 10 PROPOSAL): R:506 widened, since products, eBay categories and descriptions are refused too.
      return {
        message: "Your Shellz Club .ops access is inactive, so prices, products and categories can't be changed. Contact support.",
        action: SUPPORT,
      };
    case "sign_in":
      // Interim (PR 10 PROPOSAL): R:500 with the resets PR 9 brought (a product's setting can still use the default, D4).
      return {
        message: `eBay needs you to sign in again for ${name}. You can still change prices, text and defaults.`,
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
export const UNNAMED_SHELF = "A shelf";

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

/**
 * Explains an older group rule's place in the order (C17): after the product's
 * own settings, before its category's and the store defaults (closest setting
 * wins, REC:993; older rules sit between product and category until PR 11).
 */
// Interim (PR 10 PROPOSAL).
export const GROUP_RULE_ORDER_NOTE = "Older group rules come after a product's own settings and before category settings and store defaults.";
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
      // Interim (PR 10 PROPOSAL): a value left on a size by the older per-size settings.
      return { tag: "Set on this size", note: null };
    case "product":
      // Interim (PR 10 PROPOSAL): the product's own value (W5).
      return { tag: "Set for this product", note: null };
    case "category":
      // The server names the category; a nameless one still says where the value comes from.
      return { tag: source.ruleName ? `From category: ${source.ruleName}` : "From its Card Shellz category", note: null };
    case "catalog":
      // The main text says "Card Shellz text" itself.
      return { tag: key === "ebayCategory" ? "Card Shellz picks" : null, note: null };
    case "none":
      return { tag: null, note: null };
  }
}

const DRAWER_POLICY_KIND = { shippingPolicy: "shipping", returnPolicy: "return", paymentPolicy: "payment" } as const;

/**
 * A policy in the drawer, by name only (A4): eBay's live name, else the name
 * stored for the store default, else `storedName`, the name the product's own
 * settings row stored for this id (its own read, PR 10; filled only when the
 * product's own policy is this one). "<name> (no longer on eBay)" or "A policy
 * that's no longer on eBay" when eBay was read and doesn't have it. Without
 * eBay's read the stored names are all there is, so the product's own policy
 * reads by name even then (gap G2).
 */
export function drawerPolicyValue(
  key: keyof typeof DRAWER_POLICY_KIND,
  value: ListingSettingsPolicyValue,
  setup: ListingSettingsReadState<PolicySetupFacts>,
  storedName: string | null = null,
): string {
  if (value.policyId === null) return "Not set";
  const ownName = nonBlank(storedName);
  const failed = setup.error !== undefined && setup.error !== null;
  if (failed) return ownName ?? POLICY_SET_UNNAMED;
  if (setup.data === undefined) return CHECKING_EBAY;
  const found = policyName(setup.data, POLICY_FIELD[DRAWER_POLICY_KIND[key]], value.policyId);
  const name = found.name ?? ownName;
  if (found.onEbay === false) {
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

// ---------------------------------------------------------------------------
// Editing a product's own settings, and the PR 9 writers' save words (PR 10)
// ---------------------------------------------------------------------------

/**
 * Words for the drawer's setting editors and the save answers of the PR 9
 * writers (plan PR 10, 3.3, 4.7, 4.8, D2, D4, D7). Every one is a proposal the
 * record does not give (plan 12.2), kept here so a later PR changes it in one
 * place. None names a code or an id.
 */
export const LISTING_SETTINGS_EDIT_WORDS = Object.freeze({
  // The record's word for following the next level down (REC:854, REC:857).
  useDefault: "Use default",
  // Interim (PR 10 PROPOSAL): a drawer field editor's button that puts the choice in the draft (plan 4.5); nothing is sent until Save.
  done: "Done",
  // Interim (PR 10 PROPOSAL): one kind of change per Save (D2).
  otherChangeFirst: "Save or discard your other change first.",
  // Interim (PR 10 PROPOSAL): the product's own settings read failed (4.8).
  ownReadFailed: "Couldn't load this product's settings. Try again.",
  // Interim (PR 10 PROPOSAL): a field under the sign-in banner offers the default only (D4, 3.3 row 15).
  signInFieldLine: "Sign in to eBay again to pick a new one. You can still use the default.",
  // Interim (PR 10 PROPOSAL): a field that offers the default only while a banner says why no new pick can be made
  // (eBay refusing access, say), so the editor's lone "Use default" is not left unexplained (D4).
  defaultOnlyLine: "You can't pick a new one right now. You can still use the default.",
  // Interim (PR 10 PROPOSAL): Save waits while a field editor holds a pick that isn't in the draft yet.
  finishEditorFirst: "Press Done or Cancel first.",
  // Interim (PR 10 PROPOSAL): a save body this page could not build; it was never sent.
  cantBuild: "This change can't be saved as it is. Check it and save again.",
  // Interim (PR 10 PROPOSAL): 503 BUSY while another heavy write runs; true for this send (D7a).
  busyHeavy: "Another big change is saving. Nothing was saved. Try again in a few seconds.",
  // Interim (PR 10 PROPOSAL): 503 BUSY when the request key changed under the write (D7a).
  busyKeyChanged: "Listing settings are busy. Nothing was saved. Try again in a few seconds.",
  // Interim (PR 10 PROPOSAL): a Check again answered by a refusal that only says "not now" (D7b);
  // the first send may still have saved, so these never say "Nothing was saved".
  stillUnconfirmed: "We couldn't confirm your save. Wait a few seconds, then check again.",
  // Interim (PR 10 PROPOSAL): as above, after too many saves in a minute (D7b).
  stillUnconfirmedRateLimited: "We couldn't confirm your save. Too many saves in a minute. Wait a moment, then check again.",
  // Interim (PR 10 PROPOSAL): 401 (3.3 row 2).
  signedOut: "You're signed out. Sign in again, then save.",
  // Interim (PR 10 PROPOSAL): the three fatal codes; a final answer, never Check again (D7c).
  fatal: "Something went wrong on our side. Reload to see what's saved. If it happens again, contact support.",
  // Interim (PR 10 PROPOSAL): 413 (3.3 row 13).
  tooBig: "This change is too big to send at once. Choose fewer products.",
  // Interim (PR 10 PROPOSAL): a request the server can't read (3.3 rows 14 and 22).
  invalid: "This change couldn't be saved. Reload the page and try again.",
  // Interim (PR 10 PROPOSAL): eBay no longer lists a picked policy (3.3 row 17).
  policyGone: "That policy is no longer on eBay. Pick another one.",
  // Interim (PR 10 PROPOSAL): eBay no longer accepts a picked category (3.3 row 19).
  categoryGone: "eBay no longer accepts that category. Search again and pick another.",
  // Interim (PR 10 PROPOSAL): a shelf whose eBay name is too long to store (3.3 row 20).
  shelfTooLong: "eBay names this shelf in a way we can't use. Pick another shelf.",
  // Interim (PR 10 PROPOSAL): the store's saved text is at its cap (3.3 row 21).
  storeTextLimit: "Your store has too much saved text. Shorten text on other products, or set it once on a category or as your store default.",
  // Interim (PR 10 PROPOSAL): a setting whose sizes differ, with a quick pick beside its values (plan 5.3, 12.2).
  sizesDifferPick: "Sizes differ. Pick one for all sizes.",
  // Interim (PR 10 PROPOSAL): the quick pick that sets this value for the product, so every size uses it (5.3).
  useForAllSizes: "Use for all sizes",
  // Interim (PR 10 PROPOSAL): the quick pick that gives every size the default back (5.3; CC-C17).
  useDefaultForAllSizes: "Use default for all sizes",
  // Interim (PR 10 PROPOSAL): the store shelf or the description differ by size; its [Change] picks one (5.3).
  sizesDifferChange: "Sizes differ. Use Change to pick one for all sizes.",
  // The store default shelf editor's word for explicitly no shelf (R:581), and for no text above or below.
  none: "None",
  // Interim (PR 10 PROPOSAL): the description editor's choice to write the product's own text (5.2).
  ownText: "Own text",
  // Interim (PR 10 PROPOSAL): the shelf editor's choice to pick one or two shelves for the product (5.2).
  ownShelves: "Own shelves",
  // Interim (PR 10 PROPOSAL): an empty shelf box in the drawer's shelf editor.
  pickShelf: "Pick a shelf",
  // Interim (PR 10 PROPOSAL): the shelf box's choice that empties it again.
  clearShelf: "Clear this shelf",
  // Interim (PR 10 PROPOSAL): the description editor's parts (5.2), as the store default editor names the first and last.
  textAbove: "Text above",
  textBelow: "Text below",
  mainText: "Main text",
  // Interim (PR 10 PROPOSAL): the main text's default, and the check's second answer (5.4, 12.2).
  useCardShellzText: "Use Card Shellz text",
  // Interim (PR 10 PROPOSAL): the check's first answer: the same text, saved again (5.4, 12.2).
  keepMyText: "Keep my text",
  // Interim (PR 10 PROPOSAL): the main text's check (5.4, 12.2).
  ownTextCheck: "Card Shellz changed this product. Check your text still fits.",
  // Interim (PR 10 PROPOSAL): the description editor while two older description rules tie for the product; only the
  // product's own text above and below (each own text or None) takes the tie away.
  descriptionConflictBoth: "Set both text above and text below, your own or None, to fix this.",
  // The shared schema's own words for empty own text above or below (`SH/listing-setting-values.ts` ownTemplateText; 5.5).
  textEmpty: "Enter the text, or choose None.",
  // Interim (PR 10 PROPOSAL): empty own main text (5.5, 12.2).
  mainTextEmpty: "Enter your text, or use the Card Shellz text.",
  // Interim (PR 10 PROPOSAL): own text with a control character the shared schema refuses (a paste can bring one).
  textBadCharacters: "This text has characters that can't be saved. Paste it as plain text.",
} as const);

const TEXT_NUMBER = new Intl.NumberFormat("en-US");

/** "Shorten it to 4,000 characters or fewer.": own text over its limit (5.4). Interim (PR 10 PROPOSAL). */
export function textTooLongWords(max: number): string {
  return `Shorten it to ${TEXT_NUMBER.format(max)} characters or fewer.`;
}

/**
 * A text box's counter, "12 / 4,000": the raw text's length (UTF-16 units,
 * as the server counts it, 5.4), in the store default description's form
 * (R:582, `descriptionLengthWords`).
 */
export function textLengthWords(count: number, max: number): string {
  return `${TEXT_NUMBER.format(count)} / ${TEXT_NUMBER.format(max)}`;
}

/** "From your Sleeves settings": the drawer header's part for a value its Card Shellz category sets (R:591, via `drawerCategoryLine`). */
export function fromCategorySettingsWords(category: string): string {
  return `From your ${category.trim()} settings`;
}

/** One part of a pending description change, for `descriptionPendingWords`. */
export type DescriptionPendingPart = { part: "textAbove" | "textBelow" | "mainText"; to: "default" | "none" | "own" };

/**
 * The Description row's change before Save, every part it changes in one
 * line: "→ Text above: your own, main text: Card Shellz text · Not saved".
 * The text itself is never repeated there. Interim (PR 10 PROPOSAL).
 */
export function descriptionPendingWords(parts: readonly DescriptionPendingPart[]): string | null {
  if (parts.length === 0) return null;
  const words = parts.map(({ part, to }, index) => {
    const label = LISTING_SETTINGS_EDIT_WORDS[part];
    const name = index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1);
    const value = to === "own" ? "your own"
      : to === "none" ? LISTING_SETTINGS_EDIT_WORDS.none
        : part === "mainText" ? "Card Shellz text" : LISTING_SETTINGS_EDIT_WORDS.useDefault;
    return `${name}: ${value}`;
  });
  return pendingSettingWords(words.join(", "));
}

/** The product read's and a product save's 404: the product isn't chosen for this store (any more). The words name the store (C27). */
export function productNotFoundWords(store: string): string {
  return `This product isn't chosen for ${storeName(store)}. Choose it in step 1.`;
}

/**
 * A drawer row's [Change], named with its product so a screen reader tells
 * one product's from a store default's (plan 3.4): "Change shipping policy
 * for Penny Sleeves". Interim (PR 10 PROPOSAL).
 */
export function changeSettingLabel(label: string, productName: string): string {
  const product = productName.trim();
  const setting = label.charAt(0).toLowerCase() + label.slice(1);
  return product ? `Change ${setting} for ${product}` : `Change ${setting}`;
}

/**
 * A "Sizes differ" quick pick's name, read out with the value and the product
 * (plan 3.4, 5.3): "Use USPS Priority Mail for all sizes of Penny Sleeves",
 * or "Use default for all sizes of Penny Sleeves". The button shows only
 * "Use for all sizes" / "Use default for all sizes". Interim (PR 10 PROPOSAL).
 */
export function sizesDifferPickLabel(action: "use_default" | "use_this", value: string, productName: string): string {
  const product = productName.trim();
  const what = action === "use_default" ? "default" : value.trim() || "this";
  return product ? `Use ${what} for all sizes of ${product}` : `Use ${what} for all sizes`;
}

/**
 * The open field editor's name ("Shipping policy for Penny Sleeves"), read
 * out for its group (plan 3.4). Interim (PR 10 PROPOSAL).
 */
export function fieldEditorLabel(label: string, productName: string): string {
  const product = productName.trim();
  return product ? `${label} for ${product}` : label;
}

/** "→ Free Standard US · Not saved": a setting's change before Save, in the form of a size's (R:250). */
// Interim (PR 10 PROPOSAL).
export function pendingSettingWords(value: string): string {
  return `→ ${value} · Not saved`;
}

/** The main text in the drawer (interim): the drawer edits it now, so it no longer points at step 3 (plan 5.2). */
export function drawerMainTextValue(value: ListingSettingsMainTextValue): string {
  return value.own ? "Main text: your own" : "Main text: Card Shellz text";
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

/**
 * The drawer header's line (R:591): "Own settings: …. Everything else uses your store defaults."
 * `olderGroupRules`: an older group rule gives the product one of its values (a setting or a
 * size's price), so the rest is not all store defaults and the line says so (interim words).
 */
export function ownSettingsSentence(row: Pick<ListingSettingsProductRow, "ownSettings" | "exactPriceCount">, olderGroupRules: boolean): string {
  const parts = ownSettingsList(row);
  const rest = olderGroupRules ? "your store defaults or older group rules" : "your store defaults";
  return parts.length === 0
    ? `Everything uses ${rest}.`
    : `Own settings: ${parts.join(", ")}. Everything else uses ${rest}.`;
}

// ---------------------------------------------------------------------------
// "Set for selected": the Products tab's ticks and its sheet (plan PR 10, 6.3, 6.5, 12.2)
// ---------------------------------------------------------------------------

/**
 * Words for ticking products and for the "Set for selected" sheet (W6).
 * "Set for selected" and "Select all N" are the record's (REC:971, REC:820),
 * and "These become each product's own values." is R:§3.3 M5 (PLAN3:128);
 * every other one is a proposal (plan 12.2), kept here so a later PR changes
 * it in one place. None names a code or an id.
 */
export const LISTING_SETTINGS_BULK_WORDS = Object.freeze({
  // The record's name for the bar's button, the sheet, and the place the step's bar names (REC:971).
  setForSelected: "Set for selected",
  // Interim (PR 10 PROPOSAL): the bar's button that unticks every product (6.3).
  clear: "Clear",
  // R:§3.3 M5 (PLAN3:128): the sheet's intro.
  intro: "These become each product's own values.",
  // Interim (PR 10 PROPOSAL): a row the sheet doesn't change, and the choice that takes a row back to no change (REC:854 "Leave").
  leaveAsIs: "Leave as is",
  // Interim (PR 10 PROPOSAL): none of the products the sheet opened for is chosen any more (6.3).
  noneChosen: "None of these products is chosen any more.",
  // Interim (PR 10 PROPOSAL): 422 BULK_TOO_LARGE, and the same check before sending, with Save off (6.5).
  tooMuchText: "Too much text for this many products. Choose fewer products, or set the text once on a category or as your store default.",
  // Interim (PR 10 PROPOSAL): W6's 404 PRODUCT_NOT_FOUND, a product Card Shellz deleted since the sheet opened (6.5).
  productGone: "A selected product is no longer in the Card Shellz catalog. Load the list again.",
  // Interim (PR 10 PROPOSAL, beyond 12.2): the sheet's ids read failed (3.7); [Try again] reads it again.
  readFailed: "Couldn't check the selected products. Try again.",
  // Interim (PR 10 PROPOSAL, beyond 12.2): the Products tab's header checkbox, read out (3.4).
  selectPage: "Select every product on this page",
  // Interim (PR 10 PROPOSAL, beyond 12.2): a phone has no table header, so this box above the cards ticks every card shown (3.4).
  selectShown: "Select all shown",
  // Interim (PR 10 PROPOSAL, beyond 12.2): whose setting the sheet's [Change] and editors change, read out (3.4):
  // "Change shipping policy for the selected products".
  selectedProducts: "the selected products",
  // Interim (PR 10 PROPOSAL, beyond 12.2): the sheet reopened on other ticks, and the change kept from before now goes to these products.
  carried: "Your unsaved change from before is kept for these products.",
} as const);

function productsWord(count: number): string {
  return count === 1 ? "product" : "products";
}

/** "3 selected": the bar's count (6.3). Interim (PR 10 PROPOSAL). */
export function selectedCountWords(count: number): string {
  return `${TEXT_NUMBER.format(count)} selected`;
}

/**
 * After a whole page is ticked (6.3): wide "All 50 on this page are
 * selected.", phone "All 100 shown are selected." Interim (PR 10 PROPOSAL).
 */
export function pageAllSelectedWords(count: number, compact: boolean): string {
  return compact ? `All ${TEXT_NUMBER.format(count)} shown are selected.` : `All ${TEXT_NUMBER.format(count)} on this page are selected.`;
}

/** "Select all 312": every product the search and filter match (REC:820 "Select all N"). */
export function selectAllWords(total: number): string {
  return `Select all ${TEXT_NUMBER.format(total)}`;
}

/** A row's checkbox, read out with its product (plan 3.4): "Select Penny Sleeves". Interim (PR 10 PROPOSAL). */
export function selectProductLabel(productName: string): string {
  const product = productName.trim();
  return product ? `Select ${product}` : "Select this product";
}

/** "Saved for 312 products. Still selected.": the status after a confirmed save; the ticks stay (D22). Interim (PR 10 PROPOSAL). */
export function savedForSelectedWords(count: number): string {
  return `Saved for ${TEXT_NUMBER.format(count)} ${productsWord(count)}. Still selected.`;
}

/**
 * "Saved for 312 products.": the status after a confirmed save once the
 * products it named aren't the selection (the ticks changed, or an earlier
 * unconfirmed save was checked). Interim (PR 10 PROPOSAL, beyond 12.2).
 */
export function savedForProductsWords(count: number): string {
  return `Saved for ${TEXT_NUMBER.format(count)} ${productsWord(count)}.`;
}

/**
 * "This save is for the 2 products it was sent for.": the sheet reopened on a
 * save that is out or unconfirmed, whatever is ticked now (D21). Interim (PR 10 PROPOSAL, beyond 12.2).
 */
export function heldSaveWords(count: number): string {
  return `This save is for the ${TEXT_NUMBER.format(count)} ${productsWord(count)} it was sent for.`;
}

/**
 * What the Products tab's status region reads out when the selection bar
 * changes (plan 3.4): "3 selected.", then the "Select all N" offer and a
 * save's status. Interim (PR 10 PROPOSAL, beyond 12.2).
 */
export function selectionAnnouncementWords(input: { count: string; offer: { line: string; label: string } | null; status: string | null }): string {
  const parts = [`${input.count}.`];
  if (input.offer !== null) parts.push(input.offer.line, `${input.offer.label} is available.`);
  if (input.status !== null) parts.push(input.status);
  return parts.join(" ");
}

/** "Set for 312 products": the sheet's title (6.3). Interim (PR 10 PROPOSAL). */
export function bulkSheetTitleWords(count: number): string {
  return `Set for ${TEXT_NUMBER.format(count)} ${productsWord(count)}`;
}

/** "Save for 312 products": the sheet's wide Save (6.3); the phone says "Save". Interim (PR 10 PROPOSAL). */
export function saveForWords(count: number): string {
  return `Save for ${TEXT_NUMBER.format(count)} ${productsWord(count)}`;
}

/** "Checking 312 products…": while the sheet's ids read answers (6.3). Interim (PR 10 PROPOSAL). */
export function checkingProductsWords(count: number): string {
  return `Checking ${TEXT_NUMBER.format(count)} ${productsWord(count)}…`;
}

/** "312 now match (was 310).": "Select all N" when the ids read counts otherwise (6.3, CC-C26). Interim (PR 10 PROPOSAL). */
export function matchMovedWords(now: number, before: number): string {
  return `${TEXT_NUMBER.format(now)} now ${now === 1 ? "matches" : "match"} (was ${TEXT_NUMBER.format(before)}).`;
}

/** "2 products are no longer chosen and are left out." (6.3). Interim (PR 10 PROPOSAL). */
export function leftOutWords(count: number): string {
  return count === 1
    ? "1 product is no longer chosen and is left out."
    : `${TEXT_NUMBER.format(count)} products are no longer chosen and are left out.`;
}

/**
 * W6's version conflict (6.5): "3 of the selected products changed in
 * another window.", counted by the server (`conflictCount`), never by the
 * list. Interim (PR 10 PROPOSAL).
 */
export function bulkConflictWords(conflictCount: number): string {
  return `${TEXT_NUMBER.format(conflictCount)} of the selected products changed in another window.`;
}

// ---------------------------------------------------------------------------
// The price check for one or many products (W7 `product_prices`; plan PR 10, 7.4, 7.5, 12.2)
// ---------------------------------------------------------------------------

/**
 * Words of the price check for one or many products (PR 10d). Every one is a
 * proposal (plan 12.2, or "beyond 12.2" where marked), kept here so a later
 * PR changes it in one place. The check's shared words (title, columns,
 * "Back to editing", "Save new prices", the stale line R:683) are W1's
 * `CHECK_NEW_PRICES_WORDS` (dropship-listing-settings-recipe.ts). None names
 * a code or an id.
 */
export const LISTING_SETTINGS_PRICE_CHECK_WORDS = Object.freeze({
  // Interim (PR 10 PROPOSAL): the price editor's tick box (7.1, 12.2); the apply then releases every chosen size's exact price.
  clearExactPrices: "Clear exact prices too, so every size uses this price",
  // Interim (PR 10 PROPOSAL, beyond 12.2): the same choice in a pending line, short.
  clearExactPricesShort: "Clear exact prices too",
  // Interim (PR 10 PROPOSAL): the Note of a size whose exact price the apply clears (7.4).
  exactPriceCleared: "Exact price cleared",
  // Interim (PR 10 PROPOSAL): a check with no rows (P35; 7.4). Save stays on when a price is sent.
  noSizes: "No chosen sizes to check.",
  // Interim (PR 10 PROPOSAL): rows but no price moves, while a price is sent (7.4). Save on.
  noPriceChanges: "No prices change now. Saving still sets the price.",
  // Interim (PR 10 PROPOSAL): a release with nothing to release (7.4). Save off.
  nothingToClear: "No exact prices to clear.",
  // Interim (PR 10 PROPOSAL): under the refused footer: an exact price for a size is W9's, another draft (D16; 7.4).
  oneDraft: "To give them an exact price, discard this change first.",
  // Interim (PR 10 PROPOSAL): the apply found its check already applied under another key (409 IDEMPOTENCY_CONFLICT; 7.5, CC-C8).
  alreadySaved: "This check was already saved. Here's a new check.",
  // Interim (PR 10 PROPOSAL, beyond 12.2): the apply found no such check (404; 7.5): the new check says so once.
  expired: "This check expired. Here's a new check.",
  // Interim (PR 10 PROPOSAL): 422 TOO_LARGE with no reason on the check (P35; 7.5, D8).
  tooManySizes: "This check covers more than 10,000 sizes. Choose fewer products.",
  // Interim (PR 10 PROPOSAL): 422 BULK_TOO_LARGE on the check or the apply (plan 9.7's memory rule; 7.5, CC-C10).
  tooHeavy: "This check is too big to save at once. Choose fewer products.",
  // Interim (PR 10 PROPOSAL, beyond 12.2): the drawer's PRICE head button that opens the price editor (7.2).
  changePrice: "Change price",
  // Interim (PR 10 PROPOSAL, beyond 12.2): the check body's head: what is being checked.
  checking: "Checking",
  // Built from (7.4, 12.2): the level that prices a size, by the row's `ruleLevel`, then its `ruleName`.
  thisProductPrice: "This product's price",
  categoryPrice: "Category price",
  storeDefault: "Store default",
  retailNoPrice: "Retail price (no price set)",
  exactKept: "Exact price kept",
} as const);

/** "Older group rule “Envelopes”": a W7 row priced by an older group rule (7.4). Interim (PR 10 PROPOSAL). */
export function olderGroupRuleWords(name: string): string {
  return `Older group rule “${name.trim()}”`;
}

/**
 * "from retail $12.50" / "from your cost $2.10": what a W7 row's new price
 * starts from (its `basis` and `basisCents`, 7.4); without the amount "from
 * retail"; null without a basis. Interim (PR 10 PROPOSAL).
 */
export function builtFromStartWords(basis: "catalog_retail" | "product_cost" | null | undefined, basisCents: number | null | undefined): string | null {
  if (basis !== "catalog_retail" && basis !== "product_cost") return null;
  const start = basis === "catalog_retail" ? "retail" : "your cost";
  return basisCents == null ? `from ${start}` : `from ${start} ${displayListingPrice(basisCents)}`;
}

function sizesWord(count: number): string {
  return count === 1 ? "size" : "sizes";
}

/** "36 lose their exact price" / "1 loses its exact price": the counts line (7.4). Interim (PR 10 PROPOSAL). */
export function loseExactPriceWords(count: number): string {
  return count === 1 ? "1 loses its exact price" : `${TEXT_NUMBER.format(count)} lose their exact price`;
}

/** "3 would lose their price" / "1 would lose its price": the counts line (7.4). Interim (PR 10 PROPOSAL). */
export function wouldLosePriceCountWords(count: number): string {
  return count === 1 ? "1 would lose its price" : `${TEXT_NUMBER.format(count)} would lose their price`;
}

/**
 * The refused footer when the check sends no recipe (Use default, or a
 * release alone), and the apply's own 422 WOULD_BE_LOST (7.4, 7.5): "● 3
 * sizes would be left without a price. Give them an exact price in Products
 * first." Interim (PR 10 PROPOSAL).
 */
export function wouldBeLeftWithoutPriceWords(count: number): string {
  const sizes = `${TEXT_NUMBER.format(count)} ${sizesWord(count)}`;
  return count === 1
    ? `● ${sizes} would be left without a price. Give it an exact price in Products first.`
    : `● ${sizes} would be left without a price. Give them an exact price in Products first.`;
}

/**
 * 422 PRICE_RELEASE_LIMIT (7.5, CC-C9), from the answer's `maxReleases` and
 * `releaseCount`: "You can clear up to 200 exact prices at once. This would
 * clear 236. Choose fewer products." Interim (PR 10 PROPOSAL).
 */
export function releaseLimitWords(maxReleases: number, releaseCount: number): string {
  return `You can clear up to ${TEXT_NUMBER.format(maxReleases)} exact prices at once. This would clear ${TEXT_NUMBER.format(releaseCount)}. Choose fewer products.`;
}

// ---------------------------------------------------------------------------
// "Card Shellz updated products" (PR 10g, plan 10.3, 12.2)
// ---------------------------------------------------------------------------

/**
 * Words of "Card Shellz updated products" (W13, plan 10.3). The title and
 * "Got it" / "Got it for all N" are the record's (REC:875, REC:993); every
 * other one is a proposal (plan 12.2, or "beyond 12.2" where marked), kept
 * here so a later PR changes it in one place. None names a code or an id.
 */
/**
 * A product the answer gives no name for, in the attention strip's lines and
 * in "Card Shellz updated products"' rows and read-out labels. Interim (PR 10 PROPOSAL).
 */
export const UNNAMED_PRODUCT_WORDS = "A product";

export const LISTING_SETTINGS_UPDATED_WORDS = Object.freeze({
  // The record's name for the sheet (REC:875, REC:993), and the place the step's bar names.
  title: "Card Shellz updated products",
  // The record's button for one moved product (REC:875).
  gotIt: "Got it",
  // Interim (PR 10 PROPOSAL): the strip line's button, and the own-text row's; both open the sheet or the drawer (10.3).
  check: "Check",
  // Interim (PR 10 PROPOSAL): the line under the attention strip opens the sheet (10.2).
  review: "Review",
  // Interim (PR 10 PROPOSAL): after a confirmed "Got it" (10.3).
  done: "Done.",
  // Interim (PR 10 PROPOSAL): a move whose category settings don't differ for this product (10.3, UX-M6; never "Nothing changes").
  noChanges: "No category setting changes for it.",
  // Interim (PR 10 PROPOSAL): a product moved out of, or into, no category (CC-C21).
  noCategory: "no category",
  // Interim (PR 10 PROPOSAL): a category Card Shellz has since deleted; the mark keeps its id, the name is gone (CC-C21).
  removedCategory: "a category Card Shellz removed",
  // Interim (PR 10 PROPOSAL, beyond 12.2): while the sheet's page reads (3.7).
  loading: "Checking what Card Shellz updated…",
  // Interim (PR 10 PROPOSAL, beyond 12.2): the sheet's page read failed (3.7); [Try again] reads it again.
  readFailed: "Couldn't check what Card Shellz updated. Try again.",
  // Interim (PR 10 PROPOSAL, beyond 12.2): nothing to show (3.7).
  empty: "Nothing here. Card Shellz hasn't updated any of your products.",
  // Interim (PR 10 PROPOSAL, beyond 12.2): the phone's paging (10.3 "phone Load more").
  loadMore: "Load more",
} as const);

/** Each category setting's name inside a sentence (`changedFields`, the stored shape's order). Interim (PR 10 PROPOSAL). */
export const CATEGORY_SETTING_WORDS: Readonly<Record<CategoryListingSettingField, string>> = Object.freeze({
  price: "price",
  ebayCategory: "eBay category",
  storeShelf: "store shelf",
  shippingPolicy: "shipping policy",
  returnPolicy: "return policy",
  paymentPolicy: "payment policy",
  textAbove: "text above",
  textBelow: "text below",
});

/** "Moved from Sleeves to Toploaders.": a product's move, with the category names as given (10.3). Interim (PR 10 PROPOSAL). */
export function movedFromToWords(from: string, to: string): string {
  return `Moved from ${from} to ${to}.`;
}

/**
 * "Category settings that differ: price, shipping policy." in the order
 * given (the stored shape's, never re-sorted), or "No category setting
 * changes for it." when none differ (10.3, UX-M6). Interim (PR 10 PROPOSAL).
 */
export function changedCategorySettingsWords(fields: readonly CategoryListingSettingField[]): string {
  if (fields.length === 0) return LISTING_SETTINGS_UPDATED_WORDS.noChanges;
  return `Category settings that differ: ${fields.map((field) => CATEGORY_SETTING_WORDS[field]).join(", ")}.`;
}

/** "Got it for all 4" (REC:875). */
export function gotItForAllWords(count: number): string {
  return `Got it for all ${TEXT_NUMBER.format(count)}`;
}

/** A row's [Got it], read out with its product (plan 3.4): "Got it for Penny Sleeves". Interim (PR 10 PROPOSAL). */
export function gotItLabel(productName: string): string {
  const product = productName.trim();
  return product ? `${LISTING_SETTINGS_UPDATED_WORDS.gotIt} for ${product}` : LISTING_SETTINGS_UPDATED_WORDS.gotIt;
}

/** An own-text row's [Check], read out with its product (plan 3.4): "Check the text of Penny Sleeves". Interim (PR 10 PROPOSAL). */
export function checkOwnTextLabel(productName: string): string {
  const product = productName.trim();
  return product ? `${LISTING_SETTINGS_UPDATED_WORDS.check} the text of ${product}` : LISTING_SETTINGS_UPDATED_WORDS.check;
}

/**
 * "2 products moved again. Check them below. It can take a minute to update."
 * (10.3): W13's `movedAgainProductIds`, counted from the answer, never from
 * the re-read (which can show the same list for up to a minute). Interim (PR 10 PROPOSAL).
 */
export function movedAgainWords(count: number): string {
  return count === 1
    ? "1 product moved again. Check it below. It can take a minute to update."
    : `${TEXT_NUMBER.format(count)} products moved again. Check them below. It can take a minute to update.`;
}

/** "Card Shellz moved 4 products to another category.": the line under the attention strip (10.2). Interim (PR 10 PROPOSAL). */
export function updatedProductsLineWords(count: number): string {
  return count === 1
    ? "Card Shellz moved 1 product to another category."
    : `Card Shellz moved ${TEXT_NUMBER.format(count)} products to another category.`;
}
