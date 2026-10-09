/**
 * The Catalog page's steps (design record: docs/DROPSHIP-VENDOR-CATALOG-REDESIGN.md,
 * section 3): which step a location names, each step's path, the rail's ticks
 * and which store the page works on. Pure except for the two storage helpers,
 * which only touch the browser storage they are handed.
 */
import type { ListingSettingsPolicyKind, ListingSettingsSummary } from "@shared/dropship/listing-settings";
import { formatStatus, type DropshipStoreConnectionSummary, type DropshipVendorSelectionRule } from "./dropship-ops-surface";

export const CATALOG_STEPS = ["choose", "setup", "publish"] as const;
export type CatalogStep = (typeof CATALOG_STEPS)[number];

export const CATALOG_STEP_LABELS: Readonly<Record<CatalogStep, string>> = {
  choose: "Choose what to sell",
  setup: "Listing settings",
  publish: "Publish",
};

/**
 * When saved Listing settings reach eBay. Saving never publishes, but a later
 * send uses whatever is saved then: a queued listing is rebuilt from the
 * current settings when it is sent (dropship-listing-intent-refresh.ts), and
 * the stock catch-up sends a full listing from the current preview
 * (dropship-quantity-publication-catchup.provider.ts). So the page never says
 * live listings change only when the vendor publishes.
 */
export const LISTING_SETTINGS_SEND_TIMING =
  "Saved settings go to eBay the next time a listing is sent: when you publish it, or when Card Shellz updates it.";

/**
 * Narrow screens show these in the rail so all three steps fit without scrolling.
 * Step 2 stays "Set up": a bare "Settings" would read like the portal's own
 * Settings page in the menu.
 */
export const CATALOG_STEP_SHORT_LABELS: Readonly<Record<CatalogStep, string>> = {
  choose: "Choose",
  setup: "Set up",
  publish: "Publish",
};

/** Launch is eBay-only: stores on other platforms are listed but cannot be chosen (design section 1). */
export const CATALOG_SUPPORTED_PLATFORM = "ebay";

/** `/catalog/<step>` at the end of a path, with or without the `/dropship-portal` prefix. */
const CATALOG_STEP_LOCATION = /\/catalog\/([a-z]+)\/?$/;

/** Portal-relative path of a step; callers wrap it with `dropshipPortalPath`. */
export function catalogStepPath(step: CatalogStep): string {
  return `/catalog/${step}`;
}

/** The step a location names, or null when it names none (the page then redirects to Choose). */
export function catalogStepFromLocation(pathname: string): CatalogStep | null {
  const candidate = CATALOG_STEP_LOCATION.exec(pathname)?.[1];
  return isCatalogStep(candidate) ? candidate : null;
}

/** `/catalog`, `/catalog/` or `/catalog/<anything>`: the addresses the page itself serves. */
const CATALOG_LOCATION = /\/catalog(?:\/[^/]*)?\/?$/;

/**
 * True when the location is the Catalog page's own (with or without a valid
 * step). Only these are sent to Choose; a location elsewhere means the vendor
 * is leaving the page, and redirecting it would take them back.
 */
export function isCatalogLocation(pathname: string): boolean {
  return CATALOG_LOCATION.test(pathname);
}

export function nextCatalogStep(step: CatalogStep): CatalogStep | null {
  return CATALOG_STEPS[CATALOG_STEPS.indexOf(step) + 1] ?? null;
}

function isCatalogStep(value: string | undefined): value is CatalogStep {
  return (CATALOG_STEPS as readonly string[]).includes(value ?? "");
}

/** `unknown` while the data a tick needs is loading or failed to load: the rail then claims nothing. */
export type CatalogStepTick = "done" | "todo" | "unknown";

/**
 * Step 1 is done once any active include rule exists. The catalog summary's
 * selected count replaces this when it ships (design PR 4).
 */
export function chooseStepTick(
  rules: readonly Pick<DropshipVendorSelectionRule, "action" | "isActive">[] | undefined,
): CatalogStepTick {
  if (!rules) return "unknown";
  return rules.some((rule) => rule.action === "include" && rule.isActive !== false) ? "done" : "todo";
}

export interface ListingSettingsRailInput {
  /** False until the vendor's stores have loaded. */
  storesLoaded: boolean;
  /** An eBay store is chosen. */
  storeChosen: boolean;
  summary:
    | { status: "loading" }
    | { status: "failed" }
    | { status: "ready"; rail: ListingSettingsSummary["rail"] };
  /**
   * The newest live eBay setup check for the store, or null before there is
   * one. It runs on Listing settings only, and is the one source for what only
   * eBay can tell: a saved policy gone or no longer fitting Card Shellz
   * shipping, and the ship-from location.
   */
  liveSetup: {
    missingFields: readonly string[];
    /** Whether the vendor may change these settings; absent from servers before it was reported. */
    access?: { canEdit: boolean };
    /** Which checks ran for this answer; absent from servers before they were reported, which always ran both. */
    checks?: {
      ebay: "checked" | "not_checked";
      fulfillment:
        | { status: "checked" }
        | { status: "unavailable"; kind: "temporary" | "setup_incomplete" | "marketplace_unsupported" }
        | { status: "not_checked" };
    };
  } | null;
}

export interface ListingSettingsRailLine {
  tick: CatalogStepTick;
  line: string;
  /** The check failed, so the rail offers "Try again". */
  retry: boolean;
}

const POLICY_WORDS: Readonly<Record<ListingSettingsPolicyKind, string>> = { shipping: "shipping", return: "return", payment: "payment" };
/** The live setup check's fields for each policy (dropship-ebay-listing-setup-service.ts, buildListingSetupResult). */
const LIVE_POLICY_FIELDS: Readonly<Record<ListingSettingsPolicyKind, readonly string[]>> = {
  shipping: ["fulfillmentPolicyId", "fulfillmentPolicyCompatibility"],
  return: ["returnPolicyId"],
  payment: ["paymentPolicyId"],
};
const POLICY_ORDER: readonly ListingSettingsPolicyKind[] = ["shipping", "return", "payment"];
const LIVE_LOCATION_FIELD = "merchantLocationKey";
const KNOWN_LIVE_FIELDS: ReadonlySet<string> = new Set([...Object.values(LIVE_POLICY_FIELDS).flat(), LIVE_LOCATION_FIELD]);

/**
 * The tick and line under Listing settings in the rail (design 3.7). It names
 * the first thing to do, in the order it has to be done: reconnect eBay, the
 * store's policies, where items ship from, then products that need a fix. The
 * summary says what saved settings show; a live eBay check, when there is one,
 * adds what only eBay can tell, so the rail never says "All set" over a
 * problem the setup panel shows.
 */
export function describeListingSettingsRail(input: ListingSettingsRailInput): ListingSettingsRailLine {
  if (!input.storesLoaded) return { tick: "unknown", line: "Checking…", retry: false };
  if (!input.storeChosen) return { tick: "todo", line: "No eBay store", retry: false };
  if (input.summary.status === "loading") return { tick: "unknown", line: "Checking…", retry: false };
  if (input.summary.status === "failed") return { tick: "unknown", line: "Couldn't check", retry: true };
  const { rail } = input.summary;
  const todo = (line: string): ListingSettingsRailLine => ({ tick: "todo", line, retry: false });
  if (rail.state === "reconnect_store") return todo("Reconnect eBay");
  if (rail.state === "too_many_sizes") return todo("Too many sizes to check");
  // A view-only store (paused, disconnected, account not active) has nothing
  // the vendor can do here, so no policy line and no retry.
  if (input.liveSetup?.access?.canEdit === false) return { tick: "unknown", line: "View only", retry: false };
  const checks = input.liveSetup?.checks;
  // Card Shellz doesn't list on this eBay site, which blocks every listing,
  // so it comes before anything else the vendor could do.
  if (checks?.fulfillment.status === "unavailable" && checks.fulfillment.kind === "marketplace_unsupported") {
    return todo("Contact support");
  }
  // While Card Shellz shipping can't be read, the shipping policy can't be
  // chosen and the ship-from location can't be fixed, so the rail does not
  // ask for either; it says why once the other policies are done.
  const shippingUnchecked = checks !== undefined && checks.fulfillment.status !== "checked";
  const live = new Set(input.liveSetup?.missingFields ?? []);
  const policyMissing = (kind: ListingSettingsPolicyKind) =>
    rail.missingPolicy === kind || LIVE_POLICY_FIELDS[kind].some((field) => live.has(field));
  const policy = POLICY_ORDER.find((kind) => !(shippingUnchecked && kind === "shipping") && policyMissing(kind));
  if (policy) return todo(`Choose a ${POLICY_WORDS[policy]} policy`);
  if (shippingUnchecked && policyMissing("shipping")) return uncheckedShippingLine(checks.fulfillment);
  // A missing policy the summary names is always one of the three, so this is only a broken answer's fallback.
  if (rail.state === "choose_policy" && rail.missingPolicy === null) return todo("Choose your eBay policies");
  if (live.has(LIVE_LOCATION_FIELD) && !shippingUnchecked) return todo("Ship-from location needs updating");
  // A problem the live check names that this rail does not know yet still keeps "All set" off.
  if ([...live].some((field) => !KNOWN_LIVE_FIELDS.has(field))) return todo("Finish your eBay setup");
  if (rail.state === "products_need_fix") {
    return todo(rail.productsNeedingFix === 1 ? "1 product needs a fix" : `${rail.productsNeedingFix} products need a fix`);
  }
  // A live answer that could not check eBay or Card Shellz shipping found no
  // problem only because those checks did not run, so it cannot vouch either.
  if (shippingUnchecked) return uncheckedShippingLine(checks.fulfillment);
  if (checks && checks.ebay !== "checked") return { tick: "unknown", line: "Couldn't check", retry: true };
  return { tick: "done", line: "All set", retry: false };
}

/**
 * Why Card Shellz shipping wasn't checked, for the rail. Only a passing outage
 * is worth a retry; a store whose shipping Card Shellz is still setting up
 * waits on Card Shellz.
 */
function uncheckedShippingLine(
  fulfillment: NonNullable<NonNullable<ListingSettingsRailInput["liveSetup"]>["checks"]>["fulfillment"],
): ListingSettingsRailLine {
  if (fulfillment.status === "unavailable" && fulfillment.kind === "setup_incomplete") {
    return { tick: "unknown", line: "Card Shellz is finishing setup", retry: false };
  }
  return { tick: "unknown", line: "Couldn't check", retry: true };
}

export interface CatalogActionBarContent {
  summary: string;
  /** The step the bar's one button opens, or null when the step's own panel holds its action. */
  next: { step: CatalogStep; label: string; disabled: boolean } | null;
}

/**
 * The bar's button names the next step by its own title. A bare "Publish"
 * would look like it publishes; "Next: Publish" only moves to that step.
 */
function nextStepLabel(step: CatalogStep): string {
  return `Next: ${CATALOG_STEP_LABELS[step]}`;
}

/**
 * What the bar at the bottom of each step says and offers. Choose cannot
 * continue with nothing selected; Publish keeps its preview and queue buttons
 * in its own panel until readiness moves into the bar (design PR 9).
 */
export function describeCatalogActionBar(input: {
  step: CatalogStep;
  /** Null while the selection loads. */
  selectedCount: number | null;
  /** Null when no eBay store is ready. */
  storeName: string | null;
}): CatalogActionBarContent {
  const selected = input.selectedCount === null ? "Loading your selection" : `${input.selectedCount} selected`;
  if (input.step === "choose") {
    return {
      summary: selected,
      next: { step: "setup", label: nextStepLabel("setup"), disabled: !input.selectedCount },
    };
  }
  if (input.step === "setup") {
    return {
      summary: input.storeName ? `Settings for ${input.storeName}` : "No eBay store ready",
      next: { step: "publish", label: nextStepLabel("publish"), disabled: false },
    };
  }
  return { summary: input.storeName ? `${selected} · publishing to ${input.storeName}` : selected, next: null };
}

export interface CatalogStoreOption {
  storeConnectionId: number;
  name: string;
  platform: string;
  /** Only eBay stores can be chosen at launch. */
  selectable: boolean;
}

/** The store's name as the vendor knows it. */
export function catalogStoreName(
  connection: Pick<DropshipStoreConnectionSummary, "externalDisplayName" | "shopDomain" | "platform">,
): string {
  return connection.externalDisplayName || connection.shopDomain || `${formatStatus(connection.platform)} store name pending`;
}

/** The launch-ready stores the rail lists, in the order the server returned them. */
export function catalogStoreOptions(connections: readonly DropshipStoreConnectionSummary[]): CatalogStoreOption[] {
  return connections
    .filter((connection) => connection.launchReady)
    .map((connection) => ({
      storeConnectionId: connection.storeConnectionId,
      name: catalogStoreName(connection),
      platform: connection.platform,
      selectable: connection.platform === CATALOG_SUPPORTED_PLATFORM,
    }));
}

/**
 * The store the page works on: the preferred one (chosen now, or remembered)
 * while it can still be chosen, else the first that can, else none.
 */
export function chooseCatalogStore(options: readonly CatalogStoreOption[], preferredStoreConnectionId: number | null): number | null {
  const selectable = options.filter((option) => option.selectable);
  if (preferredStoreConnectionId !== null && selectable.some((option) => option.storeConnectionId === preferredStoreConnectionId)) {
    return preferredStoreConnectionId;
  }
  return selectable[0]?.storeConnectionId ?? null;
}

/** Browser storage key for the store a member last chose. A convenience only: the choice is re-checked on every render. */
export function catalogStoreStorageKey(memberId: string): string {
  return `dropship.catalog.store:${memberId}`;
}

const STORED_STORE_ID = /^[1-9]\d{0,9}$/;

/** The member's last chosen store id, or null. Storage can be missing or throw (private mode, blocked site data). */
export function readRememberedCatalogStore(storage: Pick<Storage, "getItem"> | null, memberId: string | null): number | null {
  if (!storage || !memberId) return null;
  try {
    const stored = storage.getItem(catalogStoreStorageKey(memberId));
    if (stored === null || !STORED_STORE_ID.test(stored)) return null;
    const storeConnectionId = Number(stored);
    return Number.isSafeInteger(storeConnectionId) ? storeConnectionId : null;
  } catch {
    // Unreadable storage only loses the convenience; the first eBay store is used instead.
    return null;
  }
}

export function rememberCatalogStore(storage: Pick<Storage, "setItem"> | null, memberId: string | null, storeConnectionId: number): void {
  if (!storage || !memberId || !Number.isSafeInteger(storeConnectionId) || storeConnectionId <= 0) return;
  try {
    storage.setItem(catalogStoreStorageKey(memberId), String(storeConnectionId));
  } catch {
    // Deliberately best effort: the choice still applies for this visit; only the next visit falls back to the first eBay store.
  }
}

/** The page's browser storage, or null where reading it throws. */
export function catalogBrowserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
