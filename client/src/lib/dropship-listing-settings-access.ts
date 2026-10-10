import type { ListingSettingsSummary } from "@shared/dropship/listing-settings";
import type { ListingAccessAccount } from "./dropship-listing-access";
import {
  DropshipApiError,
  type DropshipEbayListingSetupResponse,
  type DropshipEbayStoreCategoryResponse,
} from "./dropship-ops-surface";

/**
 * Who may change what on the Listing settings step, and the one connection
 * banner it shows (Listing settings PR 7, plan 4.3 and 4.4).
 *
 * Edit rights are decided per writer, because each writer has its own gate on
 * the server; they never come from `summary.access`, which is the listing
 * preview decision (plan D7). The facts are the vendor account, the summary's
 * store status and catalog size, the live eBay setup read, the store shelves
 * read, and a block a save reported during this visit.
 *
 * Every fact that blocks a writer is one of the banner kinds below, so a row
 * that can't be changed always has either a banner or its own line saying
 * why. Pure: no React, no network, no clock.
 */

// ---------------------------------------------------------------------------
// Banner kinds
// ---------------------------------------------------------------------------

/**
 * Every banner, from the widest block to the narrowest: the first that
 * applies is the one shown (R:88, never more than one).
 *
 * The record gives no order (HYPOTHESIS). Kinds that block every change come
 * first, so the banner never says something can still be changed when it
 * can't: a paused vendor whose store is also paused sees the store banner, not
 * the selling-paused one, which locks only prices, eBay categories and
 * descriptions.
 */
export const CONNECTION_BANNER_KINDS = [
  /** The vendor account is closed, lapsed or suspended: nothing can be changed. */
  "account_inactive",
  /** Only Card Shellz pauses a store connection, so only support lifts it. */
  "store_paused",
  /** The store connection is in its grace period ("being disconnected"). */
  "store_disconnecting",
  "store_disconnected",
  /** More than 10,000 sizes chosen: nothing can be checked, every Save is off (R:521). */
  "too_large",
  /** The store is on an eBay site other than eBay US. */
  "other_site",
  /** Selling is paused on the account: prices, eBay categories and descriptions are locked. */
  "selling_paused",
  /** The .ops entitlement is not active: prices, eBay categories and descriptions are locked. */
  "ops_inactive",
  /** eBay needs the vendor to sign in again: choices that read eBay are locked. */
  "sign_in",
  /** eBay refuses Card Shellz access; signing in again won't fix it. */
  "access_denied",
  /** eBay (or the setup read) can't be reached right now. */
  "unreachable",
] as const;
export type ConnectionBannerKind = (typeof CONNECTION_BANNER_KINDS)[number];

export interface ConnectionBanner {
  kind: ConnectionBannerKind;
  /** The code support asks for when eBay refuses access (`access_denied` only); null when none was given. */
  diagnosticReference: string | null;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A read as React Query holds it: the last answer, and the error of the latest attempt (null or absent when none). */
export interface ListingSettingsReadState<T> {
  data?: T | undefined;
  error?: unknown;
}

/** What the decision reads from the live eBay setup answer. */
export type ListingSetupFacts = Pick<DropshipEbayListingSetupResponse, "access" | "revision" | "checks" | "missingFields">;

export interface ListingSettingsAccessInput {
  /** The vendor account from the onboarding read; null while it loads. */
  account: ListingAccessAccount | null;
  /** The summary's store status and catalog size; null until the summary has answered. */
  summary: Pick<ListingSettingsSummary, "storeStatus" | "catalog"> | null;
  /** The live eBay setup read (shared with the old panel and the rail). */
  setup: ListingSettingsReadState<ListingSetupFacts>;
  /** The store shelves read (`GET /api/dropship/ebay/store-categories/:id`). */
  shelves: ListingSettingsReadState<Pick<DropshipEbayStoreCategoryResponse, "categories">>;
  /** A block a save reported during this visit (`bannerFromWriteError`); it stays until a refetch clears it. */
  blocked: ConnectionBanner | null;
}

export interface ListingSettingsRightsInput extends ListingSettingsAccessInput {
  /** A policy change in the open Shipping, Return or Payment editor that isn't saved (C19): the ship-from repair waits for it. */
  unsavedPolicyDraft?: boolean;
}

// ---------------------------------------------------------------------------
// Facts: account, store, codes
// ---------------------------------------------------------------------------

/**
 * Vendor statuses (shared/schema/dropship.schema.ts, dropshipVendorStatusEnum):
 * active and onboarding may change everything; paused may change only what
 * needs no selling (policies and shelves); lapsed, suspended and closed may
 * change nothing (decideDropshipListingConfigAccess). A status this page
 * doesn't know fails closed, as the shared listing access rule does.
 */
const VENDOR_STATUSES_ALLOWED_TO_LIST: ReadonlySet<string> = new Set(["active", "onboarding"]);
const VENDOR_STATUS_PAUSED = "paused";
const ENTITLEMENT_ACTIVE = "active";

/** A store status as the banner it shows; null for a status every writer that needs no eBay sign-in accepts. */
function storeStatusKind(status: string): ConnectionBannerKind | null {
  switch (status) {
    case "connected":
    case "refresh_failed":
      return null;
    case "needs_reauth":
      return "sign_in";
    case "paused":
      return "store_paused";
    case "grace_period":
      return "store_disconnecting";
    case "disconnected":
      return "store_disconnected";
    default:
      // A status this page doesn't know: fail closed. The store connection page shows what it is.
      return "store_disconnected";
  }
}

/** The same store status as a code's context carries it; null when it says nothing a banner can show. */
function contextStatusKind(error: DropshipApiError): ConnectionBannerKind | null {
  const status = error.context?.status;
  if (typeof status !== "string") return null;
  return status === "connected" || status === "refresh_failed" ? null : storeStatusKind(status);
}

/**
 * Codes that name exactly one cause, as the banner they show. Codes the
 * server sends for several causes (vendor paused or closed, .ops lapsed, store
 * paused or gone) are not here: the account, summary and setup reads are read
 * again and the banner follows from them.
 */
const BANNER_BY_CODE: Readonly<Record<string, ConnectionBannerKind | ((error: DropshipApiError) => ConnectionBannerKind | null)>> = {
  // Listing setup (W2, W10) and its read (dropship-listing-config-service.ts).
  DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED: "account_inactive",
  DROPSHIP_LISTING_CONFIG_STORE_PAUSED: "store_paused",
  DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING: "store_disconnecting",
  DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED: "store_disconnected",
  DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE: contextStatusKind,
  DROPSHIP_STORE_CONNECTION_NOT_CONNECTED: contextStatusKind,
  DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED: "sign_in",
  DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED: "sign_in",
  DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED: "access_denied",
  DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED: "other_site",
  DROPSHIP_ENTITLEMENT_REQUIRED: "ops_inactive",
  // Store shelves (W2 shelf, and its read).
  DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED: "sign_in",
  DROPSHIP_EBAY_STORE_CATEGORIES_ACCESS_DENIED: "access_denied",
  DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED: contextStatusKind,
  // eBay category rules (W3).
  DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED: "sign_in",
  DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED: "access_denied",
  DROPSHIP_EBAY_CATEGORY_MARKETPLACE_UNSUPPORTED: "other_site",
  // One size's price (W9).
  DROPSHIP_LISTING_ENTITLEMENT_BLOCKED: "ops_inactive",
  DROPSHIP_LISTING_STORE_BLOCKED: contextStatusKind,
  // The Products and Prices lists (422).
  DROPSHIP_LISTING_SETTINGS_TOO_LARGE: "too_large",
};

/** eBay's support reference is a UUID today; anything else is not shown. */
const DIAGNOSTIC_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

function diagnosticReference(error: DropshipApiError): string | null {
  const reference = error.context?.diagnosticReference;
  if (typeof reference !== "string") return null;
  const trimmed = reference.trim();
  return DIAGNOSTIC_REFERENCE.test(trimmed) ? trimmed : null;
}

/**
 * The banner a refused request names (plan 4.5 `blocked`, and a list's 422),
 * or null when the code names no single cause or is not a block. A null for
 * a blocked save means: read the account, summary and setup again; the
 * banner then follows from them.
 */
export function bannerFromWriteError(error: unknown): ConnectionBanner | null {
  if (!(error instanceof DropshipApiError) || error.code === null) return null;
  const entry = Object.prototype.hasOwnProperty.call(BANNER_BY_CODE, error.code) ? BANNER_BY_CODE[error.code] : undefined;
  if (entry === undefined) return null;
  const kind = typeof entry === "function" ? entry(error) : entry;
  if (kind === null) return null;
  return { kind, diagnosticReference: kind === "access_denied" ? diagnosticReference(error) : null };
}

/** Where the live eBay setup read stands. */
export type ListingSetupReadState<T = ListingSetupFacts> =
  | { state: "loading" }
  | { state: "failed"; banner: ConnectionBanner }
  | { state: "answered"; data: T };

/**
 * The setup read as this step uses it. The latest attempt wins: when a
 * refetch failed, the older answer it replaced is not trusted. A failure that
 * names no block (502, 503, a dropped connection, a server error) is
 * `unreachable`, so the vendor always gets Try again.
 */
export function readListingSetupState<T>(setup: ListingSettingsReadState<T>): ListingSetupReadState<T> {
  if (setup.error !== undefined && setup.error !== null) {
    const named = bannerFromWriteError(setup.error);
    // 502/503 are eBay not answering. Any other unnamed failure is shown the
    // same way, so it gets Try again (HYPOTHESIS: better than a row with no way forward).
    return { state: "failed", banner: named ?? { kind: "unreachable", diagnosticReference: null } };
  }
  if (setup.data !== undefined) return { state: "answered", data: setup.data };
  return { state: "loading" };
}

type ShelvesReadState = { state: "loading" } | { state: "failed"; banner: ConnectionBanner | null } | { state: "answered" };

function readShelvesState(shelves: ListingSettingsAccessInput["shelves"]): ShelvesReadState {
  if (shelves.error !== undefined && shelves.error !== null) return { state: "failed", banner: bannerFromWriteError(shelves.error) };
  return shelves.data !== undefined ? { state: "answered" } : { state: "loading" };
}

/** A read-only setup answer's reason, as the banner it shows. */
function readOnlyReasonKind(reason: unknown): ConnectionBannerKind {
  switch (reason) {
    case "store_paused":
      return "store_paused";
    case "store_disconnecting":
      return "store_disconnecting";
    case "store_disconnected":
      return "store_disconnected";
    default:
      // "vendor_not_active", or a reason this page doesn't know: fail closed with the support banner.
      return "account_inactive";
  }
}

/** Every banner kind that applies now, each with its support reference (if any). */
function activeKinds(input: ListingSettingsAccessInput): Map<ConnectionBannerKind, string | null> {
  const kinds = new Map<ConnectionBannerKind, string | null>();
  const add = (banner: ConnectionBanner | null) => {
    if (!banner) return;
    // Keep the first support reference given for a kind.
    if (!kinds.has(banner.kind) || kinds.get(banner.kind) === null) kinds.set(banner.kind, banner.diagnosticReference);
  };
  const kind = (value: ConnectionBannerKind | null) => add(value ? { kind: value, diagnosticReference: null } : null);

  if (input.account) {
    const status = input.account.status;
    if (status === VENDOR_STATUS_PAUSED) kind("selling_paused");
    else if (!VENDOR_STATUSES_ALLOWED_TO_LIST.has(status)) kind("account_inactive");
    if (input.account.entitlementStatus !== ENTITLEMENT_ACTIVE) kind("ops_inactive");
  }
  if (input.summary) {
    kind(storeStatusKind(input.summary.storeStatus));
    if (input.summary.catalog.state === "too_large") kind("too_large");
  }
  const setup = readListingSetupState(input.setup);
  if (setup.state === "failed") add(setup.banner);
  if (setup.state === "answered") {
    const access = setup.data.access;
    if (access && !access.canEdit) kind(readOnlyReasonKind(access.reason));
    const fulfillment = setup.data.checks?.fulfillment;
    if (fulfillment?.status === "unavailable" && fulfillment.kind === "marketplace_unsupported") kind("other_site");
  }
  const shelves = readShelvesState(input.shelves);
  if (shelves.state === "failed") add(shelves.banner);
  add(input.blocked);
  return kinds;
}

/**
 * The one banner the step shows (R:88), or null. The first kind in
 * CONNECTION_BANNER_KINDS that applies wins.
 */
export function chooseConnectionBanner(input: ListingSettingsAccessInput): ConnectionBanner | null {
  return firstOf(activeKinds(input), CONNECTION_BANNER_KINDS);
}

function firstOf(kinds: Map<ConnectionBannerKind, string | null>, order: readonly ConnectionBannerKind[]): ConnectionBanner | null {
  for (const kind of order) {
    if (kinds.has(kind)) return { kind, diagnosticReference: kinds.get(kind) ?? null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Edit rights
// ---------------------------------------------------------------------------

/**
 * One right per writer and the choices it gates (plan 4.3):
 * - `price` (W1, the store price) and `exactPrice` (W9, one size's price);
 * - `policies` (W2, return and payment policies) and `shipping` (W2, the shipping policy);
 * - `shelfPick` (W2, picking a store shelf) and `shelfNone` (W2, "None");
 * - `shipFrom` (W10, the ship-from repair);
 * - `ebayCategory` (W3) and `description` (W4).
 */
export const LISTING_SETTINGS_RIGHTS = [
  "price", "exactPrice", "policies", "shipping", "shelfPick", "shelfNone", "shipFrom", "ebayCategory", "description",
] as const;
export type ListingSettingsRightName = (typeof LISTING_SETTINGS_RIGHTS)[number];

/**
 * Why a choice can't be changed now; each has its own line, or none when the
 * banner explains it (`banner`) or nothing needs doing (`not_needed`).
 */
export const LISTING_SETTINGS_RIGHT_REASONS = [
  /** The account or the summary is still loading. */
  "loading",
  /** The eBay setup or shelves read is still loading. */
  "checking_ebay",
  /** The banner shown says why. */
  "banner",
  /** eBay needs the vendor to sign in again. */
  "sign_in",
  /** eBay refuses access while a wider banner is shown. */
  "ebay_access_denied",
  /** eBay can't be read right now. */
  "unreachable",
  /** The setup answer carries no revision (a server from before 0728): the page must reload. */
  "reload",
  /** Card Shellz is still setting up shipping for this store. */
  "shipping_setup",
  /** Card Shellz shipping can't be read right now. */
  "shipping_unavailable",
  /** The ship-from repair waits for an unsaved policy change (C19). */
  "save_policy_first",
  /** The ship-from location is already right. */
  "not_needed",
] as const;
export type ListingSettingsRightReason = (typeof LISTING_SETTINGS_RIGHT_REASONS)[number];

export type ListingSettingsRight =
  | { editable: true; reason: null }
  | { editable: false; reason: ListingSettingsRightReason };
export type ListingSettingsEditRights = Readonly<Record<ListingSettingsRightName, ListingSettingsRight>>;

const ALL_RIGHTS: readonly ListingSettingsRightName[] = LISTING_SETTINGS_RIGHTS;
/** W1, W9, W3 and W4 need an active or onboarding vendor and an active .ops entitlement. */
const LISTING_WRITER_RIGHTS: readonly ListingSettingsRightName[] = ["price", "exactPrice", "ebayCategory", "description"];
/** Choices that read eBay: the W2 policies and shelves, W10, and W3's category check. */
const EBAY_RIGHTS: readonly ListingSettingsRightName[] = ["policies", "shipping", "shelfPick", "shelfNone", "shipFrom", "ebayCategory"];
/** Choices that save against the live setup read's revision (W2, W10). */
const SETUP_RIGHTS: readonly ListingSettingsRightName[] = ["policies", "shipping", "shelfPick", "shelfNone", "shipFrom"];

/** Which rights each banner kind takes away. */
const KIND_BLOCKS: Readonly<Record<ConnectionBannerKind, ReadonlySet<ListingSettingsRightName>>> = {
  account_inactive: new Set(ALL_RIGHTS),
  store_paused: new Set(ALL_RIGHTS),
  store_disconnecting: new Set(ALL_RIGHTS),
  store_disconnected: new Set(ALL_RIGHTS),
  too_large: new Set(ALL_RIGHTS),
  other_site: new Set(ALL_RIGHTS),
  selling_paused: new Set(LISTING_WRITER_RIGHTS),
  ops_inactive: new Set(LISTING_WRITER_RIGHTS),
  sign_in: new Set(EBAY_RIGHTS),
  access_denied: new Set(EBAY_RIGHTS),
  // Only the setup read failed: the category picker reads eBay itself and says so.
  unreachable: new Set(SETUP_RIGHTS),
};

const EDITABLE: ListingSettingsRight = Object.freeze({ editable: true, reason: null });
const notEditable = (reason: ListingSettingsRightReason): ListingSettingsRight => ({ editable: false, reason });

const LOCATION_FIELD = "merchantLocationKey";

/**
 * Each writer's right on this step (plan 4.3). A right is editable only
 * when every gate its writer checks would pass; otherwise it carries the
 * reason, widest first: a banner kind, then whatever is still loading, then
 * what the setup read itself says.
 */
export function listingSettingsEditRights(input: ListingSettingsRightsInput): ListingSettingsEditRights {
  const kinds = activeKinds(input);
  const banner = firstOf(kinds, CONNECTION_BANNER_KINDS);
  const setup = readListingSetupState(input.setup);
  const shelves = readShelvesState(input.shelves);

  const decide = (right: ListingSettingsRightName): ListingSettingsRight => {
    const blocking = CONNECTION_BANNER_KINDS.find((kind) => kinds.has(kind) && KIND_BLOCKS[kind].has(right));
    if (blocking) return notEditable(reasonForKind(blocking, banner));
    if (!input.account || !input.summary) return notEditable("loading");
    if (!SETUP_RIGHTS.includes(right)) return EDITABLE;
    return setupRight(right);
  };

  const setupRight = (right: ListingSettingsRightName): ListingSettingsRight => {
    if (setup.state === "loading") return notEditable("checking_ebay");
    // A failed read is always a kind above; this keeps a new kind from ever unlocking a save.
    if (setup.state === "failed") return notEditable("unreachable");
    const data = setup.data;
    // A read-only answer is always a kind above; kept for the same reason.
    if (data.access && !data.access.canEdit) return notEditable("banner");
    if (!hasRevision(data.revision)) return notEditable("reload");
    // C1: a save needs eBay's live lists, so an answer that didn't read eBay can't be saved from.
    if (data.checks !== undefined && data.checks.ebay !== "checked") return notEditable("unreachable");
    switch (right) {
      case "policies":
      case "shelfNone":
        return EDITABLE;
      case "shipping":
        return shippingRight(data);
      case "shelfPick":
        if (shelves.state === "loading") return notEditable("checking_ebay");
        // A shelves refusal that names a block is a kind above; anything else is eBay not answering.
        if (shelves.state === "failed") return notEditable("unreachable");
        return EDITABLE;
      case "shipFrom": {
        const shipping = shippingRight(data);
        if (!shipping.editable) return shipping;
        if (!data.missingFields.includes(LOCATION_FIELD)) return notEditable("not_needed");
        if (input.unsavedPolicyDraft === true) return notEditable("save_policy_first");
        return EDITABLE;
      }
      default:
        return EDITABLE;
    }
  };

  const rights = {} as Record<ListingSettingsRightName, ListingSettingsRight>;
  for (const right of LISTING_SETTINGS_RIGHTS) rights[right] = decide(right);
  return Object.freeze(rights);
}

function hasRevision(revision: unknown): boolean {
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0;
}

/** The shipping policy needs Card Shellz shipping read for this answer (a server from before the checks always read it). */
function shippingRight(data: ListingSetupFacts): ListingSettingsRight {
  const fulfillment = data.checks?.fulfillment;
  if (fulfillment === undefined || fulfillment.status === "checked") return EDITABLE;
  if (fulfillment.status === "unavailable" && fulfillment.kind === "setup_incomplete") return notEditable("shipping_setup");
  // `marketplace_unsupported` is the other-site banner; a passing outage or an unchecked answer can be tried again.
  return notEditable("shipping_unavailable");
}

/**
 * The reason a banner kind gives a row. Sign-in and eBay-unreachable rows keep
 * their own line even under their banner (R:500, R:502). Every other kind is
 * explained by the banner, which is always that kind: a kind that locks a row
 * is never outranked by one that doesn't, except eBay access, which then
 * gets its own line.
 */
function reasonForKind(kind: ConnectionBannerKind, banner: ConnectionBanner | null): ListingSettingsRightReason {
  if (kind === "sign_in") return "sign_in";
  if (kind === "unreachable") return "unreachable";
  if (banner?.kind === kind) return "banner";
  return kind === "access_denied" ? "ebay_access_denied" : "banner";
}
