import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, ChevronsUpDown, RefreshCw, Save } from "lucide-react";
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
  fetchJson,
  putJson,
  queryErrorCode,
  queryErrorMessage,
  type DropshipEbayListingSetupOption,
  type DropshipEbayListingSetupResponse,
  type ReplaceDropshipEbayListingSetupInput,
} from "@/lib/dropship-ops-surface";
import { cn } from "@/lib/utils";
import { EbayStoreCategoryAuthorizationRecovery } from "./EbayStoreCategoryAuthorizationRecovery";

const EMPTY_SELECTION: ReplaceDropshipEbayListingSetupInput = {
  merchantLocationKey: "",
  fulfillmentPolicyId: "",
  returnPolicyId: "",
  paymentPolicyId: "",
};

export function EbayListingSetupPanel({
  onConfigurationChange,
  storeConnectionId,
}: {
  onConfigurationChange: () => void;
  storeConnectionId: number;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["/api/dropship/ebay/listing-setup", storeConnectionId] as const;
  const setupQuery = useQuery<DropshipEbayListingSetupResponse>({
    queryKey,
    queryFn: () => fetchJson<DropshipEbayListingSetupResponse>(
      `/api/dropship/ebay/listing-setup/${storeConnectionId}`,
    ),
    enabled: Number.isInteger(storeConnectionId) && storeConnectionId > 0,
    staleTime: 60_000,
  });
  const [draft, setDraft] = useState<ReplaceDropshipEbayListingSetupInput>(EMPTY_SELECTION);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveAuthorizationError, setSaveAuthorizationError] = useState<unknown>(null);
  const [savedMessage, setSavedMessage] = useState("");

  useEffect(() => {
    if (!setupQuery.data) return;
    setDraft(buildEbayListingSetupDraft(setupQuery.data));
    setSaveError("");
    setSaveAuthorizationError(null);
  }, [setupQuery.data]);

  useEffect(() => {
    setSaveError("");
    setSaveAuthorizationError(null);
    setSavedMessage("");
  }, [storeConnectionId]);

  const draftComplete = Object.values(draft).every((value) => value.trim().length > 0);
  const draftChanged = useMemo(
    () => setupQuery.data ? !listingSetupSelectionMatches(setupQuery.data, draft) : false,
    [draft, setupQuery.data],
  );

  async function saveSetup(): Promise<void> {
    if (!draftComplete || saving) return;
    setSaving(true);
    setSaveError("");
    setSaveAuthorizationError(null);
    setSavedMessage("");
    try {
      const result = await putJson<DropshipEbayListingSetupResponse>(
        `/api/dropship/ebay/listing-setup/${storeConnectionId}`,
        draft,
      );
      queryClient.setQueryData(queryKey, result);
      setDraft(buildEbayListingSetupDraft(result));
      setSavedMessage("eBay listing setup saved. Generate a new preview to use it.");
      onConfigurationChange();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "eBay listing setup could not be saved.");
      setSaveAuthorizationError(
        queryErrorCode(caught) === "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED"
          ? caught
          : null,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-5 overflow-hidden rounded-md border border-zinc-200 bg-white">
      <div className="flex flex-col gap-3 border-b border-zinc-200 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">eBay listing setup</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Choose the connected store&apos;s inventory location and business policies. These are required only when a listing is pushed to eBay.
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Echelon fills in any unambiguous value automatically. When eBay returns more than one valid choice, you choose which one applies.
          </p>
        </div>
        {setupQuery.data && (
          <Badge
            variant="outline"
            className={setupQuery.data.complete
              ? "w-fit border-emerald-200 bg-emerald-50 text-emerald-800"
              : "w-fit border-amber-300 bg-amber-50 text-amber-900"}
          >
            {setupQuery.data.complete ? "Ready" : "Setup required"}
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
      ) : setupQuery.error ? (
        <ListingSetupError error={setupQuery.error} />
      ) : setupQuery.data ? (
        <div className="p-4">
          {setupQuery.data.complete && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>The required eBay listing destination and business policies are configured.</span>
            </div>
          )}
          <div className="mb-4 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
            <span className="text-zinc-500">Marketplace</span>
            <span className="ml-2 font-medium">{setupQuery.data.marketplaceId}</span>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <ListingSetupField
              label="Inventory location"
              placeholder="Choose an enabled inventory location"
              searchPlaceholder="Search inventory locations..."
              emptyMessage="No matching inventory locations."
              options={setupQuery.data.options.merchantLocations}
              value={draft.merchantLocationKey}
              onValueChange={(value) => setDraft((current) => ({ ...current, merchantLocationKey: value }))}
            />
            <ListingSetupField
              label="Fulfillment policy"
              placeholder="Choose a fulfillment policy"
              searchPlaceholder="Search fulfillment policies..."
              emptyMessage="No matching fulfillment policies."
              options={setupQuery.data.options.fulfillmentPolicies}
              value={draft.fulfillmentPolicyId}
              onValueChange={(value) => setDraft((current) => ({ ...current, fulfillmentPolicyId: value }))}
            />
            <ListingSetupField
              label="Return policy"
              placeholder="Choose a return policy"
              searchPlaceholder="Search return policies..."
              emptyMessage="No matching return policies."
              options={setupQuery.data.options.returnPolicies}
              value={draft.returnPolicyId}
              onValueChange={(value) => setDraft((current) => ({ ...current, returnPolicyId: value }))}
            />
            <ListingSetupField
              label="Payment policy"
              placeholder="Choose a payment policy"
              searchPlaceholder="Search payment policies..."
              emptyMessage="No matching payment policies."
              options={setupQuery.data.options.paymentPolicies}
              value={draft.paymentPolicyId}
              onValueChange={(value) => setDraft((current) => ({ ...current, paymentPolicyId: value }))}
            />
          </div>

          {hasMissingProviderOptions(setupQuery.data) && (
            <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              eBay did not return every required active location or policy. Create or enable the missing item in eBay Seller Hub, then refresh these options.
            </div>
          )}
          {saveError && (
            <div role="alert" className="mt-4 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
              {saveError}
              {saveAuthorizationError !== null && (
                <EbayStoreCategoryAuthorizationRecovery error={saveAuthorizationError} />
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
              disabled={saving || setupQuery.isFetching}
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
              disabled={saving || !draftComplete || !draftChanged}
              onClick={saveSetup}
            >
              <Save className="h-4 w-4" />
              {saving ? "Saving setup" : "Save eBay listing setup"}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ListingSetupError({ error }: { error: unknown }) {
  const permissionRequired = queryErrorCode(error) === "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED";
  return (
    <div className="m-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
      <div className="font-medium">
        {permissionRequired
          ? "eBay listing authorization needs attention."
          : "eBay listing setup is unavailable."}
      </div>
      <div className="mt-1">
        {permissionRequired
          ? "eBay rejected access to this store's Inventory locations or Account policies. Refresh authorization below so Echelon can load the real choices."
          : queryErrorMessage(error, "The connected eBay store did not return its listing setup.")}
      </div>
      {permissionRequired && (
        <>
          <div className="mt-1 text-xs">
            If eBay still rejects access after authorization, Card Shellz support must inspect the application&apos;s granted scopes and the seller account&apos;s API eligibility.
          </div>
          <EbayStoreCategoryAuthorizationRecovery error={error} />
        </>
      )}
    </div>
  );
}

function ListingSetupField({
  emptyMessage,
  label,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  value,
}: {
  emptyMessage: string;
  label: string;
  onValueChange: (value: string) => void;
  options: readonly DropshipEbayListingSetupOption[];
  placeholder: string;
  searchPlaceholder: string;
  value: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-2">
        <ListingSetupCombobox
          ariaLabel={label}
          emptyMessage={emptyMessage}
          onValueChange={onValueChange}
          options={options}
          placeholder={placeholder}
          searchPlaceholder={searchPlaceholder}
          value={value}
        />
      </div>
      {options.length === 0 && (
        <p className="mt-1 text-xs text-amber-800">No eligible options were returned by eBay.</p>
      )}
    </div>
  );
}

function ListingSetupCombobox({
  ariaLabel,
  emptyMessage,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  value,
}: {
  ariaLabel: string;
  emptyMessage: string;
  onValueChange: (value: string) => void;
  options: readonly DropshipEbayListingSetupOption[];
  placeholder: string;
  searchPlaceholder: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.id === value) ?? null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={options.length === 0}
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

export function buildEbayListingSetupDraft(
  setup: DropshipEbayListingSetupResponse,
): ReplaceDropshipEbayListingSetupInput {
  return {
    merchantLocationKey: selectedOrOnly(setup.selection.merchantLocationKey, setup.options.merchantLocations),
    fulfillmentPolicyId: selectedOrOnly(setup.selection.fulfillmentPolicyId, setup.options.fulfillmentPolicies),
    returnPolicyId: selectedOrOnly(setup.selection.returnPolicyId, setup.options.returnPolicies),
    paymentPolicyId: selectedOrOnly(setup.selection.paymentPolicyId, setup.options.paymentPolicies),
  };
}

function selectedOrOnly(
  current: string | null,
  options: readonly DropshipEbayListingSetupOption[],
): string {
  if (current && options.some((option) => option.id === current)) return current;
  return options.length === 1 ? options[0].id : "";
}

function listingSetupSelectionMatches(
  setup: DropshipEbayListingSetupResponse,
  draft: ReplaceDropshipEbayListingSetupInput,
): boolean {
  return setup.selection.merchantLocationKey === draft.merchantLocationKey
    && setup.selection.fulfillmentPolicyId === draft.fulfillmentPolicyId
    && setup.selection.returnPolicyId === draft.returnPolicyId
    && setup.selection.paymentPolicyId === draft.paymentPolicyId;
}

function hasMissingProviderOptions(setup: DropshipEbayListingSetupResponse): boolean {
  return setup.options.merchantLocations.length === 0
    || setup.options.fulfillmentPolicies.length === 0
    || setup.options.returnPolicies.length === 0
    || setup.options.paymentPolicies.length === 0;
}
