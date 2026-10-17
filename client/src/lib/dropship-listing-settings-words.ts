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
import type { ConversionBlockerCode, ConversionKept, ConversionSetting, ConversionTieSetting } from "@shared/dropship/listing-rules-conversion";
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
 * A policy's name for a page outside this step (step 3, plan PR 10 D14):
 * eBay's live name when the setup read ran this visit, else the name stored
 * for the store default, else null, so the caller shows a link and never an id.
 */
export function setupPolicyName(setup: PolicySetupFacts, kind: ListingSettingsPolicyKind, policyId: string): string | null {
  return policyName(setup, POLICY_FIELD[kind], policyId).name;
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

// ---------------------------------------------------------------------------
// The Category settings card and the category editor (PR 10e, plan 8.3, 8.4, 8.6, 12.2)
// ---------------------------------------------------------------------------

/**
 * Words of the Category settings card and the category editor (W12, plan
 * 8.3). "Category settings" is the record's (REC:971, REC:819), "Use store
 * default" REC:871's and "Also clear theirs" REC:869's; every other one is a
 * proposal (plan 12.2, or "beyond 12.2" where marked), kept here so a later
 * PR changes it in one place. None names a code or an id.
 */
export const LISTING_SETTINGS_CATEGORY_WORDS = Object.freeze({
  // The record's name for the card (REC:971, REC:819), and the place the step's bar names.
  title: "Category settings",
  // Interim (PR 10 PROPOSAL): the card's intro (8.3).
  intro: "Products in a Card Shellz category use its settings before your store defaults.",
  // Interim (PR 10 PROPOSAL): a category row with no setting of its own (8.3).
  usesStoreDefaults: "Uses your store defaults",
  // Interim (PR 10 PROPOSAL): the lead-in to a category row's own settings, "Sets: shipping policy, store shelf" (8.3).
  sets: "Sets",
  // Interim (PR 10 PROPOSAL): no chosen product is in a Card Shellz category (8.3).
  empty: "None of your chosen products is in a Card Shellz category.",
  // Interim (PR 10 PROPOSAL): the card's read failed (8.3); [Try again] reads it again.
  readFailed: "Couldn't load category settings.",
  // Interim (PR 11 PROPOSAL, D17): the store holds older group rules, so no category save can be made (PR 10 D11, 8.3); also the
  // 409's words (8.6). It no longer promises a later move (a store that isn't clean is never moved by itself, CUX#5); the card
  // and the editor show [See what changes] beside it (PR 11b).
  olderRules: "Category settings can't be saved while your store has older group rules.",
  // Interim (PR 11 PROPOSAL, D17): a category row with no setting of its own while older group rules are present: a group
  // rule may still decide its products' values, so "Uses your store defaults" could be false (CUX#6).
  noCategorySettingsYet: "No category settings yet",
  // The record's word for a category that follows the store (REC:871, D17).
  useStoreDefault: "Use store default",
  // Interim (PR 10 PROPOSAL): the tag beside a value the store default gives (8.3).
  storeDefault: "Store default",
  // The record's box (REC:869): the category's products with their own value follow the category (8.4).
  alsoClear: "Also clear theirs",
  // Interim (PR 10 PROPOSAL): the 404 of a category save or the editor's read (8.6): the editor closes, the card reads again.
  categoryNotFound: "No chosen product is in this category any more.",
  // Interim (PR 10 PROPOSAL, beyond 12.2): the editor's Price row is read-only until the category price check (10f, UX-m9).
  priceReadOnly: "A category's price can't be changed here yet.",
  // Interim (PR 10 PROPOSAL, beyond 12.2): the editor's read refused for more than 10,000 sizes (the banner says why).
  readTooLarge: "This category can't be checked until you choose 10,000 or fewer sizes.",
  // Interim (PR 10 PROPOSAL, beyond 12.2): the editor's read loading with no name to say yet.
  loading: "Loading…",
} as const);

function categoryName(name: string): string {
  const trimmed = name.trim();
  return trimmed || "this category";
}

/** One category row of the card (8.3): "Sleeves · 15 products · Sets: shipping policy, store shelf", "… · Uses your store defaults" or, under older group rules, "… · No category settings yet" (PR 11b). Interim (PR 10/11 PROPOSAL). */
export interface CategoryRowWords {
  name: string;
  /** "15 products". */
  products: string;
  /** "Sets: shipping policy, store shelf" (the fields in the order given, the stored shape's), "Uses your store defaults" or "No category settings yet". */
  sets: string;
  /** The three joined with " · ". */
  text: string;
}

/**
 * `olderRulesPresent` (PR 11b, D17): the store still holds older group rules (the summary's three counts). A row with no
 * setting of its own then reads "No category settings yet", since a group rule may decide its products' values.
 */
export function categoryRowWords(
  category: { name: string; productCount: number; setFields: readonly CategoryListingSettingField[] },
  options: { olderRulesPresent: boolean },
): CategoryRowWords {
  const name = category.name.trim() || DRAWER_UNNAMED_CATEGORY;
  const products = `${TEXT_NUMBER.format(category.productCount)} ${productsWord(category.productCount)}`;
  const nothingSet = options.olderRulesPresent
    ? LISTING_SETTINGS_CATEGORY_WORDS.noCategorySettingsYet
    : LISTING_SETTINGS_CATEGORY_WORDS.usesStoreDefaults;
  // In the order given: the server lists a category's own settings in the stored shape's order (`SR` setFields).
  const sets = category.setFields.length === 0
    ? nothingSet
    : `${LISTING_SETTINGS_CATEGORY_WORDS.sets}: ${category.setFields.map((field) => CATEGORY_SETTING_WORDS[field]).join(", ")}`;
  return { name, products, sets, text: `${name} · ${products} · ${sets}` };
}

/** Interim (PR 10 PROPOSAL, beyond 12.2): a category the answer gives no name for (the contract requires one; never expected). */
const DRAWER_UNNAMED_CATEGORY = "Category";

/** "4 products have no Card Shellz category. They use your store defaults." (8.3, `uncategorizedProductCount`); null for none. Interim (PR 10 PROPOSAL). */
export function uncategorizedWords(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 product has no Card Shellz category. It uses your store defaults."
    : `${TEXT_NUMBER.format(count)} products have no Card Shellz category. They use your store defaults.`;
}

/** The editor's title, "Sleeves · 15 products" (8.3). Interim (PR 10 PROPOSAL). */
export function categoryEditorTitleWords(name: string, productCount: number): string {
  return `${name.trim() || DRAWER_UNNAMED_CATEGORY} · ${TEXT_NUMBER.format(productCount)} ${productsWord(productCount)}`;
}

/** "Loading Sleeves…" while the editor's read answers (8.3). Interim (PR 10 PROPOSAL). */
export function loadingCategoryWords(name: string): string {
  const trimmed = name.trim();
  return trimmed ? `Loading ${trimmed}…` : LISTING_SETTINGS_CATEGORY_WORDS.loading;
}

/** The tag beside a value the category sets itself: "Set for Sleeves" (8.3). Interim (PR 10 PROPOSAL). */
export function setForCategoryWords(name: string): string {
  return `Set for ${categoryName(name)}`;
}

/** A card row's [Change], read out with its category (plan 3.4): "Change settings for Sleeves". Interim (PR 10 PROPOSAL). */
export function changeCategoryLabel(name: string): string {
  const trimmed = name.trim();
  return trimmed ? `Change settings for ${trimmed}` : "Change settings";
}

/**
 * "3 products in Sleeves have their own shipping policy." (8.3, 8.4): the
 * line over the "Also clear theirs" box, counted from the detail's
 * `ownValues` entries that hold the field. Interim (PR 10 PROPOSAL).
 */
export function ownValuesLineWords(count: number, name: string, field: CategoryListingSettingField): string {
  const setting = CATEGORY_SETTING_WORDS[field];
  return count === 1
    ? `1 product in ${categoryName(name)} has its own ${setting}.`
    : `${TEXT_NUMBER.format(count)} products in ${categoryName(name)} have their own ${setting}.`;
}

/** "Also clear theirs, so all 15 use this one." (REC:869; R:§3.3 M8 "so all N use this one"). */
export function alsoClearLabelWords(productCount: number): string {
  return productCount === 1
    ? `${LISTING_SETTINGS_CATEGORY_WORDS.alsoClear}, so it uses this one.`
    : `${LISTING_SETTINGS_CATEGORY_WORDS.alsoClear}, so all ${TEXT_NUMBER.format(productCount)} use this one.`;
}

/**
 * W12's product version conflict (8.6): the category's products, or which of
 * them hold their own values, changed since the editor opened. The second
 * sentence is the server's note (`S/application/dropship-listing-category-settings-service.ts`
 * CATALOG_DELAY_NOTE): the category view is cached for up to a minute.
 * Interim (PR 10 PROPOSAL).
 */
export function categoryProductsChangedWords(name: string): string {
  return `The products in ${categoryName(name)} changed. Load the latest and save again. A Card Shellz change can take a minute to show.`;
}

// ---------------------------------------------------------------------------
// The category price check (W7 `category_price`) and "Give these sizes a price" (W8) (PR 10f, plan 9.3, 9.5, 12.2)
// ---------------------------------------------------------------------------

/**
 * Words of the category price in the category editor and its check (PR 10f,
 * plan 9.3). Every one is a proposal (plan 12.2, or "beyond 12.2" where
 * marked), kept here so a later PR changes it in one place. The check's own
 * words are W1's and 10d's (`CHECK_NEW_PRICES_WORDS`, `LISTING_SETTINGS_PRICE_CHECK_WORDS`).
 * None names a code or an id.
 */
export const LISTING_SETTINGS_CATEGORY_PRICE_WORDS = Object.freeze({
  // Interim (PR 10 PROPOSAL): the lead-in to the category's example prices, which are current prices (CC-C23).
  now: "Now:",
  // Interim (PR 10 PROPOSAL, beyond 12.2): the lead-in to the other settings a category price check saves with it (UX-m9).
  alsoSaves: "Also saves",
  // Interim (PR 10 PROPOSAL, beyond 12.2): 422 BULK_TOO_LARGE on a category's price check or its apply (9.4): the category's
  // products' stored text and the check's rows together pass the budget; "choose fewer products" names step 1, not a price.
  tooHeavy: "This category's price check is too big to save at once. Shorten text on its products, or choose fewer of them in step 1.",
  // Interim (PR 10 PROPOSAL, beyond 12.2): 422 TOO_LARGE with no reason on a category's price check (P35; 9.4): the category's
  // products are fixed by step 1, so "choose fewer products" names step 1, as `tooHeavy` does.
  tooManySizes: "This category's price check covers more than 10,000 sizes. Choose fewer of its products in step 1.",
} as const);

/**
 * "Now: Pack of 100 $4.99 · Box of 5 $21.99": the category's example prices as
 * they are now (the detail's `examples`, CC-C23), each size with its price or
 * "No price"; null with no example. Interim (PR 10 PROPOSAL).
 */
export function categoryExamplesWords(examples: ReadonlyArray<{ sizeName: string; priceCents: number | null }>): string | null {
  if (examples.length === 0) return null;
  const parts = examples.map((example) => `${example.sizeName.trim() || "A size"} ${example.priceCents === null ? "no price" : displayListingPrice(example.priceCents)}`);
  return `${LISTING_SETTINGS_CATEGORY_PRICE_WORDS.now} ${parts.join(" · ")}`;
}

/**
 * The line over a category price check for what else the check saves (plan
 * 9.2, UX-m9): "Also saves: shipping policy, store shelf." for the editor's
 * other changed settings (in the stored shape's order given), and "Clears 3
 * products' own shipping policy." per ticked "Also clear theirs" (the count
 * from the clear set shown). Empty with neither. Interim (PR 10 PROPOSAL).
 */
export function categoryCheckAlsoWords(input: {
  fields: readonly CategoryListingSettingField[];
  clears: ReadonlyArray<{ field: CategoryListingSettingField; count: number }>;
}): string[] {
  const lines: string[] = [];
  if (input.fields.length > 0) {
    lines.push(`${LISTING_SETTINGS_CATEGORY_PRICE_WORDS.alsoSaves}: ${input.fields.map((field) => CATEGORY_SETTING_WORDS[field]).join(", ")}.`);
  }
  for (const clear of input.clears) {
    if (clear.count <= 0) continue;
    const setting = CATEGORY_SETTING_WORDS[clear.field];
    lines.push(clear.count === 1 ? `Clears 1 product's own ${setting}.` : `Clears ${TEXT_NUMBER.format(clear.count)} products' own ${setting}.`);
  }
  return lines;
}

/**
 * Words of "Give these sizes a price" (W8, plan 9.3, 9.5). The title is the
 * record's (REC:862, REC:971); "Enter a price like 14.99." and the limit words
 * are the drawer's (`DRAWER_WORDS`); every other one is a proposal (plan 12.2,
 * or "beyond 12.2" where marked), kept here so a later PR changes it in one
 * place. None names a code or an id.
 */
export const LISTING_SETTINGS_SIZE_PRICES_WORDS = Object.freeze({
  // The record's name for the sheet (REC:862, REC:971), the Prices tab's entry button, and the place the step's bar names.
  title: "Give these sizes a price",
  // Interim (PR 10 PROPOSAL): the sheet's intro (9.3).
  intro: "These sizes can't be listed until they have a price.",
  // Interim (PR 10 PROPOSAL, beyond 12.2): the rows' column names (9.3), read out with each box.
  product: "Product",
  size: "Size",
  yourCost: "Your cost",
  exactPrice: "Exact price",
  // Interim (PR 10 PROPOSAL): the footer's Save (9.3).
  save: "Save prices",
  // Interim (PR 10 PROPOSAL): more than 200 typed prices; one Save is one request of at most 200 (D12).
  tooMany: "Save up to 200 prices at a time.",
  // Interim (PR 10 PROPOSAL): no size needs a price (9.3); the entry button hides.
  empty: "Every size has a price.",
  // Interim (PR 10 PROPOSAL, beyond 12.2): while the sheet's pages read (3.7).
  loading: "Checking which sizes need a price…",
  // Interim (PR 10 PROPOSAL, beyond 12.2): the sheet's read failed (3.7); [Try again] reads it again.
  readFailed: "Couldn't check which sizes need a price. Try again.",
  // Interim (PR 10 PROPOSAL): the one list's next page, on every width (9.3).
  loadMore: "Load more",
  // W1's note for a Card Shellz price limit (`CHECK_NEW_PRICES_WORDS.outsideLimit`; 9.5): a row 422 PRICE_OUTSIDE_LIMIT named.
  outsideLimit: "Outside a Card Shellz price limit",
  // The server's own closing words for 422 PRICE_OUTSIDE_LIMIT (`S/application/dropship-listing-size-prices-service.ts` outsideLimits; 9.5).
  enterAllowed: "Enter prices Card Shellz allows.",
  // Interim (PR 10 PROPOSAL): 404 PRICE_NOT_AVAILABLE, a size no longer chosen (9.5).
  notAvailable: "This size isn't chosen any more. Load the list again.",
  // Interim (PR 10 PROPOSAL, beyond 12.2): the attention strip's button for a can't-be-priced line with no product (UX-M2).
  fix: "Fix",
} as const);

/** "● Not saved · 12 prices" (a phone: "● Not saved · 12"): the sheet's footer count (9.3). Interim (PR 10 PROPOSAL). */
export function sizePricesNotSavedWords(count: number, compact: boolean): string {
  const number = TEXT_NUMBER.format(count);
  if (compact) return `● Not saved · ${number}`;
  return `● Not saved · ${number} ${count === 1 ? "price" : "prices"}`;
}

/** "2 sizes left this list and weren't saved.": typed sizes the pages read again no longer list (9.5). Interim (PR 10 PROPOSAL). */
export function sizePricesLeftListWords(count: number): string {
  return count === 1
    ? "1 size left this list and wasn't saved."
    : `${TEXT_NUMBER.format(count)} sizes left this list and weren't saved.`;
}

/**
 * W8's version conflict (9.5): "3 sizes' prices changed in another window.",
 * counted by the server (`conflictCount`), never by its capped list. Interim (PR 10 PROPOSAL).
 */
export function sizePricesConflictWords(conflictCount: number): string {
  return conflictCount === 1
    ? "1 size's price changed in another window."
    : `${TEXT_NUMBER.format(conflictCount)} sizes' prices changed in another window.`;
}

/**
 * 422 PRICE_OUTSIDE_LIMIT (9.5), counted from `sizeCount`, in the server's own
 * form (`S/application/dropship-listing-size-prices-service.ts` outsideLimits):
 * "3 sizes' prices would be outside what Card Shellz allows. Enter prices Card Shellz allows."
 */
export function sizePricesOutsideLimitWords(sizeCount: number): string {
  const sizes = sizeCount === 1 ? "1 size's price" : `${TEXT_NUMBER.format(sizeCount)} sizes' prices`;
  return `${sizes} would be outside what Card Shellz allows. ${LISTING_SETTINGS_SIZE_PRICES_WORDS.enterAllowed}`;
}

/** "Your cost $2.10" under a size in the sheet (9.3); null when the cost isn't known. Interim (PR 10 PROPOSAL). */
export function sizeCostWords(costCents: number | null): string | null {
  return costCents === null ? null : `${LISTING_SETTINGS_SIZE_PRICES_WORDS.yourCost} ${displayListingPrice(costCents)}`;
}

/** A size's Exact price box, read out with its product and size (plan 3.4): "Exact price for Penny Sleeves, Pack of 100". Interim (PR 10 PROPOSAL). */
export function sizePriceBoxLabel(productName: string, sizeName: string): string {
  const product = productName.trim() || UNNAMED_PRODUCT_WORDS;
  const size = sizeName.trim();
  return size ? `${LISTING_SETTINGS_SIZE_PRICES_WORDS.exactPrice} for ${product}, ${size}` : `${LISTING_SETTINGS_SIZE_PRICES_WORDS.exactPrice} for ${product}`;
}

// ---------------------------------------------------------------------------
// Moving older group rules over: the line, the "what changes" sheet and its rows (PR 11b, plan 11.4, D17, D18, D21, D22)
// ---------------------------------------------------------------------------

/**
 * Words of the older-rules line, its [See what changes] and the read-only
 * sheet (PR 11b, plan 5.3, 11.2, 11.4). "older group rules" and "Category
 * settings" are the record's; a size's price reads in the Prices tab's Built
 * from words (D18, D22; the conversion module builds those lines); every
 * other one is a proposal (plan 11.4, or "beyond 11.4" where marked), kept
 * here so a later PR changes it in one place. None names a code, an id or an
 * eBay category number.
 */
export const LISTING_SETTINGS_CONVERSION_WORDS = Object.freeze({
  // Interim (PR 11 PROPOSAL): the line under the attention strip while the store holds older group rules and a chosen
  // product is in a Card Shellz category (D17).
  line: "Your store still has older group rules. Move them over to use category settings.",
  // Interim (PR 11 PROPOSAL): the line when no chosen product is in a Card Shellz category (D17), and while the
  // categories can't be read yet (beyond 11.4: true either way).
  lineNoCategories: "Your store still has older group rules.",
  // Interim (PR 11 PROPOSAL): the line over 10,000 chosen sizes (D17, K7): nothing can be checked, so no button.
  lineTooLarge: "Your store still has older group rules. Choose 10,000 or fewer sizes to move them over.",
  // Interim (PR 11 PROPOSAL): the line's, the Category settings card's and the category editor's button (D17).
  seeWhatChanges: "See what changes",
  // Interim (PR 11 PROPOSAL): the sheet's title (11.2).
  sheetTitle: "Your older group rules",
  // Interim (PR 11 PROPOSAL): while page 0 reads, or a further page (11.2, 3.7).
  loading: "Checking what would change…",
  // Interim (PR 11 PROPOSAL): a read that failed (5xx, refused, or off the contract); [Try again] reads it again (5.3).
  failed: "Couldn't check what would change.",
  // Interim (PR 11 PROPOSAL): 503 DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE, the .ops costs couldn't be read (5.3).
  checkUnavailable: "We couldn't read your costs just now, so we can't check yet. Try again in a minute.",
  // Interim (PR 11 PROPOSAL): 422 TOO_LARGE on the check, as 11.4's apply words say it; the sheet closes and the banner shows.
  tooLarge: "Choose 10,000 or fewer sizes to move them over.",
  // Interim (PR 11 PROPOSAL): the check answers that the store has no older group rules (an old address, or moved meanwhile, 11.5).
  none: "Your store has no older group rules any more.",
  // Interim (PR 11 PROPOSAL): a clean store (5.3); also a store held back by its text alone, whose listings don't change.
  clean: "Moving them over changes nothing in your listings.",
  // Interim (PR 11 PROPOSAL): under the summary line, clean or not (REC:939).
  laterProducts: "Products you choose later use their category's settings or your store defaults, not these rules.",
  // Interim (PR 11 PROPOSAL): the blocks' heading (11.2).
  blockedHeading: "Before you can move them over",
  // Interim (PR 11 PROPOSAL): a size that would lose its price (CUX#3).
  setPrice: "Set a price",
  // Interim (PR 11 PROPOSAL): a listed size that would stop getting stock updates (CMC#3).
  fix: "Fix",
  // Interim (PR 11 PROPOSAL): the store text cap (D9c).
  tooMuchText: "Moving these rules would save more text than your store can keep. Shorten your older description rules in Older settings, then check again.",
  // Interim (PR 11 PROPOSAL): what the rules become (11.2).
  becomesHeading: "They become:",
  // Interim (PR 11 PROPOSAL): the report's heading (11.2); a clean sheet lists the same items without it (beyond 11.4).
  reasonsHeading: "Why some sizes would change",
  // Interim (PR 11 PROPOSAL): the changed sizes' heading (11.2).
  changesHeading: "Sizes that would change",
  // Interim (PR 11 PROPOSAL): the next page of changed sizes (5.2), as the page's other lists say it.
  loadMore: "Load more",
  // Interim (PR 11 PROPOSAL): a page of another plan than page 0's: the pages drop and page 0 is read again (CUX#12); and
  // the move refused because its plan moved (409 CHANGED `settings_changed`) or now has a block the plan shown didn't
  // (422 WOULD_BE_LOST, WOULD_BLOCK_LISTING, the store text cap; beyond 11.4): page 0 is read again and says why (8.3).
  changed: "Something changed since you opened this. Check the list again.",
  // Interim (PR 11 PROPOSAL): a size with no price, in a row's Price line (11.4).
  noPrice: "—",
  // Interim (PR 11 PROPOSAL): a nameless eBay category (a Card Shellz base category with no label, CMC#8).
  cardShellzEbayCategory: "the Card Shellz eBay category",
  // Interim (PR 11 PROPOSAL, beyond 11.4): two nameless eBay categories with different ids.
  anotherCardShellzEbayCategory: "another Card Shellz eBay category",
  // Interim (PR 11 PROPOSAL): a pricing rule line's tie (11.4).
  ruleTie: "two rules that tie",
  // Interim (PR 11 PROPOSAL): a pricing rule line's store default and product price (11.4).
  storeDefaultRule: "Store default",
  thisProductRule: "This product",
  // Interim (PR 11 PROPOSAL): a row's description (11.4).
  descriptionChanges: "Description changes",
  // Interim (PR 11 PROPOSAL): a row's `listable` (11.4).
  becomesUnlistable: "Can be listed → can't be listed",
  becomesListable: "Can't be listed → can be listed",
  stillUnlistable: "Still can't be listed, now because",
  // --- [Move them over] (PR 11d, plan 8.3, 11.4) ---
  // Interim (PR 11 PROPOSAL): the sheet's one write button (8.3).
  moveOver: "Move them over",
  // Interim (PR 11 PROPOSAL): the footer's line while the move is out (8.3 `moving`); the button keeps its label and is off.
  moving: "Moving them over…",
  // Interim (PR 11 PROPOSAL): a confirmed move (`converted`, or this key's `replayed`); it stays until the sheet closes (11.2).
  moved: "Moved over. Category settings can be saved now.",
  // Interim (PR 11 PROPOSAL): `nothing_to_convert`: the store held no older group rules when the move was checked (8.3).
  alreadyMoved: "Your rules have already been moved over.",
  // Interim (PR 11 PROPOSAL): 409 CHANGED `listed_changes_moved`: the same writes, but the listed changes moved (a cost, say; CUX#13).
  listedChangesMoved: "Some changes in the list are different now, for example because a cost changed. Check the list again.",
  // Interim (PR 11 PROPOSAL): 409 IDEMPOTENCY_CONFLICT on the move: page 0 is read again and the next press gets a new key.
  idempotencyConflict: "Something changed since you last tried. Check the list again.",
  // Interim (PR 11 PROPOSAL): 503 CHECK_UNAVAILABLE on the move: the costs couldn't be read, nothing was written (CUX#4).
  checkUnavailableApply: "We couldn't read your costs just now. Nothing was moved. Try again in a minute.",
  // Interim (PR 11 PROPOSAL): 422 TOO_LARGE with no reason on the move: more than 10,000 sizes are chosen now.
  tooLargeApply: "Choose 10,000 or fewer sizes to move them over.",
  // Interim (PR 11 PROPOSAL): an answer that never came back, or a 5xx with no code of ours: [Check again] resends the same key (8.3).
  uncertain: "We couldn't confirm the move.",
  // Interim (PR 11 PROPOSAL, beyond 11.4): a [Check again] answered "not now" keeps its doubt (PLAN10 D7b): the first send may have moved them.
  stillUnconfirmed: "We couldn't confirm the move. Wait a few seconds, then check again.",
  stillUnconfirmedRateLimited: "We couldn't confirm the move. Too many tries in a minute. Wait a moment, then check again.",
  // Interim (PR 11 PROPOSAL, beyond 11.4): 503 BUSY `catalog_changed`: Card Shellz moved a chosen size, product or category
  // between the move's reads and its locks; refused before any write, so the same key may be sent again (11c).
  busyCatalogChanged: "Card Shellz was changing your chosen products just then. Nothing was moved. Try again in a few seconds.",
  // Interim (PR 11 PROPOSAL, beyond 11.4): the footer while a size would lose its price or a listed size would stop updating (D9a, D9b).
  fixFirst: "Fix the sizes listed above first.",
  // Interim (PR 11 PROPOSAL, beyond 11.4): a confirmed move whose re-reads failed; [Reload] reads them again (PLAN10 3.7).
  viewStale: "We couldn't load the latest view.",
  // --- The one-time notice of a system conversion (PR 11e1, plan 9.3, 11.3, 11.4) ---
  // Interim (PR 11 PROPOSAL): the notice's second sentence (REC:939): what products chosen later follow.
  noticeLater: "Products you choose later use their category's settings or your store defaults.",
  // Interim (PR 11 PROPOSAL): a system conversion whose rules decided no category and no product (both counts 0).
  noticeRemoved: "We removed your older group rules. They didn't decide any of your listings.",
  // Interim (PR 11 PROPOSAL): the notice's one button, and its accessible name (plan 9.2).
  gotIt: "Got it",
  gotItName: "Got it, hide this note",
  // Interim (PR 11 PROPOSAL): a [Got it] the server didn't confirm; the line stays and the button works again (9.3).
  noticeFailed: "Couldn't save that. Try again.",
} as const);

/**
 * The one-time notice's first sentence (11.4 `noticeMoved`): what the system
 * moved, by the record's two counts. One count 0 names only the other; one
 * thing in all says "has its own settings" (beyond 11.4, for the grammar).
 * Both counts 0 are `noticeRemoved`'s words, never these. Interim (PR 11
 * PROPOSAL).
 */
export function conversionNoticeMovedWords(categoryCount: number, productCount: number): string {
  const categories = categoryCount === 1 ? "1 category" : `${TEXT_NUMBER.format(categoryCount)} categories`;
  const products = productCount === 1 ? "1 product" : `${TEXT_NUMBER.format(productCount)} products`;
  const subject = categoryCount > 0 && productCount > 0 ? `${categories} and ${products}` : categoryCount > 0 ? categories : products;
  const one = categoryCount + productCount === 1;
  return `We moved your older group rules. ${subject} now ${one ? "has its own settings" : "have their own settings"}. `
    + "Nothing in your listings changed.";
}

/**
 * "These 12 sizes change as listed." (11.4 `changesListed`): the footer of a
 * move that is not clean and that nothing blocks, counted by the server (one
 * size beyond 11.4). Interim (PR 11 PROPOSAL).
 */
export function conversionChangesListedWords(count: number): string {
  return count === 1 ? "This size changes as listed." : `These ${TEXT_NUMBER.format(count)} sizes change as listed.`;
}

/**
 * Why a size can't be listed, one closed entry per `CONVERSION_BLOCKER_CODES`
 * code (CMC#8, plan 11.4): the four fix codes in the Products tab's words
 * (`fixReasonWords`), the rest the plan's. Interim (PR 11 PROPOSAL).
 */
export const CONVERSION_BLOCKER_WORDS: Readonly<Record<ConversionBlockerCode, string>> = Object.freeze({
  no_ebay_category: fixReasonWords("no_ebay_category"),
  size_cannot_be_priced: fixReasonWords("size_cannot_be_priced"),
  own_text_needs_check: fixReasonWords("own_text_needs_check"),
  description_group_conflict: fixReasonWords("description_group_conflict"),
  price_outside_limit: "its price is outside a Card Shellz price limit",
  listing_content_catalog_too_large: "the Card Shellz description is too long",
  listing_content_description_required: "it has no description",
  listing_content_description_too_large: "the description is too long",
});

/** A product in the sheet; one the answer gives no name for reads "A product". */
function conversionProductName(name: string): string {
  return name.trim() || UNNAMED_PRODUCT_WORDS;
}

/** "Penny Sleeves · Pack of 100": a size in the sheet (11.4 row head); a size with no name reads its product alone. Interim (PR 11 PROPOSAL). */
export function conversionSizeWords(productName: string, sizeName: string): string {
  const size = sizeName.trim();
  return size ? `${conversionProductName(productName)} · ${size}` : conversionProductName(productName);
}

/** "Moving them over would change 12 sizes. They're listed below." (11.4 `notClean`). Interim (PR 11 PROPOSAL). */
export function conversionNotCleanWords(count: number): string {
  return count === 1
    ? "Moving them over would change 1 size. It's listed below."
    : `Moving them over would change ${TEXT_NUMBER.format(count)} sizes. They're listed below.`;
}

/** "3 sizes would have no price after the move. …" (11.4 `wouldLosePrice`), counted by the server. Interim (PR 11 PROPOSAL). */
export function conversionWouldLosePriceWords(count: number): string {
  return count === 1
    ? "1 size would have no price after the move. Give it its own price, then check again."
    : `${TEXT_NUMBER.format(count)} sizes would have no price after the move. Give each one its own price, then check again.`;
}

/** "2 sizes you list on eBay would stop getting stock updates after the move. …" (11.4 `wouldBlockListing`). Interim (PR 11 PROPOSAL). */
export function conversionWouldBlockListingWords(count: number): string {
  return count === 1
    ? "1 size you list on eBay would stop getting stock updates after the move. Fix it, then check again."
    : `${TEXT_NUMBER.format(count)} sizes you list on eBay would stop getting stock updates after the move. Fix each one, then check again.`;
}

/** [Set a price] read out with its size (plan 3.4): "Set a price for Penny Sleeves · Pack of 100". Interim (PR 11 PROPOSAL). */
export function conversionSetPriceLabel(productName: string, sizeName: string): string {
  return `${LISTING_SETTINGS_CONVERSION_WORDS.setPrice} for ${conversionSizeWords(productName, sizeName)}`;
}

/** [Fix] read out with its size (plan 3.4): "Fix Penny Sleeves · Pack of 100". Interim (PR 11 PROPOSAL). */
export function conversionFixLabel(productName: string, sizeName: string): string {
  return `${LISTING_SETTINGS_CONVERSION_WORDS.fix} ${conversionSizeWords(productName, sizeName)}`;
}

/** "and 12 more": the items of a list beyond the 100 the answer carries; null for none. Interim (PR 11 PROPOSAL). */
export function conversionMoreWords(count: number): string | null {
  return count > 0 ? `and ${TEXT_NUMBER.format(count)} more` : null;
}

/**
 * The settings a rule becomes, in the contract's order: "price, eBay category,
 * text above and below" (both text parts read as one, 11.4's example).
 * Interim (PR 11 PROPOSAL).
 */
export function conversionSettingsWords(settings: readonly ConversionSetting[]): string {
  const both = settings.includes("textAbove") && settings.includes("textBelow");
  const parts = settings.flatMap((setting) => {
    if (both && setting === "textAbove") return ["text above and below"];
    if (both && setting === "textBelow") return [];
    return [CATEGORY_SETTING_WORDS[setting]];
  });
  return parts.join(", ");
}

/** "Sleeves: price, text above and below" (11.4 `becomesCategory`). Interim (PR 11 PROPOSAL). */
export function conversionBecomesCategoryWords(categoryName: string, settings: readonly ConversionSetting[]): string {
  return `${categoryName.trim() || DRAWER_UNNAMED_CATEGORY}: ${conversionSettingsWords(settings)}`;
}

/** "2 products get their own price: Penny Sleeves, Team Bags" (11.4 `becomesProducts`). Interim (PR 11 PROPOSAL). */
export function conversionBecomesProductsWords(settings: readonly ConversionSetting[], productNames: readonly string[]): string {
  const names = productNames.map(conversionProductName).join(", ");
  const what = conversionSettingsWords(settings);
  return productNames.length === 1
    ? `1 product gets its own ${what}: ${names}`
    : `${TEXT_NUMBER.format(productNames.length)} products get their own ${what}: ${names}`;
}

/**
 * Two rules tie for a product (11.4 `tie`). The price form says the rules
 * "can't price it", not "it has no price": a size that follows the rules
 * (`inherit`) uses its retail price on a tie (`L/dropship-listing-settings-price-words.ts`
 * retailFallbackWords; beyond 11.4). Interim (PR 11 PROPOSAL).
 */
export function conversionTieWords(productName: string, setting: ConversionTieSetting): string {
  const product = conversionProductName(productName);
  return setting === "price"
    ? `Two price rules tie for ${product}, so they can't price it today.`
    : `Two description rules tie for ${product}, so it has no text above or below today.`;
}

/**
 * A chosen product whose copy of its category name differs from its Card
 * Shellz category (11.4 `mismatch`, D8): a copy and another category, a copy
 * and no category, or a category and no copy. A blank copy (a Shopify
 * product type left empty is copied as is) reads as no copy, and a blank
 * category name as the page's unnamed category, so no sentence quotes
 * nothing; a blank copy with no category says only that (beyond 11.4).
 * Interim (PR 11 PROPOSAL).
 */
export function conversionMismatchWords(input: { productName: string; listedAs: string | null; categoryName: string | null }): string {
  const product = conversionProductName(input.productName);
  const copy = input.listedAs !== null && input.listedAs.trim() !== "" ? input.listedAs : null;
  const category = input.categoryName === null ? null : input.categoryName.trim() || DRAWER_UNNAMED_CATEGORY;
  if (copy !== null && category !== null) {
    return `Card Shellz lists ${product} as “${copy}”, but it's in “${category}”. Its settings will follow “${category}”.`;
  }
  if (copy !== null) {
    return `Card Shellz lists ${product} as “${copy}”, but it's in no category. It will use your store defaults.`;
  }
  if (category === null) return `${product} is in no Card Shellz category. It will use your store defaults.`;
  return `Your older rules don't see ${product} as in “${category}”. After the move it follows “${category}”.`;
}

/** A rule for a category name no Card Shellz category has (11.4 `unmatched`, D8). Interim (PR 11 PROPOSAL). */
export function conversionUnmatchedWords(ruleName: string, categoryName: string): string {
  return `Your rule “${ruleName}” is for “${categoryName}”, but no Card Shellz category has that name. It goes away when you move them over.`;
}

/**
 * A rule whose category name two or more Card Shellz categories share (11.4
 * `shared`, D8). One of them that already sets the field keeps its own value
 * (plan 4.A.4; the contract's `shared`), so the rule is written only on the
 * others. Interim (PR 11 PROPOSAL).
 */
export function conversionSharedWords(categoryCount: number, ruleName: string, categoryName: string): string {
  return `${TEXT_NUMBER.format(categoryCount)} Card Shellz categories are called “${categoryName}”. Your rule “${ruleName}” becomes a setting on each of them that doesn't already have its own.`;
}

/** A named-size rule that decides a setting for only some of a product's sizes (11.4 `someSizesOnly`). Interim (PR 11 PROPOSAL). */
export function conversionSomeSizesOnlyWords(ruleName: string, setting: ConversionSetting, productName: string): string {
  return `“${ruleName}” sets the ${CATEGORY_SETTING_WORDS[setting]} for only some sizes of ${conversionProductName(productName)}.`;
}

/** Different rules decide a setting for a product's sizes (11.4 `mixed`). Interim (PR 11 PROPOSAL). */
export function conversionMixedWords(setting: ConversionSetting, productName: string): string {
  return `Different rules set the ${CATEGORY_SETTING_WORDS[setting]} of ${conversionProductName(productName)}'s sizes.`;
}

/** A rule that decides none of the chosen sizes and is written nowhere (11.4 `neverApplies`, D5). Interim (PR 11 PROPOSAL). */
export function conversionNeverAppliesWords(ruleName: string): string {
  return `Your rule “${ruleName}” doesn't decide any of your chosen sizes, so it goes away.`;
}

/**
 * "Kept as they are: 12 exact prices, 3 sizes with their own policies" (11.4
 * `kept`, D6): the per-size rows the move leaves alone, counted by the
 * server per size; null when it keeps none. Interim (PR 11 PROPOSAL).
 */
export function conversionKeptWords(kept: ConversionKept): string | null {
  const parts: string[] = [];
  const count = (value: number) => TEXT_NUMBER.format(value);
  if (kept.exactPrices > 0) parts.push(kept.exactPrices === 1 ? "1 exact price" : `${count(kept.exactPrices)} exact prices`);
  if (kept.catalogPrices > 0) {
    parts.push(kept.catalogPrices === 1 ? "1 size on its retail price" : `${count(kept.catalogPrices)} sizes on their retail price`);
  }
  if (kept.sizePolicies > 0) {
    parts.push(kept.sizePolicies === 1 ? "1 size with its own policies" : `${count(kept.sizePolicies)} sizes with their own policies`);
  }
  if (kept.sizeShelves > 0) {
    parts.push(kept.sizeShelves === 1 ? "1 size with its own store shelf" : `${count(kept.sizeShelves)} sizes with their own store shelf`);
  }
  if (kept.sizeTexts > 0) {
    parts.push(kept.sizeTexts === 1 ? "1 size with its own main text" : `${count(kept.sizeTexts)} sizes with their own main text`);
  }
  return parts.length === 0 ? null : `Kept as they are: ${parts.join(", ")}`;
}

/** "Shipping policy changes" (11.4 row policy): no policy name is in the read model, and the move never writes one (D6). Interim (PR 11 PROPOSAL). */
export function conversionPolicyChangesWords(kind: "shipping" | "return" | "payment"): string {
  const label = kind === "shipping" ? "Shipping" : kind === "return" ? "Return" : "Payment";
  return `${label} policy changes`;
}

/** "Price: $4.99 → $3.99" (11.4 row `price`): each side already the server's cents through `formatCents`, or "—". Interim (PR 11 PROPOSAL). */
export function conversionPriceLineWords(before: string, after: string): string {
  return `Price: ${before} → ${after}`;
}

/** "Built from: {before} → {after}" (11.4 row `priceSource`): each side in the Prices tab's Built from words. Interim (PR 11 PROPOSAL). */
export function conversionBuiltFromLineWords(before: string, after: string): string {
  return `Built from: ${before} → ${after}`;
}

/**
 * A price source class as the dry run compares it (plan 3.2): `rules` split
 * by what the rule starts from. Worded only to tell two Built from sides
 * apart when their words are the same (CUX#2), never for money.
 */
export type ConversionPriceSourceClass =
  | "exact" | "rules_product_cost" | "rules_catalog_retail" | "rules" | "catalog_price" | "last_published" | "retail_fallback" | "none";

/**
 * Words for a source class, used only when the Built from words of two
 * different classes read the same: a rules price whose rule the answer does
 * not name reads "Your pricing rules" for both bases (`builtFromWords`), and
 * 3.2 compares the basis. Interim (PR 11 PROPOSAL, beyond 11.4).
 */
export const CONVERSION_PRICE_SOURCE_CLASS_WORDS: Readonly<Record<ConversionPriceSourceClass, string>> = Object.freeze({
  exact: "an exact price",
  rules_product_cost: "from your cost",
  rules_catalog_retail: "from the retail price",
  rules: "from your pricing rules",
  catalog_price: "the retail price",
  last_published: "the last published price",
  retail_fallback: "the retail price for now",
  none: "no price",
});

/** "Your pricing rules (from your cost)": a Built from side with its class added (CUX#2). Interim (PR 11 PROPOSAL, beyond 11.4). */
export function conversionBuiltFromWithClassWords(builtFrom: string, sourceClass: ConversionPriceSourceClass): string {
  return `${builtFrom} (${CONVERSION_PRICE_SOURCE_CLASS_WORDS[sourceClass]})`;
}

/**
 * A pricing rule as a row names it (11.4 row `pricingRule`), with its recipe
 * in `recipeWords`' words: "Store default (…)", "“Sleeves” (…)" for an older
 * group rule, "This product (…)", "Sleeves category (…)". Interim (PR 11 PROPOSAL).
 */
export function conversionPricingRuleWords(
  rule: { kind: "store_default" | "product" } | { kind: "group" | "category"; name: string },
  recipe: string,
): string {
  switch (rule.kind) {
    case "store_default": return `${LISTING_SETTINGS_CONVERSION_WORDS.storeDefaultRule} (${recipe})`;
    case "product": return `${LISTING_SETTINGS_CONVERSION_WORDS.thisProductRule} (${recipe})`;
    case "group": return `“${rule.name}” (${recipe})`;
    case "category": return `${rule.name} category (${recipe})`;
  }
}

/** "Pricing rule: {before} → {after}" (11.4 row `pricingRule`). Interim (PR 11 PROPOSAL). */
export function conversionPricingRuleLineWords(before: string, after: string): string {
  return `Pricing rule: ${before} → ${after}`;
}

/** "eBay category: Toploaders → Sleeves" (11.4 row `ebayCategory`), by name only. Interim (PR 11 PROPOSAL). */
export function conversionEbayCategoryLineWords(before: string, after: string): string {
  return `eBay category: ${before} → ${after}`;
}

/** The after side when two different eBay categories share a name (CUX#2): "another eBay category also called “Card Sleeves”". Interim (PR 11 PROPOSAL). */
export function conversionEbayCategoryAlsoCalledWords(name: string): string {
  return `another eBay category also called “${name}”`;
}

/** "Store shelf: None → Supplies › Sleeves" (11.4 row `storeShelf`), each side in the drawer's shelf words. Interim (PR 11 PROPOSAL). */
export function conversionStoreShelfLineWords(before: string, after: string): string {
  return `Store shelf: ${before} → ${after}`;
}

/** "Can be listed → can't be listed: no eBay category" (11.4 row `listable`, a size that becomes blocked). Interim (PR 11 PROPOSAL). */
export function conversionBecomesUnlistableWords(reasons: string): string {
  return `${LISTING_SETTINGS_CONVERSION_WORDS.becomesUnlistable}: ${reasons}`;
}

/** "Still can't be listed, now because the description is too long" (11.4 row `listable`, still blocked). Interim (PR 11 PROPOSAL). */
export function conversionStillUnlistableWords(reasons: string): string {
  return `${LISTING_SETTINGS_CONVERSION_WORDS.stillUnlistable} ${reasons}`;
}
