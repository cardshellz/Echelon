import { useEffect, useMemo, useRef, useState } from "react";
import { NotSavedBadge, useUnsavedDraft } from "./catalog/UnsavedChangesGuard";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, ChevronsUpDown, Clock3, MapPinned, RefreshCw, Save, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  postJson,
  putJson,
  queryErrorCode,
  queryErrorMessage,
  DropshipApiError,
  type DropshipEbayFulfillmentPolicyOption,
  type DropshipEbayListingSetupOption,
  type DropshipEbayListingSetupResponse,
  type ReplaceDropshipEbayListingSetupInput,
} from "@/lib/dropship-ops-surface";
import {
  ListingSetupRequestKeys,
  buildEbayListingSetupSaveRequest,
  buildEbayShipFromRepairRequest,
  listingSetupReadOnlyMessage,
  listingSetupSaveErrorMessage,
  listingSetupSavedOption,
  listingSetupShippingCheckNotice,
  listingSetupShippingChecked,
  listingSetupShowsSavedValuesOnly,
} from "@/lib/dropship-ebay-listing-setup";
import { fulfillmentPolicyOptionDescription } from "@/lib/dropship-ebay-policy-assignment";
import { cn } from "@/lib/utils";
import {
  ebayListingSetupQueryOptions,
  refreshEbayListingConfiguration,
  synchronizeSavedEbayListingSetup,
} from "@/lib/dropship-ebay-listing-query-sync";
import { EbayStoreCategoryAuthorizationRecovery } from "./EbayStoreCategoryAuthorizationRecovery";

const EMPTY_SELECTION: ReplaceDropshipEbayListingSetupInput = {
  fulfillmentPolicyId: "",
  returnPolicyId: "",
  paymentPolicyId: "",
};

export function EbayListingSetupPanel({
  onConfigurationChange,
  storeConnectionId,
  storeName,
}: {
  onConfigurationChange: () => void;
  storeConnectionId: number;
  storeName: string;
}) {
  const queryClient = useQueryClient();
  const setupQuery = useQuery(ebayListingSetupQueryOptions(storeConnectionId));
  const [draft, setDraft] = useState<ReplaceDropshipEbayListingSetupInput>(EMPTY_SELECTION);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveAuthorizationError, setSaveAuthorizationError] = useState<unknown>(null);
  const [savedMessage, setSavedMessage] = useState("");
  const [savedStoreToRefresh, setSavedStoreToRefresh] = useState<number | null>(null);
  const inFlight = useRef(false);
  // One key per save attempt; a retry of the same choices reuses it, so a
  // save whose answer was lost is never applied twice.
  const saveKeys = useRef(new ListingSetupRequestKeys("ebay-setup"));
  const repairKeys = useRef(new ListingSetupRequestKeys("ebay-ship-from"));
  // The answer the draft was last built from, so a newer one keeps the
  // vendor's unsaved picks (a refetch, or a reload after a revision conflict).
  const draftBase = useRef<DropshipEbayListingSetupResponse | null>(null);

  useEffect(() => {
    const next = setupQuery.data;
    if (!next) return;
    const previous = draftBase.current;
    draftBase.current = next;
    setDraft((current) => rebaseEbayListingSetupDraft(previous, current, next));
  }, [setupQuery.data]);

  useEffect(() => {
    setSaveError("");
    setSaveAuthorizationError(null);
    setSavedMessage("");
    setSavedStoreToRefresh(null);
  }, [storeConnectionId]);

  // A policy Card Shellz filled in because eBay offers only one is a suggestion
  // until saved, so it counts as an unsaved change and is marked as such.
  const suggestedFields = useMemo(
    () => setupQuery.data ? suggestedListingSetupFields(setupQuery.data, draft) : new Set<ListingSetupPolicyField>(),
    [draft, setupQuery.data],
  );
  // Only a picked policy counts: an empty field holds nothing to lose. While a
  // confirmed save is refreshing, the draft is what was saved and the fields
  // are locked.
  const unsavedPolicy = useMemo(
    () => savedStoreToRefresh === null && setupQuery.data !== undefined
      && listingSetupHasUnsavedPolicy(setupQuery.data, draft),
    [draft, savedStoreToRefresh, setupQuery.data],
  );
  useUnsavedDraft(`listing-setup:${storeConnectionId}`, "eBay listing setup", unsavedPolicy);
  // The ship-from repair reloads the setup, so it waits for a policy the
  // vendor picked. A Card Shellz suggestion does not hold it up: the vendor
  // can't undo it, and the reload fills it in again.
  const unsavedPick = useMemo(
    () => unsavedPolicy && setupQuery.data !== undefined
      && LISTING_SETUP_POLICY_FIELDS.some((field) => draft[field] !== ""
        && draft[field] !== (setupQuery.data?.selection[field] ?? "")
        && !suggestedFields.has(field)),
    [draft, setupQuery.data, suggestedFields, unsavedPolicy],
  );
  // A save sends only the policies that changed (the server keeps the rest),
  // so any one changed policy can be saved, even while another field is empty.
  const canSave = setupQuery.data !== undefined && listingSetupHasUnsavedPolicy(setupQuery.data, draft);
  const verificationAvailable = setupQuery.isSuccess && !setupQuery.isFetching;
  const readOnlyMessage = setupQuery.data ? listingSetupReadOnlyMessage(setupQuery.data, storeName) : null;
  const shippingCheckNotice = setupQuery.data ? listingSetupShippingCheckNotice(setupQuery.data) : null;
  // Without eBay's lists (a read-only view) each field shows the saved policy only.
  const savedValuesOnly = setupQuery.data ? listingSetupShowsSavedValuesOnly(setupQuery.data) : false;
  // The repair needs Card Shellz shipping (it names the warehouse eBay ships
  // from), so it is offered only when that was read for this answer.
  const offerShipFromRepair = Boolean(
    setupQuery.data
      && setupQuery.data.missingFields.includes("merchantLocationKey")
      && listingSetupShippingChecked(setupQuery.data)
      && !savedValuesOnly
      && !readOnlyMessage,
  );

  async function saveSetup(): Promise<void> {
    if (!verificationAvailable || !canSave || inFlight.current || savedStoreToRefresh !== null) return;
    if (!setupQuery.data || readOnlyMessage) return;
    inFlight.current = true;
    setSaving(true);
    setSaveError("");
    setSaveAuthorizationError(null);
    setSavedMessage("");
    try {
      const attempt = { revision: setupQuery.data.revision ?? null, draft };
      const body = buildEbayListingSetupSaveRequest(setupQuery.data, draft, saveKeys.current.keyFor(attempt));
      const result = await putJson<DropshipEbayListingSetupResponse>(
        `/api/dropship/ebay/listing-setup/${storeConnectionId}`,
        body,
      );
      saveKeys.current.settled();
      setDraft(buildEbayListingSetupDraft(result));
      setSavedStoreToRefresh(result.storeConnectionId);
      onConfigurationChange();
      await refreshAfterConfirmedSave(() => synchronizeSavedEbayListingSetup(queryClient, result));
    } catch (caught) {
      setSaveError(listingSetupSaveErrorMessage(caught, "eBay listing setup could not be saved."));
      setSaveAuthorizationError(
        ["DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED"].includes(queryErrorCode(caught) ?? "")
          ? caught
          : null,
      );
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  /**
   * W10: points this store's listings at the Card Shellz-managed eBay location
   * again. Changes no policy, and reloads the setup, so it waits until an
   * unsaved policy change is saved or undone rather than drop it.
   */
  async function repairShipFrom(): Promise<void> {
    if (!verificationAvailable || inFlight.current || savedStoreToRefresh !== null || unsavedPick) return;
    if (!setupQuery.data || readOnlyMessage) return;
    inFlight.current = true;
    setSaving(true);
    setSaveError("");
    setSaveAuthorizationError(null);
    setSavedMessage("");
    try {
      const attempt = { revision: setupQuery.data.revision ?? null };
      const result = await postJson<DropshipEbayListingSetupResponse>(
        `/api/dropship/ebay/listing-setup/${storeConnectionId}/ship-from/repair`,
        buildEbayShipFromRepairRequest(setupQuery.data, repairKeys.current.keyFor(attempt)),
      );
      repairKeys.current.settled();
      setSavedStoreToRefresh(result.storeConnectionId);
      onConfigurationChange();
      await refreshAfterConfirmedSave(
        () => synchronizeSavedEbayListingSetup(queryClient, result),
        "Ship-from location updated. Queue any listing that failed for it again.",
      );
    } catch (caught) {
      setSaveError(listingSetupSaveErrorMessage(caught, "The ship-from location could not be updated.", "ship_from_repair"));
      setSaveAuthorizationError(
        ["DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED"].includes(queryErrorCode(caught) ?? "")
          ? caught
          : null,
      );
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  async function refreshAfterConfirmedSave(
    refresh: () => Promise<void>,
    confirmedMessage = "Store defaults saved and listing policies updated. Generate a new preview to use them.",
  ): Promise<void> {
    try {
      await refresh();
      setSavedStoreToRefresh(null);
      setSaveError("");
      setSavedMessage(confirmedMessage);
    } catch {
      setSaveError("Your store defaults were saved, but listing policies could not be refreshed. Retry the refresh below; your saved changes will not be submitted again.");
    }
  }

  async function retrySavedSetupRefresh(): Promise<void> {
    if (savedStoreToRefresh === null || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setSaveError("");
    try {
      // A later edit in another tab may have replaced the saved defaults. Reload
      // both views; replaying the original save response would restore stale UI.
      await refreshAfterConfirmedSave(() => refreshEbayListingConfiguration(queryClient, savedStoreToRefresh));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <section className="mt-5 overflow-hidden rounded-md border border-zinc-200 bg-white">
      <div className="flex flex-col gap-3 border-b border-zinc-200 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">eBay listing setup{unsavedPolicy && <NotSavedBadge />}</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Choose your store&apos;s default eBay business policies. Card Shellz controls the physical inventory location used for dropship fulfillment.
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Your fulfillment policy can set buyer-facing shipping charges, but its handling time, destinations, and services must fit the capabilities below.
          </p>
        </div>
        {setupQuery.data && (
          <Badge
            variant="outline"
            className={setupQuery.data.complete && verificationAvailable
              ? "w-fit border-emerald-200 bg-emerald-50 text-emerald-800"
              : "w-fit border-amber-300 bg-amber-50 text-amber-900"}
          >
            {listingSetupStatusLabel(setupQuery.data, { verificationAvailable, readOnly: readOnlyMessage !== null })}
          </Badge>
        )}
      </div>

      {setupQuery.isLoading ? (
        <div className="grid gap-3 p-4 md:grid-cols-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : setupQuery.error && !setupQuery.data ? (
        <ListingSetupError
          error={setupQuery.error}
          storeConnectionId={storeConnectionId}
          storeName={storeName}
        />
      ) : setupQuery.data ? (
        <div className="p-4">
          {setupQuery.error && !saveError && (
            <div role="alert" className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <ListingSetupError error={setupQuery.error} storeConnectionId={storeConnectionId} storeName={storeName} />
              <p className="mt-1">Showing the last loaded setup. Use Refresh options to try again.</p>
            </div>
          )}
          {setupQuery.data.complete && verificationAvailable && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>The Card Shellz-managed inventory destination and your default eBay business policies are ready.</span>
            </div>
          )}
          <div className="mb-4 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
            <span className="text-zinc-500">Marketplace</span>
            <span className="ml-2 font-medium">{setupQuery.data.marketplaceId}</span>
          </div>
          {readOnlyMessage && (
            <div role="status" className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              {readOnlyMessage}
            </div>
          )}
          {shippingCheckNotice && (
            <div role="status" className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <p>{shippingCheckNotice.message}</p>
              <p className="mt-1 text-xs text-amber-900">Reference: {shippingCheckNotice.reference}</p>
            </div>
          )}
          <FulfillmentCapabilitySummary setup={setupQuery.data} />
          <div className="grid gap-4 md:grid-cols-2">
            <ListingSetupField
              disabled={saving || savedStoreToRefresh !== null || readOnlyMessage !== null}
              label="Fulfillment policy"
              placeholder={savedValuesOnly ? "None saved" : "Choose a fulfillment policy"}
              searchPlaceholder="Search fulfillment policies..."
              emptyMessage="No matching fulfillment policies."
              savedValuesOnly={savedValuesOnly}
              options={savedValuesOnly
                ? listingSetupSavedOption(setupQuery.data, "fulfillmentPolicyId")
                : fulfillmentPolicyDisplayOptions(setupQuery.data.options.fulfillmentPolicies)}
              value={draft.fulfillmentPolicyId}
              suggested={suggestedFields.has("fulfillmentPolicyId")}
              onValueChange={(value) => setDraft((current) => ({ ...current, fulfillmentPolicyId: value }))}
            />
            <ListingSetupField
              disabled={saving || savedStoreToRefresh !== null || readOnlyMessage !== null}
              label="Return policy"
              placeholder={savedValuesOnly ? "None saved" : "Choose a return policy"}
              searchPlaceholder="Search return policies..."
              emptyMessage="No matching return policies."
              savedValuesOnly={savedValuesOnly}
              options={savedValuesOnly
                ? listingSetupSavedOption(setupQuery.data, "returnPolicyId")
                : setupQuery.data.options.returnPolicies}
              value={draft.returnPolicyId}
              suggested={suggestedFields.has("returnPolicyId")}
              onValueChange={(value) => setDraft((current) => ({ ...current, returnPolicyId: value }))}
            />
            <ListingSetupField
              disabled={saving || savedStoreToRefresh !== null || readOnlyMessage !== null}
              label="Payment policy"
              placeholder={savedValuesOnly ? "None saved" : "Choose a payment policy"}
              searchPlaceholder="Search payment policies..."
              emptyMessage="No matching payment policies."
              savedValuesOnly={savedValuesOnly}
              options={savedValuesOnly
                ? listingSetupSavedOption(setupQuery.data, "paymentPolicyId")
                : setupQuery.data.options.paymentPolicies}
              value={draft.paymentPolicyId}
              suggested={suggestedFields.has("paymentPolicyId")}
              onValueChange={(value) => setDraft((current) => ({ ...current, paymentPolicyId: value }))}
            />
          </div>

          {offerShipFromRepair && (
            <div className="mt-4 flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between">
              <span>
                Card Shellz needs to update where your items ship from. It changes no policy.
                {unsavedPick && <span className="mt-1 block text-xs">Save or undo your policy change first.</span>}
              </span>
              <Button
                type="button"
                variant="outline"
                className="w-fit"
                disabled={!verificationAvailable || saving || savedStoreToRefresh !== null || unsavedPick}
                onClick={() => void repairShipFrom()}
              >
                {saving ? "Updating ship-from location" : "Update ship-from location"}
              </Button>
            </div>
          )}
          {hasMissingVendorOptions(setupQuery.data) && (
            <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              eBay did not return every required compatible business policy. Create or update the policy in eBay Seller Hub, then refresh these options.
            </div>
          )}
          {saveError && (
            <div role="alert" className="mt-4 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
              {saveError}
              {savedStoreToRefresh !== null && (
                <Button type="button" variant="outline" className="mt-3 flex gap-2"
                  disabled={saving} onClick={() => void retrySavedSetupRefresh()}>
                  <RefreshCw className="h-4 w-4" />
                  {saving ? "Refreshing saved policies" : "Refresh saved policies"}
                </Button>
              )}
              {saveAuthorizationError !== null && (
                <ListingSetupError
                  error={saveAuthorizationError}
                  storeConnectionId={storeConnectionId}
                  storeName={storeName}
                />
              )}
            </div>
          )}
          {savedMessage && (
            <div role="status" className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
              {savedMessage}
            </div>
          )}
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              disabled={saving || setupQuery.isFetching || savedStoreToRefresh !== null}
              onClick={() => {
                setSaveError("");
                setSaveAuthorizationError(null);
                setSavedMessage("");
                setupQuery.refetch();
              }}
            >
              <RefreshCw className="h-4 w-4" />
              {setupQuery.isFetching ? "Refreshing options" : "Refresh options"}
            </Button>
            <Button
              type="button"
              className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
              disabled={!verificationAvailable || saving || savedStoreToRefresh !== null || !canSave || readOnlyMessage !== null}
              onClick={saveSetup}
            >
              <Save className="h-4 w-4" />
              {saving ? savedStoreToRefresh !== null ? "Updating listing policies" : "Saving setup" : "Save eBay listing setup"}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function ListingSetupError({
  error,
  storeConnectionId,
  storeName,
}: {
  error: unknown;
  storeConnectionId: number;
  storeName: string;
}) {
  const permissionRequired = queryErrorCode(error) === "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED";
  const accessDenied = queryErrorCode(error) === "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED";
  const context = error instanceof DropshipApiError ? error.context : null;
  const reference = typeof context?.diagnosticReference === "string" ? context.diagnosticReference : null;
  return (
    <div className="m-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
      <div className="font-medium">
        {permissionRequired
          ? "eBay listing authorization needs attention."
          : accessDenied ? "eBay listing access needs support."
          : "eBay listing setup is unavailable."}
      </div>
      <div className="mt-1">
        {permissionRequired
          ? "The eBay authorization has expired or been revoked. Reauthorize the connected store below to continue."
          : accessDenied ? "eBay denied Inventory or Account access. Do not keep reauthorizing; Card Shellz support must check application permissions and seller API eligibility. This error does not by itself mean your store disconnected."
          : queryErrorMessage(error, "The connected eBay store did not return its listing setup.")}
      </div>
      {permissionRequired && (
        <>
          <EbayStoreCategoryAuthorizationRecovery
            error={error}
            storeConnectionId={storeConnectionId}
            storeName={storeName}
          />
        </>
      )}
      {reference && <details className="mt-2 text-xs">
        <summary className="cursor-pointer">Support details</summary>
        <p>Reference: {reference}</p>
        {typeof context?.resource === "string" && <p>Resource: {context.resource}</p>}
        {typeof context?.status === "number" && <p>Provider status: {context.status}</p>}
      </details>}
    </div>
  );
}

function FulfillmentCapabilitySummary({
  setup,
}: {
  setup: DropshipEbayListingSetupResponse;
}) {
  const capability = setup.fulfillmentCapability;
  // Not read for this answer (read-only, or Card Shellz shipping unavailable,
  // which the notice above explains).
  if (!capability) return null;
  const carriers = [...new Set(
    capability.supportedServices.map((service) => service.carrier),
  )];
  return (
    <div className="mb-4 rounded-md border border-violet-200 bg-violet-50/50 p-4">
      <div className="font-medium text-zinc-950">Card Shellz fulfillment capabilities</div>
      <p className="mt-1 text-xs text-zinc-600">
        These are operational limits, not shipping-price rules. You remain responsible for the charges configured in your eBay policy.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <CapabilityFact
          icon={<Clock3 className="h-4 w-4" />}
          label="Handling time"
          value={`At least ${capability.requiredHandlingTimeBusinessDays} business day${capability.requiredHandlingTimeBusinessDays === 1 ? "" : "s"}`}
        />
        <CapabilityFact
          icon={<MapPinned className="h-4 w-4" />}
          label="Direct destinations"
          value={capability.destinationCoverageComplete
            ? "United States, territories, and military mail"
            : `${capability.destinationRegions.length} configured US regions`}
        />
        <CapabilityFact
          icon={<Truck className="h-4 w-4" />}
          label="Allowed carriers"
          value={carriers.join(", ") || "None configured"}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {capability.supportedServices.map((service) => (
          <Badge
            key={service.ebayServiceCode}
            variant="outline"
            className="border-violet-200 bg-white text-violet-900"
          >
            {service.carrier}: {service.serviceName}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function CapabilityFact({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-violet-100 bg-white p-3">
      <span className="mt-0.5 text-violet-700">{icon}</span>
      <span>
        <span className="block text-xs text-zinc-500">{label}</span>
        <span className="block text-sm font-medium text-zinc-900">{value}</span>
      </span>
    </div>
  );
}

export type ListingSetupDisplayOption = DropshipEbayListingSetupOption & {
  disabled?: boolean;
  description?: string;
};

function ListingSetupField({
  disabled,
  emptyMessage,
  label,
  onValueChange,
  options,
  placeholder,
  savedValuesOnly,
  searchPlaceholder,
  suggested,
  value,
}: {
  disabled: boolean;
  emptyMessage: string;
  label: string;
  onValueChange: (value: string) => void;
  options: readonly ListingSetupDisplayOption[];
  placeholder: string;
  /** The options are the saved policy only, not eBay's list, so an empty list says nothing about eBay. */
  savedValuesOnly: boolean;
  searchPlaceholder: string;
  /** Card Shellz filled this in because eBay offers only one choice; it is not saved yet. */
  suggested: boolean;
  value: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-2">
        <ListingSetupCombobox
          disabled={disabled}
          ariaLabel={label}
          emptyMessage={emptyMessage}
          onValueChange={onValueChange}
          options={options}
          placeholder={placeholder}
          searchPlaceholder={searchPlaceholder}
          value={value}
        />
      </div>
      {suggested && <p className="mt-1 text-xs text-amber-800">Suggested · not saved</p>}
      {options.length === 0 && !savedValuesOnly && (
        <p className="mt-1 text-xs text-amber-800">No eligible options were returned by eBay.</p>
      )}
    </div>
  );
}

export function ListingSetupCombobox({
  ariaLabel,
  disabled = false,
  emptyMessage,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  value,
}: {
  ariaLabel: string;
  disabled?: boolean;
  emptyMessage: string;
  onValueChange: (value: string) => void;
  options: readonly ListingSetupDisplayOption[];
  placeholder: string;
  searchPlaceholder: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.id === value) ?? null;
  return (
    <Popover
      open={disabled ? false : open}
      onOpenChange={(nextOpen) => {
        if (!disabled) setOpen(nextOpen);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={disabled ? false : open}
          aria-label={ariaLabel}
          disabled={disabled || options.length === 0}
          className="h-10 w-full justify-between gap-2 px-3 font-normal"
        >
          <span className={cn("min-w-0 truncate text-left", !selected && "text-muted-foreground")}>
            {selected?.name ?? placeholder}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0"
      >
        <Command shouldFilter>
          <CommandInput
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <CommandList className="max-h-64 overflow-y-auto overscroll-contain">
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={`${option.name} ${option.id}`}
                  disabled={option.disabled}
                  onSelect={() => {
                    onValueChange(option.id);
                    setOpen(false);
                  }}
                  className="min-h-11"
                >
                  <Check
                    className={cn(
                      "h-4 w-4 shrink-0",
                      option.id === value ? "opacity-100" : "opacity-0",
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{option.name}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{option.id}</span>
                    {option.description && (
                      <span className={cn(
                        "mt-0.5 block text-xs",
                        option.disabled ? "text-rose-700" : "text-emerald-700",
                      )}>
                        {option.description}
                      </span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The draft a loaded answer starts from: each saved policy that eBay still
 * offers (and, for shipping, that fits or could not be checked), else the
 * only choice eBay offers. Without eBay's lists it is the saved selection.
 */
export function buildEbayListingSetupDraft(
  setup: DropshipEbayListingSetupResponse,
): ReplaceDropshipEbayListingSetupInput {
  if (listingSetupShowsSavedValuesOnly(setup)) {
    return {
      fulfillmentPolicyId: setup.selection.fulfillmentPolicyId ?? "",
      returnPolicyId: setup.selection.returnPolicyId ?? "",
      paymentPolicyId: setup.selection.paymentPolicyId ?? "",
    };
  }
  return {
    fulfillmentPolicyId: savedFulfillmentPolicyOrOnly(
      setup.selection.fulfillmentPolicyId,
      setup.options.fulfillmentPolicies,
    ),
    returnPolicyId: selectedOrOnly(setup.selection.returnPolicyId, setup.options.returnPolicies),
    paymentPolicyId: selectedOrOnly(setup.selection.paymentPolicyId, setup.options.paymentPolicies),
  };
}

/** Choosable shipping policies: only those checked and found to fit Card Shellz shipping. */
function fulfillmentPolicyDisplayOptions(
  policies: readonly DropshipEbayFulfillmentPolicyOption[],
): ListingSetupDisplayOption[] {
  return policies.map((policy) => ({
    ...policy,
    disabled: !policy.compatible,
    description: fulfillmentPolicyOptionDescription(policy),
  }));
}

/**
 * The saved shipping policy stays when eBay still offers it and it fits, or
 * when it could not be checked (Card Shellz shipping unavailable): not being
 * able to check it is no reason to drop it. Only a checked, fitting policy is
 * ever filled in on the vendor's behalf.
 */
function savedFulfillmentPolicyOrOnly(
  savedId: string | null,
  policies: readonly DropshipEbayFulfillmentPolicyOption[],
): string {
  const saved = savedId ? policies.find((policy) => policy.id === savedId) : undefined;
  if (saved && (saved.compatible || saved.compatibilityChecked === false)) return saved.id;
  return selectedOrOnly(null, policies.filter((policy) => policy.compatible));
}

type ListingSetupPolicyField = keyof ReplaceDropshipEbayListingSetupInput;

const LISTING_SETUP_POLICY_FIELDS: readonly ListingSetupPolicyField[] = [
  "fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId",
];

/**
 * The policies the draft holds only because Card Shellz filled them in (eBay
 * offered one choice and none is saved), while the vendor has not changed them.
 */
export function suggestedListingSetupFields(
  setup: DropshipEbayListingSetupResponse,
  draft: ReplaceDropshipEbayListingSetupInput,
): Set<ListingSetupPolicyField> {
  const filled = buildEbayListingSetupDraft(setup);
  return new Set(LISTING_SETUP_POLICY_FIELDS.filter((field) => filled[field] !== ""
    && filled[field] !== (setup.selection[field] ?? "")
    && draft[field] === filled[field]));
}

/**
 * Whether leaving would lose a policy: the draft holds one that is not the
 * saved one, picked by the vendor or filled in by Card Shellz. An empty field
 * holds nothing to lose (and cannot be saved), so a store with nothing saved,
 * or a saved policy eBay no longer offers, is not a change until one is picked.
 */
export function listingSetupHasUnsavedPolicy(
  setup: DropshipEbayListingSetupResponse,
  draft: ReplaceDropshipEbayListingSetupInput,
): boolean {
  return LISTING_SETUP_POLICY_FIELDS.some((field) => draft[field] !== ""
    && draft[field] !== (setup.selection[field] ?? ""));
}

function selectedOrOnly(
  current: string | null,
  options: readonly DropshipEbayListingSetupOption[],
): string {
  if (current && options.some((option) => option.id === current)) return current;
  return options.length === 1 ? options[0].id : "";
}

/**
 * The draft for a newly loaded answer. Each policy the vendor picked and has
 * not saved (it differs from what the previous answer had saved, and Card
 * Shellz did not fill it in) stays picked while the new answer still lets it
 * be chosen; every other field starts from the new answer. So a refetch, or a
 * reload after another window saved, never throws a pick away. Another store's
 * answer starts over.
 */
export function rebaseEbayListingSetupDraft(
  previous: DropshipEbayListingSetupResponse | null,
  draft: ReplaceDropshipEbayListingSetupInput,
  next: DropshipEbayListingSetupResponse,
): ReplaceDropshipEbayListingSetupInput {
  const rebuilt = buildEbayListingSetupDraft(next);
  if (!previous || previous.storeConnectionId !== next.storeConnectionId) return rebuilt;
  const suggested = suggestedListingSetupFields(previous, draft);
  const result = { ...rebuilt };
  for (const field of LISTING_SETUP_POLICY_FIELDS) {
    const picked = draft[field];
    if (picked === "" || picked === (previous.selection[field] ?? "") || suggested.has(field)) continue;
    if (listingSetupPolicyChoosable(next, field, picked)) result[field] = picked;
  }
  return result;
}

/** Whether this answer lets the vendor pick this policy: eBay lists it, and a shipping policy was checked and fits. */
function listingSetupPolicyChoosable(
  setup: DropshipEbayListingSetupResponse,
  field: ListingSetupPolicyField,
  id: string,
): boolean {
  if (listingSetupShowsSavedValuesOnly(setup)) return false;
  if (field === "fulfillmentPolicyId") {
    return setup.options.fulfillmentPolicies.some((policy) => policy.id === id && policy.compatible);
  }
  const options = field === "returnPolicyId" ? setup.options.returnPolicies : setup.options.paymentPolicies;
  return options.some((option) => option.id === id);
}

/**
 * The badge words. "Setup required" only when the setup was fully checked and
 * something is missing: a view-only store, or one whose shipping could not be
 * checked, is not known to need setup.
 */
export function listingSetupStatusLabel(
  setup: DropshipEbayListingSetupResponse,
  state: { verificationAvailable: boolean; readOnly: boolean },
): string {
  if (!state.verificationAvailable) return "Verification pending";
  if (state.readOnly || listingSetupShowsSavedValuesOnly(setup)) return "View only";
  if (!listingSetupShippingChecked(setup)) return "Not checked";
  return setup.complete ? "Ready" : "Setup required";
}

/**
 * Whether eBay lacks a policy the vendor must create in Seller Hub. Says
 * nothing without eBay's lists, and does not call shipping policies missing
 * when they could not be checked.
 */
export function hasMissingVendorOptions(setup: DropshipEbayListingSetupResponse): boolean {
  if (listingSetupShowsSavedValuesOnly(setup)) return false;
  const fulfillmentMissing = setup.options.fulfillmentPolicies.length === 0
    || (listingSetupShippingChecked(setup) && !setup.options.fulfillmentPolicies.some((policy) => policy.compatible));
  return fulfillmentMissing
    || setup.options.returnPolicies.length === 0
    || setup.options.paymentPolicies.length === 0;
}
