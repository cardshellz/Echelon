/**
 * The Catalog page's steps (design record: docs/DROPSHIP-VENDOR-CATALOG-REDESIGN.md,
 * section 3): which step a location names, each step's path, the rail's ticks
 * and which store the page works on. Pure except for the two storage helpers,
 * which only touch the browser storage they are handed.
 */
import { formatStatus, type DropshipStoreConnectionSummary, type DropshipVendorSelectionRule } from "./dropship-ops-surface";

export const CATALOG_STEPS = ["choose", "setup", "publish"] as const;
export type CatalogStep = (typeof CATALOG_STEPS)[number];

export const CATALOG_STEP_LABELS: Readonly<Record<CatalogStep, string>> = {
  choose: "Choose what to sell",
  setup: "Listing settings",
  publish: "Publish",
};

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

/** Step 2 is done once the store's eBay setup reports nothing missing. Rules, templates and category defaults are optional. */
export function setupStepTick(setup: { missingFields: readonly string[] } | undefined): CatalogStepTick {
  if (!setup) return "unknown";
  return setup.missingFields.length === 0 ? "done" : "todo";
}

/** The line under Listing settings in the rail. */
export function describeSetupStep(tick: CatalogStepTick, storeChosen: boolean): string {
  if (tick === "unknown") return "Checking";
  if (!storeChosen) return "No eBay store";
  return tick === "done" ? "Setup complete" : "Needs setup";
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
