import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import type { ListingSettingsPolicyKind, ListingSettingsSummary } from "@shared/dropship/listing-settings";
import type { CatalogStep } from "@/lib/dropship-catalog-steps";
import { ebayListingSetupQueryOptions } from "@/lib/dropship-ebay-listing-query-sync";
import type { ListingAccessAccount } from "@/lib/dropship-listing-access";
import { listingSettingsProductQueryOptions } from "@/lib/dropship-listing-settings";
import {
  bannerFromWriteError,
  chooseConnectionBanner,
  listingSettingsEditRights,
  type ConnectionBanner,
  type ListingSettingsAccessInput,
  type ListingSettingsEditRights,
  type ListingSettingsRight,
} from "@/lib/dropship-listing-settings-access";
import type { AttentionAction } from "@/lib/dropship-listing-settings-attention";
import {
  STORE_DEFAULT_LABELS,
  countOlderSettingsDrafts,
  describeListingSettingsBar,
  isDraftDirty,
} from "@/lib/dropship-listing-settings-drafts";
import { drawerSearch, drawerTargetFromSearch, firstSizeNeedingFix, type DrawerTarget } from "@/lib/dropship-listing-settings-drawer";
import { isStoreDefaultPolicyEditor, policyEditorBase } from "@/lib/dropship-listing-settings-store-requests";
import type { DropshipEbayStoreCategoryResponse, DropshipStoreConnectionSummary } from "@/lib/dropship-ops-surface";
import { CatalogActionBar, type CatalogNextStepAction } from "../catalog/CatalogActionBar";
import { useUnsavedDrafts } from "../catalog/UnsavedChangesGuard";
import { AttentionStrip } from "./AttentionStrip";
import { ConnectionBannerView } from "./ConnectionBanner";
import { DescriptionDefaultRow } from "./DescriptionDefaultRow";
import { EbayCategoryDefaultRow } from "./EbayCategoryDefaultRow";
import { useListingSettingsDrafts } from "./ListingSettingsDraftsProvider";
import { ListingSettingsHeader } from "./ListingSettingsHeader";
import { ListingSettingsTabs, type ListingSettingsProductTarget, type ListingSettingsTabsRequest } from "./ListingSettingsTabs";
import { PolicyDefaultRow, liveSetup } from "./PolicyDefaultRow";
import { PriceDefaultRow } from "./PriceDefaultRow";
import { ProductDrawer } from "./ProductDrawer";
import { ShelfDefaultRow } from "./ShelfDefaultRow";
import { ShipFromRepairNote } from "./ShipFromRepairNote";
import { StoreDefaultsCard } from "./StoreDefaultsCard";

/**
 * The Listing settings step (Listing settings PR 7, plan 3A and 4.1): the
 * header, at most one connection banner, "Needs your attention", the Store
 * defaults card with one editor per row, the Products and Prices tabs, and
 * the product drawer. The page mounts it above "Older settings" for a
 * launch-ready eBay store, keyed by the store, so another store is another
 * step.
 *
 * It decides nothing about saving. Each row owns its writer; this shell reads
 * the facts every row shares (the live eBay setup, the summary, the store
 * shelves), turns them into edit rights and the one banner, and routes the
 * strip's buttons and the address (`?product=&size=`) to the right place.
 */

/** The onboarding read the page and portal shell share; its vendor status and entitlement gate every writer. */
const ONBOARDING_QUERY_KEY = ["/api/dropship/onboarding/state"] as const;

/** A read as React Query holds it, narrowed to what the step uses (a `UseQueryResult` fits). */
export interface ListingSettingsStepRead<T> {
  data?: T | undefined;
  error?: unknown;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
}

/** The page's pending-save counter (D10); every row's callback type is this shape. */
export interface ListingSettingsStepSaveCallbacks {
  disabled?: boolean;
  /** Throws when a listing action is running; nothing is sent then. */
  onSaveStarted: () => void;
  onSaveSettled: () => void;
}

export interface ListingSettingsStepProps {
  storeConnectionId: number;
  storeName: string;
  /** The vendor's eBay stores that are not disconnected (`countEbayStores`). */
  ebayStoreCount: number;
  /** The vendor account from the onboarding read; null while it loads. */
  account: ListingAccessAccount | null;
  /** The page's summary read (shared with the rail). */
  summary: ListingSettingsStepRead<ListingSettingsSummary>;
  /** The page's store shelves read (`GET /api/dropship/ebay/store-categories/:id`). */
  shelves: ListingSettingsStepRead<Pick<DropshipEbayStoreCategoryResponse, "categories">>;
  saveCallbacks: ListingSettingsStepSaveCallbacks;
  /** After any confirmed save: the page marks the step 3 preview stale and reads the summary again (D9). */
  onSettingsSaved: () => void;
  /** Leaves for another catalog step; the page asks first when changes aren't saved. */
  goToStep: (step: CatalogStep) => void;
}

/**
 * How many of the vendor's eBay stores the "These settings are for <Store>
 * only" line counts: every eBay store that is not disconnected, including
 * one that needs a sign-in (C28), from the raw list rather than the
 * launch-ready one.
 */
export function countEbayStores(connections: readonly Pick<DropshipStoreConnectionSummary, "platform" | "status">[]): number {
  return connections.filter((connection) => connection.platform === "ebay" && connection.status !== "disconnected").length;
}

/** The edit right of a policy row: Shipping needs Card Shellz shipping read; Return and Payment do not (plan 4.3). */
export function policyRowRight(rights: ListingSettingsEditRights, kind: ListingSettingsPolicyKind): ListingSettingsRight {
  return kind === "shipping" ? rights.shipping : rights.policies;
}

/** The tabs' next request: a new key every time, so asking for the same filter twice applies it twice. */
export function nextTabsRequest(previous: ListingSettingsTabsRequest | null, show: ListingSettingsTabsRequest["show"]): ListingSettingsTabsRequest {
  return { key: (previous?.key ?? 0) + 1, show };
}

/**
 * The store status and catalog size the rights read, from the last summary
 * answer. A failed refetch keeps the older answer: the store status and
 * selection size it reported still stand until a newer answer says otherwise.
 */
function summaryFacts(summary: ListingSettingsSummary | undefined): ListingSettingsAccessInput["summary"] {
  return summary ? { storeStatus: summary.storeStatus, catalog: summary.catalog } : null;
}

export function ListingSettingsStep(props: ListingSettingsStepProps) {
  const { storeConnectionId, storeName, account, summary, shelves, saveCallbacks, onSettingsSaved, goToStep } = props;
  const queryClient = useQueryClient();
  const drafts = useListingSettingsDrafts();
  // The same key as the old setup panel and the rail, so the three share one eBay read.
  const setupQuery = useQuery(ebayListingSetupQueryOptions(storeConnectionId));
  const [location, navigate] = useLocation();
  const search = useSearch();
  const drawerTarget = useMemo(() => drawerTargetFromSearch(search), [search]);

  // A block a save reported during this visit (plan 4.3). It stays until the vendor checks again
  // from the banner, or until they leave the step (the step is keyed by store and unmounts).
  const [blocked, setBlocked] = useState<ConnectionBanner | null>(null);
  const [tabsRequest, setTabsRequest] = useState<ListingSettingsTabsRequest | null>(null);
  const defaultsRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const drawerOpener = useRef<HTMLElement | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The callbacks below read the latest reads through refs, so rows get stable functions.
  const latest = useRef({ summary, setupQuery, shelves, location, search });
  latest.current = { summary, setupQuery, shelves, location, search };

  const accessInput: ListingSettingsAccessInput = {
    account,
    summary: summaryFacts(summary.data),
    setup: { data: setupQuery.data, error: setupQuery.error },
    shelves: { data: shelves.data, error: shelves.error },
    blocked,
  };
  const banner = chooseConnectionBanner(accessInput);
  const rights = listingSettingsEditRights({
    ...accessInput,
    // C19: the ship-from repair reloads the setup an open policy editor works on, so it waits.
    unsavedPolicyDraft: isStoreDefaultPolicyEditor(drafts.draft?.editor) && isDraftDirty(drafts.draft),
  });

  /** When a refusal names no single cause, the account, summary and setup are read again, and the banner follows from them. */
  const rereadAccess = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [...ONBOARDING_QUERY_KEY] });
    void latest.current.summary.refetch();
  }, [queryClient]);

  // W2 and W10 rows name the banner themselves and read the setup again on their own.
  const onSetupBlocked = useCallback((named: ConnectionBanner | null) => {
    if (named) setBlocked(named);
    else rereadAccess();
  }, [rereadAccess]);

  // W1, W3, W4 and W9 pass the refusal on, and so do the lists when they are refused as too large.
  const onWriteBlocked = useCallback((error: unknown) => {
    const named = bannerFromWriteError(error);
    if (named) {
      setBlocked(named);
      return;
    }
    rereadAccess();
    void latest.current.setupQuery.refetch();
  }, [rereadAccess]);

  const retryConnection = useCallback(() => {
    setBlocked(null);
    void latest.current.setupQuery.refetch();
    void latest.current.shelves.refetch();
  }, []);

  /** Opens the drawer by putting it in the address, so Back closes it and a link opens it (R:690-692). */
  const openDrawer = useCallback((target: DrawerTarget) => {
    const active = typeof document === "undefined" ? null : document.activeElement;
    drawerOpener.current = active instanceof HTMLElement ? active : null;
    const { location: path, search: query } = latest.current;
    navigate(`${path}${drawerSearch(query, target)}`);
  }, [navigate]);

  /** Closing takes the drawer off the address in place, so Back doesn't open it again. */
  const closeDrawer = useCallback(() => {
    const { location: path, search: query } = latest.current;
    navigate(`${path}${drawerSearch(query, null)}`, { replace: true });
  }, [navigate]);

  const openProduct = useCallback((target: ListingSettingsProductTarget) => {
    openDrawer(target.productVariantId === undefined
      ? { productId: target.productId }
      : { productId: target.productId, productVariantId: target.productVariantId });
  }, [openDrawer]);

  /**
   * "<Product> can't be listed: a size can't be priced." [Fix] opens the
   * drawer on that size (plan 2F): the product is read first, under the
   * drawer's own key, so the drawer opens from that answer.
   */
  const openProductFix = useCallback(async (productId: number, fix: Extract<AttentionAction, { kind: "open_product" }>["fix"]) => {
    if (fix !== "size_cannot_be_priced") {
      openDrawer({ productId });
      return;
    }
    let productVariantId: number | null = null;
    try {
      const detail = await queryClient.fetchQuery(listingSettingsProductQueryOptions(storeConnectionId, productId));
      productVariantId = firstSizeNeedingFix(detail, fix);
    } catch {
      // Deliberate: the read's failure is not lost. The query keeps the error under the drawer's
      // key, and the drawer, opened on the product alone, shows what went wrong with Try again.
      productVariantId = null;
    }
    if (!mounted.current) return;
    openDrawer(productVariantId === null ? { productId } : { productId, productVariantId });
  }, [openDrawer, queryClient, storeConnectionId]);

  /** [Choose] opens the first missing policy's editor (R:508); a row that can't be changed is shown with its reason. */
  const openPolicyEditor = useCallback((kind: ListingSettingsPolicyKind) => {
    const live = liveSetup(latest.current.setupQuery);
    if (policyRowRight(rights, kind).editable && live !== null) {
      drafts.open(kind, STORE_DEFAULT_LABELS[kind], policyEditorBase(live, kind));
    }
    defaultsRef.current?.querySelector<HTMLElement>(`[data-field="${kind}"]`)?.scrollIntoView?.({ block: "center" });
  }, [drafts, rights]);

  const onAttention = useCallback((action: Exclude<AttentionAction, { kind: "link" }>) => {
    switch (action.kind) {
      case "open_store_default":
        openPolicyEditor(action.field);
        return;
      case "show_products":
        setTabsRequest((previous) => nextTabsRequest(previous, action.show));
        tabsRef.current?.scrollIntoView?.({ block: "start" });
        return;
      case "open_product":
        void openProductFix(action.productId, action.fix);
        return;
    }
  }, [openPolicyEditor, openProductFix]);

  const saved = summary.data?.storeDefaults ?? null;
  const goToStep1 = () => goToStep("choose");

  return (
    <div data-testid="listing-settings-step">
      <ListingSettingsHeader storeName={storeName} ebayStoreCount={props.ebayStoreCount} />
      {banner && (
        <ConnectionBannerView
          banner={banner}
          storeName={storeName}
          onRetry={retryConnection}
          onGoToStep1={goToStep1}
          retrying={setupQuery.isFetching || shelves.isFetching}
        />
      )}
      <AttentionStrip
        summary={summary}
        bannerShown={banner !== null}
        storeName={storeName}
        onAction={onAttention}
        onRetry={() => void summary.refetch()}
      />
      <div ref={defaultsRef} className="mt-4">
        {/* The record's order (R:90): Price; Shipping, with the ship-from note under it; Return; Payment; eBay category; Store shelf; Description. */}
        <StoreDefaultsCard>
          <PriceDefaultRow
            storeConnectionId={storeConnectionId}
            saved={saved?.price ?? null}
            right={rights.price}
            saveCallbacks={saveCallbacks}
            onSaved={onSettingsSaved}
            onBlocked={onWriteBlocked}
          />
          <PolicyDefaultRow
            kind="shipping"
            setup={setupQuery}
            savedPolicyId={saved?.shippingPolicy.policyId ?? null}
            right={rights.shipping}
            onSaved={onSettingsSaved}
            saveCallbacks={saveCallbacks}
            onBlocked={onSetupBlocked}
          />
          <ShipFromRepairNote
            setup={setupQuery}
            right={rights.shipFrom}
            onSaved={onSettingsSaved}
            saveCallbacks={saveCallbacks}
            onBlocked={onSetupBlocked}
          />
          <PolicyDefaultRow
            kind="return"
            setup={setupQuery}
            savedPolicyId={saved?.returnPolicy.policyId ?? null}
            right={rights.policies}
            onSaved={onSettingsSaved}
            saveCallbacks={saveCallbacks}
            onBlocked={onSetupBlocked}
          />
          <PolicyDefaultRow
            kind="payment"
            setup={setupQuery}
            savedPolicyId={saved?.paymentPolicy.policyId ?? null}
            right={rights.policies}
            onSaved={onSettingsSaved}
            saveCallbacks={saveCallbacks}
            onBlocked={onSetupBlocked}
          />
          <EbayCategoryDefaultRow
            storeConnectionId={storeConnectionId}
            saved={saved?.ebayCategory ?? null}
            right={rights.ebayCategory}
            saveCallbacks={saveCallbacks}
            onSaved={onSettingsSaved}
            onBlocked={onWriteBlocked}
          />
          <ShelfDefaultRow
            setup={setupQuery}
            shelves={shelves}
            rightPick={rights.shelfPick}
            rightNone={rights.shelfNone}
            onSaved={onSettingsSaved}
            saveCallbacks={saveCallbacks}
            onBlocked={onSetupBlocked}
          />
          <DescriptionDefaultRow
            storeConnectionId={storeConnectionId}
            saved={saved?.description ?? null}
            right={rights.description}
            saveCallbacks={saveCallbacks}
            onSaved={onSettingsSaved}
            onBlocked={onWriteBlocked}
          />
        </StoreDefaultsCard>
      </div>
      <div ref={tabsRef} className="mt-6">
        <ListingSettingsTabs
          storeConnectionId={storeConnectionId}
          summary={summary.data}
          // Off while too large, also under a wider banner that outranks the too-large one.
          readOnly={banner?.kind === "too_large" || blocked?.kind === "too_large"}
          onOpenProduct={openProduct}
          onGoToStep1={goToStep1}
          request={tabsRequest}
          // A list refused as too large shows the banner even before the summary says so (plan 4.4).
          onTooLarge={onWriteBlocked}
        />
      </div>
      <ProductDrawer
        storeConnectionId={storeConnectionId}
        storeName={storeName}
        target={drawerTarget}
        rights={rights}
        setup={{ data: setupQuery.data, error: setupQuery.error }}
        summaryRecipe={summary.data?.storeDefaults.price.recipe}
        onClose={closeDrawer}
        saveCallbacks={saveCallbacks}
        onSaved={onSettingsSaved}
        onGoToStep1={goToStep1}
        onGoToStep3={() => goToStep("publish")}
        onBlocked={onWriteBlocked}
        returnFocusTo={drawerOpener}
      />
    </div>
  );
}

/**
 * The bottom bar on the Listing settings step (R:597): "All saved",
 * "Not saved · N changes in <place>", "Not saved · changes in Older settings"
 * or "Saving…", read out as it changes. Other steps keep their own bar.
 */
export function ListingSettingsActionBar({ next, saving }: { next: CatalogNextStepAction | null; saving: boolean }) {
  const { draft } = useListingSettingsDrafts();
  const guardDrafts = useUnsavedDrafts();
  const summary = describeListingSettingsBar({ draft, olderDraftCount: countOlderSettingsDrafts(guardDrafts), saving });
  return <CatalogActionBar live summary={summary} next={next} />;
}
