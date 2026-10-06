import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatListingPreviewIssue } from "@/lib/dropship-listing-preview";
import { LISTING_SETTINGS_SEND_TIMING } from "@/lib/dropship-catalog-steps";
import { createDropshipIdempotencyKey, DropshipApiError, fetchJson, putJson, queryErrorMessage } from "@/lib/dropship-ops-surface";
import { belowCostNote, describeListingPriceBuiltFrom, displayListingPrice, draftFromListingPrice, isListingPriceDirty,
  listingPriceEndpoint, listingPriceInput, prepareListingPriceSave, readListingPrice, readSavedListingPrice,
  reconcileListingPriceDraft, type ListingPriceDraft, type ListingPriceSaveAttempt } from "@/lib/dropship-listing-price";

export type DropshipListingPriceEditorProps = {
  storeConnectionId: number;
  productVariantId: number;
  disabled?: boolean;
  compact?: boolean;
  /** Where the editor sits: a listing preview (step 3) or Listing settings (step 2), which shows no preview. */
  context?: "preview" | "settings";
  /**
   * Reports whether the editor holds a change that is not saved, e.g. for a leave
   * guard, and false when it unmounts. Pass a stable function (a state setter).
   */
  onDirtyChange?: (dirty: boolean) => void;
  onCancel?: () => void;
  onSaveStarted: () => void;
  onSaveSettled: () => void;
  onSaved: () => Promise<void>;
};

export function DropshipListingPriceEditor(props: DropshipListingPriceEditorProps) {
  // A different store/variant is a different edit session. Preview regeneration is not.
  return <ListingPriceEditorSession key={`${props.storeConnectionId}:${props.productVariantId}`} {...props} />;
}

function ListingPriceEditorSession({ storeConnectionId, productVariantId, disabled = false, compact = false, context = "preview",
  onDirtyChange, onCancel, onSaveStarted, onSaveSettled, onSaved }: DropshipListingPriceEditorProps) {
  const fieldId = useId();
  const queryClient = useQueryClient();
  const identity = { storeConnectionId, productVariantId };
  const endpoint = listingPriceEndpoint(identity);
  const queryKey = [endpoint];
  const priceQuery = useQuery({ queryKey,
    queryFn: async () => readListingPrice(await fetchJson<unknown>(endpoint), identity),
    retry: false, staleTime: 0, refetchOnMount: "always" });
  const [draft, setDraft] = useState<ListingPriceDraft | null>(() => priceQuery.data ? draftFromListingPrice(priceQuery.data) : null);
  const [phase, setPhase] = useState<"editing" | "saving" | "refreshing" | "saved" | "conflict" | "refresh_error">("editing");
  const [error, setError] = useState("");
  const attempt = useRef<ListingPriceSaveAttempt | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!priceQuery.data) return;
    setDraft((current) => reconcileListingPriceDraft(current, priceQuery.data));
  }, [priceQuery.data]);

  const busy = phase === "saving" || phase === "refreshing";
  const dirty = draft ? isListingPriceDirty(draft) : false;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const price = priceQuery.data;
  const belowCost = draft && !draft.useDefault && !draft.useRules ? belowCostNote(draft.value, price?.productCostCents) : null;
  function updateDraft(change: Partial<Pick<ListingPriceDraft, "useDefault" | "useRules" | "value">>): void {
    if (disabled || busy || phase === "conflict" || phase === "refresh_error") return;
    setDraft((current) => current ? { ...current, ...change } : current);
    setError("");
    setPhase("editing");
  }

  async function readCurrentPrice() {
    // A successful idempotent replay may contain an older revision. Never cache its PUT payload.
    await queryClient.cancelQueries({ queryKey, exact: true });
    const current = readListingPrice(await fetchJson<unknown>(endpoint), identity);
    if (!mounted.current) return null;
    queryClient.setQueryData(queryKey, current);
    return current;
  }

  async function refreshAfterSave(): Promise<void> {
    try {
      const current = await readCurrentPrice();
      if (!current || !mounted.current) return;
      setDraft(draftFromListingPrice(current));
      await onSaved();
      if (!mounted.current) return;
      setPhase("saved");
      setError("");
    } catch (caught) {
      if (!mounted.current) return;
      setPhase("refresh_error");
      setError(queryErrorMessage(caught, "The saved price could not be refreshed."));
    }
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (disabled || !draft || inFlight.current || !dirty || phase === "conflict" || phase === "refresh_error") return;
    let next: ListingPriceSaveAttempt;
    try {
      next = prepareListingPriceSave(identity, draft, attempt.current, () => createDropshipIdempotencyKey("listing-price"));
    } catch (caught) {
      setError(queryErrorMessage(caught, "Enter a valid listing price."));
      return;
    }
    attempt.current = next;
    inFlight.current = true;
    setPhase("saving");
    setError("");
    let parentSaveStarted = false;
    try {
      onSaveStarted();
      parentSaveStarted = true;
      const result = await putJson<unknown>(endpoint, next.request);
      readSavedListingPrice(result, identity);
      if (!mounted.current) return;
      attempt.current = null;
      setPhase("refreshing");
      await refreshAfterSave();
    } catch (caught) {
      if (!mounted.current) return;
      if (caught instanceof DropshipApiError && caught.status === 409) {
        attempt.current = null;
        setPhase("conflict");
        setError("The saved price changed or this save conflicts with an earlier request. Reload the current saved price before editing again.");
      } else {
        setPhase("editing");
        const message = queryErrorMessage(caught, "The request failed.");
        setError(parentSaveStarted ? `${message} The save was not confirmed. Retry Save listing price to confirm the outcome.` : message);
      }
    } finally {
      inFlight.current = false;
      // The parent owns publication readiness and must settle even after this drawer closes.
      if (parentSaveStarted) onSaveSettled();
    }
  }

  async function reloadSavedPrice(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase("refreshing");
    setError("");
    try {
      const current = await readCurrentPrice();
      if (!current || !mounted.current) return;
      setDraft(draftFromListingPrice(current));
      attempt.current = null;
      setPhase("editing");
    } catch (caught) {
      if (mounted.current) {
        setPhase("conflict");
        setError(queryErrorMessage(caught, "The saved price could not be loaded. Please try again."));
      }
    } finally { inFlight.current = false; }
  }

  async function retryPreviewRefresh(): Promise<void> {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setPhase("refreshing");
    setError("");
    // The write already succeeded. This recovery path only reads price/preview state.
    try { await refreshAfterSave(); } finally { inFlight.current = false; }
  }

  const cancelDisabled = busy || phase === "refresh_error" || attempt.current !== null;
  const cancelButton = onCancel && <Button type="button" size="sm" variant="outline" disabled={cancelDisabled}
    onClick={onCancel}>{phase === "saved" ? "Close" : "Cancel"}</Button>;

  return <section aria-label="Your listing price" className={compact ? "min-w-64 max-w-sm whitespace-normal rounded-md border border-violet-200 bg-violet-50/30 p-3" : "rounded-lg border border-zinc-200 p-4"}>
    {!compact && <><h4 className="font-semibold">Your listing price</h4>
      <p className="mt-1 text-xs text-zinc-500">Your selling price in USD for one sellable pack—not your product cost.</p></>}
    {!draft && priceQuery.isPending && <p role="status" className="mt-3 text-sm">Loading saved price…</p>}
    {priceQuery.isError && !draft && <div role="alert" className="mt-3 text-sm text-rose-800">
      <p>{queryErrorMessage(priceQuery.error, "The saved price could not be loaded.")}</p>
      <Button className="mt-2" type="button" size="sm" variant="outline" onClick={() => void priceQuery.refetch()}>Retry loading price</Button>
    </div>}
    {!draft && cancelButton && <div className="mt-2">{cancelButton}</div>}
    {draft && <form onSubmit={(event) => void save(event)} className={compact ? "space-y-2" : "mt-3 space-y-3"}>
      {compact ? <p className="text-xs text-zinc-500">Saved {displayListingPrice(price?.effectivePriceCents ?? null)} · Default {displayListingPrice(price?.defaultPriceCents ?? null)}</p>
        : <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-xs text-zinc-500">Current saved price</dt><dd className="mt-1 font-medium">{displayListingPrice(price?.effectivePriceCents ?? null)}</dd>
          <dd className="mt-1 text-xs text-zinc-500">{price ? describeListingPriceBuiltFrom(price) : "No price yet"}</dd></div>
        <div><dt className="text-xs text-zinc-500">Catalog default</dt><dd className="mt-1 font-medium">{displayListingPrice(price?.defaultPriceCents ?? null)}</dd></div>
        <div><dt className="text-xs text-zinc-500">Your .ops cost</dt><dd className="mt-1 font-medium">{price?.productCostCents == null ? "Not known" : displayListingPrice(price.productCostCents)}</dd></div>
      </dl>}
      <div className="flex items-center gap-2"><input id={`${fieldId}-default`} type="checkbox" checked={draft.useDefault}
        disabled={disabled || busy || phase === "conflict" || phase === "refresh_error"} onChange={(event) => updateDraft({ useDefault: event.target.checked, useRules: false })}
        className="h-4 w-4 accent-purple-600" /><Label htmlFor={`${fieldId}-default`} className={compact ? "text-xs" : undefined}>{compact ? "Use catalog default" : "Use catalog default (no price override)"}</Label></div>
      <div className="max-w-xs space-y-1"><Label htmlFor={`${fieldId}-price`}>Your listing price (USD)</Label>
        {price?.rulesConfigured && <div className="flex items-center gap-2"><input id={`${fieldId}-rules`} type="checkbox" checked={draft.useRules ?? false}
          disabled={disabled || busy || phase === "conflict" || phase === "refresh_error"}
          onChange={(event) => updateDraft({ useRules: event.target.checked, useDefault: false })} />
          <Label htmlFor={`${fieldId}-rules`}>Use pricing rules{price.ruleName ? ` (${price.ruleName})` : ""}</Label></div>}
        {/* Stays editable while a box above is ticked: typing a price is how the vendor sets an exact one, so it unticks them. */}
        <Input id={`${fieldId}-price`} type="text" inputMode="decimal" autoComplete="off" placeholder="8.99"
          disabled={disabled || busy || phase === "conflict" || phase === "refresh_error"}
          value={draft.useRules ? listingPriceInput(price?.rulePriceCents ?? null) : draft.useDefault ? listingPriceInput(price?.defaultPriceCents ?? null) : draft.value}
          aria-describedby={`${fieldId}-help`} onChange={(event) => updateDraft({ value: event.target.value, useDefault: false, useRules: false })} />
      </div>
      {belowCost && <p className="text-xs text-amber-800">{belowCost}</p>}
      <p id={`${fieldId}-help`} className="text-xs text-zinc-500">{compact ? "Per sellable pack. Save refreshes the preview; it does not publish."
        : context === "settings" ? `Nothing changes until you save. ${LISTING_SETTINGS_SEND_TIMING}`
          : `Nothing changes until you save. Saving refreshes this preview. ${LISTING_SETTINGS_SEND_TIMING}`}</p>
      {draft.useRules && price?.pricingIssue && <p className="text-xs text-amber-800">{formatListingPreviewIssue(price.pricingIssue)}</p>}
      <div className="flex flex-wrap items-center gap-2"><Button type="submit" size="sm" className="gap-2" disabled={disabled || !dirty || busy || phase === "conflict" || phase === "refresh_error"}>
        <Save aria-hidden="true" className="h-4 w-4" />{phase === "saving" ? "Saving listing price…" : phase === "refreshing" ? "Refreshing preview…" : "Save listing price"}
      </Button>{cancelButton}</div>
      {dirty && !busy && phase === "editing" && <span className="text-xs text-zinc-500">Unsaved price change</span>}
    </form>}
    {error && <div role="alert" className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      {phase === "refresh_error" && <p className="mb-1 font-medium">Price saved, but the preview could not be refreshed.</p>}
      <p>{error}</p>
      {phase === "conflict" && <><p className="mt-1 text-xs">Reloading discards your unsaved price change.</p>
        <Button className="mt-2" size="sm" variant="outline" type="button" onClick={() => void reloadSavedPrice()}>Reload saved price</Button></>}
      {phase === "refresh_error" && <Button className="mt-2" size="sm" variant="outline" type="button" disabled={disabled} onClick={() => void retryPreviewRefresh()}>Retry preview refresh</Button>}
    </div>}
    {priceQuery.isError && draft && !error && <p role="status" className="mt-3 text-xs text-amber-900">The background price refresh failed. Your draft has been preserved.</p>}
    {phase === "saved" && <p role="status" className="mt-3 text-sm text-emerald-800">{context === "settings"
      ? `Price saved. ${LISTING_SETTINGS_SEND_TIMING}` : "Listing price saved and preview refreshed."}</p>}
  </section>;
}
