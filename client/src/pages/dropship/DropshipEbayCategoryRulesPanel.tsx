import { useEffect, useRef, useState } from "react";
import { LISTING_SETTINGS_SEND_TIMING } from "@/lib/dropship-catalog-steps";
import { NotSavedBadge, useUnsavedDraft } from "./catalog/UnsavedChangesGuard";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EbayCategory, EbayCategoryRulesDraft, EbayCategoryRulesReview, EbayCategoryRulesState } from "@shared/dropship/ebay-category-rules";
import { MAX_EBAY_CATEGORY_RULES } from "@shared/dropship/ebay-category-rules";
import { MAX_NAMED_CATALOG_GROUP_ITEMS } from "@shared/dropship/catalog-scope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addEbayCategoryRule,
  categoryPathLabel,
  checkEbayCategoryDraft,
  describeEbayCategoryReview,
  EBAY_CATEGORIES_PERMISSION_REQUIRED,
  EBAY_CATEGORY_RULES_VERSION_CONFLICT,
  ebayCategoryRulesEndpoint,
  ebayCategorySourceLabel,
  editorDraftFromState,
  fetchEbayCategoryRules,
  moveEbayCategoryRule,
  namedListingCount,
  removeEbayCategoryRule,
  reviewEbayCategoryRules,
  sameEbayCategoryDraft,
  saveEbayCategoryRules,
  setEbayDefaultCategory,
  updateEbayCategoryRule,
  type EbayCategoryRuleEditorRow,
  type EbayCategoryRulesEditorDraft,
} from "@/lib/dropship-ebay-category-rules";
import { createDropshipIdempotencyKey, DropshipApiError, queryErrorCode, queryErrorMessage } from "@/lib/dropship-ops-surface";
import { DropshipCatalogScopePicker as ScopePicker } from "./DropshipCatalogScopePicker";
import { DropshipEbayCategoryPicker, type RenderEbayAuthorizationRecovery } from "./DropshipEbayCategoryPicker";
import type { ContentSaveCallbacks } from "./useContentDraft";

/** How many of the review's example changes are listed; the counts above them cover every listing. */
const REVIEW_CHANGE_ROWS_SHOWN = 20;
/** How many destination categories the review lists before summing the rest. */
const REVIEW_CATEGORY_ROWS_SHOWN = 10;
/** Picker target for the store default; rule pickers use the rule id. */
const DEFAULT_CATEGORY_PICKER = "store-default";

type Phase = "editing" | "reviewing" | "saving" | "uncertain" | "refresh_error";
type ReviewRequest = { expectedRevisionId: number | null; draft: EbayCategoryRulesDraft };
type SaveRequest = ReviewRequest & { idempotencyKey: string };
type Failure = { message: string; error: unknown };

export interface DropshipEbayCategoryRulesPanelProps extends ContentSaveCallbacks {
  storeConnectionId: number;
  storeName: string;
  renderAuthorizationRecovery?: RenderEbayAuthorizationRecovery;
}

/**
 * The vendor's eBay categories for one eBay store: a store default and ordered
 * rules by catalog category, product line, product or named listings. Saving
 * always goes through a review of what changes, and a save that was sent but
 * not confirmed is retried with the same key, so it can never apply twice.
 */
export function DropshipEbayCategoryRulesPanel(props: DropshipEbayCategoryRulesPanelProps) {
  return <EbayCategoryRulesSession key={props.storeConnectionId} {...props} />;
}

function EbayCategoryRulesSession({ storeConnectionId, storeName, renderAuthorizationRecovery, ...callbacks }: DropshipEbayCategoryRulesPanelProps) {
  const endpoint = ebayCategoryRulesEndpoint(storeConnectionId);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: [endpoint], queryFn: () => fetchEbayCategoryRules(storeConnectionId), retry: false });
  // Rules already in the query cache seed the editor on the first render; otherwise the effect below does once they load.
  const [saved, setSaved] = useState<EbayCategoryRulesState | null>(() => query.data ?? null);
  const [draft, setDraft] = useState<EbayCategoryRulesEditorDraft | null>(() => (query.data ? editorDraftFromState(query.data) : null));
  const [phase, setPhase] = useState<Phase>("editing");
  const [review, setReview] = useState<{ result: EbayCategoryRulesReview; request: ReviewRequest } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [message, setMessage] = useState("");
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [openRules, setOpenRules] = useState<Record<string, boolean>>({});
  const attempt = useRef<SaveRequest | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    // The draft is seeded once. Later reads never replace what the vendor is editing.
    if (query.data && saved === null) { setSaved(query.data); setDraft(editorDraftFromState(query.data)); }
  }, [query.data, saved]);

  const editable = phase === "editing" && !callbacks.disabled;
  const dirty = draft !== null && saved !== null && !sameEbayCategoryDraft(draft, editorDraftFromState(saved));
  useUnsavedDraft(`ebay-category-rules:${storeConnectionId}`, "eBay categories", dirty);

  function edit(next: EbayCategoryRulesEditorDraft) {
    if (!editable) return;
    setDraft(next); setReview(null); setFailure(null); setMessage(""); attempt.current = null;
  }

  async function startReview() {
    if (!draft || !saved || inFlight.current || !editable) return;
    const check = checkEbayCategoryDraft(draft);
    if (!check.ok) {
      setFailure({ message: check.message, error: null });
      if (check.ruleId) setOpenRules((current) => ({ ...current, [check.ruleId!]: true }));
      return;
    }
    const request: ReviewRequest = { expectedRevisionId: saved.revisionId, draft: check.draft };
    inFlight.current = true; setPhase("reviewing"); setFailure(null); setMessage(""); setReview(null); attempt.current = null;
    try {
      const result = await reviewEbayCategoryRules(storeConnectionId, request);
      if (mounted.current) setReview({ result, request });
    } catch (caught) {
      if (mounted.current) setFailure({ message: failureMessage(caught, "The change could not be reviewed. Try again."), error: caught });
    } finally {
      inFlight.current = false;
      if (mounted.current) setPhase("editing");
    }
  }

  async function confirmSave() {
    if (!review || inFlight.current || callbacks.disabled || (phase !== "editing" && phase !== "uncertain")) return;
    // One key per reviewed request. A retry after an unconfirmed save resends the
    // identical body, so the server replays the first save instead of adding one.
    attempt.current ??= { ...review.request, idempotencyKey: createDropshipIdempotencyKey("ebay-category-rules") };
    const request = attempt.current;
    inFlight.current = true; setPhase("saving"); setFailure(null); setMessage("");
    let started = false;
    let confirmed = false;
    try {
      callbacks.onSaveStarted(); started = true;
      const result = await saveEbayCategoryRules(storeConnectionId, request);
      confirmed = true; attempt.current = null;
      queryClient.setQueryData([endpoint], result.state);
      if (!mounted.current) return;
      setSaved(result.state); setDraft(editorDraftFromState(result.state)); setReview(null); setPickerFor(null);
      await callbacks.onSaved();
      if (!mounted.current) return;
      setPhase("editing");
      setMessage(`eBay categories saved and the listing preview refreshed. ${LISTING_SETTINGS_SEND_TIMING}`);
    } catch (caught) {
      if (!mounted.current) return;
      if (confirmed) {
        setPhase("refresh_error");
        setFailure({ message: "eBay categories saved, but the listing preview could not be refreshed. Refresh the preview to see the new categories.", error: caught });
      } else if (!started) {
        // Nothing was sent (another listing action is running). The reviewed change and its key stay ready.
        setPhase("editing");
        setFailure({ message: queryErrorMessage(caught, "Wait for the current listing action to finish, then save again."), error: caught });
      } else if (caught instanceof DropshipApiError && caught.status >= 400 && caught.status < 500) {
        // The server answered and refused this request, so nothing was saved.
        const retryable = caught.status === 429;
        if (!retryable) { attempt.current = null; setReview(null); }
        setPhase("editing");
        setFailure({ message: failureMessage(caught, "The eBay categories were not saved."), error: caught });
      } else {
        setPhase("uncertain");
        setFailure({ message: `The save was not confirmed. ${queryErrorMessage(caught, "Retry the same save to learn whether it went through.")}`, error: caught });
      }
    } finally {
      inFlight.current = false;
      if (started) callbacks.onSaveSettled();
    }
  }

  async function refreshPreview() {
    if (inFlight.current) return;
    inFlight.current = true; setFailure(null);
    try {
      await callbacks.onSaved();
      if (mounted.current) { setPhase("editing"); setMessage("Listing preview refreshed with the saved eBay categories."); }
    } catch (caught) {
      if (mounted.current) setFailure({ message: queryErrorMessage(caught, "The listing preview could not be refreshed."), error: caught });
    } finally { inFlight.current = false; }
  }

  async function reload() {
    if (inFlight.current) return;
    inFlight.current = true; setFailure(null); setMessage("");
    try {
      const state = await fetchEbayCategoryRules(storeConnectionId);
      queryClient.setQueryData([endpoint], state);
      if (!mounted.current) return;
      setSaved(state); setDraft(editorDraftFromState(state)); setReview(null); setPickerFor(null); attempt.current = null;
      setPhase("editing");
    } catch (caught) {
      if (mounted.current) setFailure({ message: queryErrorMessage(caught, "Saved eBay categories could not be loaded."), error: caught });
    } finally { inFlight.current = false; }
  }

  function addRule() {
    if (!draft) return;
    const id = createDropshipIdempotencyKey("rule").replace(/[^A-Za-z0-9_-]/g, "_");
    setOpenRules((current) => ({ ...current, [id]: true }));
    edit(addEbayCategoryRule(draft, id));
  }

  function pickCategory(target: string, category: EbayCategory) {
    if (!draft) return;
    setPickerFor(null);
    edit(target === DEFAULT_CATEGORY_PICKER
      ? setEbayDefaultCategory(draft, category)
      : updateEbayCategoryRule(draft, target, { category }));
  }

  const permissionFailure = failure && queryErrorCode(failure.error) === EBAY_CATEGORIES_PERMISSION_REQUIRED;
  const namedListings = draft ? namedListingCount(draft) : 0;

  return (
    <section className="rounded-lg border bg-white" aria-label="eBay categories">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div>
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">eBay categories{dirty && <NotSavedBadge />}</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Choose the eBay category your listings use in {storeName || "this store"}. Each listing uses the first rule that matches it,
            then your store default, then the Card Shellz category for its product type.
          </p>
          <p className="mt-1 text-xs text-zinc-500">Saving changes your listing previews. {LISTING_SETTINGS_SEND_TIMING}</p>
        </div>
        <Button size="sm" variant="outline" disabled={phase === "reviewing" || phase === "saving"} onClick={() => void reload()}>Reload saved categories</Button>
      </div>

      {!draft && (
        <div className="p-4 text-sm" role={query.error ? "alert" : "status"}>
          {query.error ? (
            <>
              <p>{queryErrorMessage(query.error, "Your eBay categories could not be loaded.")}</p>
              <Button className="mt-2" size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button>
            </>
          ) : "Loading your eBay categories…"}
        </div>
      )}

      {draft && (
        <div className="space-y-5 p-4">
          <fieldset disabled={!editable} className="space-y-5">
            <div className="space-y-2">
              <h3 className="font-medium">Store default</h3>
              <p className="text-sm">
                {draft.defaultCategory
                  ? <>{categoryPathLabel(draft.defaultCategory)} <span className="text-xs text-zinc-500">#{draft.defaultCategory.categoryId}</span></>
                  : "None. Listings no rule covers use the Card Shellz category for their product type (recommended)."}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setPickerFor(DEFAULT_CATEGORY_PICKER)}>
                  {draft.defaultCategory ? "Change store default" : "Choose a store default"}
                </Button>
                {draft.defaultCategory && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => edit(setEbayDefaultCategory(draft, null))}>
                    Use Card Shellz categories instead
                  </Button>
                )}
              </div>
              {pickerFor === DEFAULT_CATEGORY_PICKER && (
                <DropshipEbayCategoryPicker storeConnectionId={storeConnectionId} label="Store default eBay category"
                  onPick={(category) => pickCategory(DEFAULT_CATEGORY_PICKER, category)} onCancel={() => setPickerFor(null)}
                  renderAuthorizationRecovery={renderAuthorizationRecovery} />
              )}
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-medium">Rules ({draft.rules.length} of {MAX_EBAY_CATEGORY_RULES})</h3>
                <Button type="button" size="sm" variant="outline" disabled={draft.rules.length >= MAX_EBAY_CATEGORY_RULES} onClick={addRule}>
                  Add rule
                </Button>
              </div>
              <p className="text-xs text-zinc-500">
                Rules are checked from the top. The first rule that matches a listing sets its eBay category. One rule can cover a whole catalog
                category, product line or product{namedListings > 0 ? ` · ${namedListings.toLocaleString("en-US")} of ${MAX_NAMED_CATALOG_GROUP_ITEMS.toLocaleString("en-US")} named listings used` : ""}.
              </p>
              {draft.rules.length === 0 && <p className="text-sm text-zinc-500">No rules yet.</p>}
              <ol className="space-y-2">
                {draft.rules.map((rule, index) => (
                  <RuleRow key={rule.id} rule={rule} index={index} count={draft.rules.length} endpoint={endpoint}
                    open={openRules[rule.id] ?? false} disabled={!editable} pickerOpen={pickerFor === rule.id}
                    storeConnectionId={storeConnectionId} renderAuthorizationRecovery={renderAuthorizationRecovery}
                    onToggle={(open) => setOpenRules((current) => (current[rule.id] === open ? current : { ...current, [rule.id]: open }))}
                    onChange={(patch) => edit(updateEbayCategoryRule(draft, rule.id, patch))}
                    onMove={(direction) => edit(moveEbayCategoryRule(draft, rule.id, direction))}
                    onRemove={() => edit(removeEbayCategoryRule(draft, rule.id))}
                    onOpenPicker={() => setPickerFor(rule.id)} onClosePicker={() => setPickerFor(null)}
                    onPick={(category) => pickCategory(rule.id, category)} />
                ))}
              </ol>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" disabled={!dirty} onClick={() => void startReview()}>
                {phase === "reviewing" ? "Checking every selected listing…" : "Review changes"}
              </Button>
              {!dirty && <span className="text-xs text-zinc-500">No unsaved changes.</span>}
            </div>
          </fieldset>

          {/* An unconfirmed save is settled by retrying it or reloading, never by editing over it. */}
          {review && <ReviewSummary review={review.result} ruleNames={review.request.draft.rules.map((rule) => ({ id: rule.id, name: rule.name }))}
            saving={phase === "saving"} disabled={!!callbacks.disabled || phase === "saving"}
            backDisabled={phase === "saving" || phase === "uncertain"}
            onConfirm={() => void confirmSave()} onBack={() => { setReview(null); attempt.current = null; }} />}

          {failure && (
            <div role="alert" className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p>{failure.message}</p>
              {permissionFailure && renderAuthorizationRecovery?.(failure.error)}
              {phase === "uncertain" && <Button className="mt-2" size="sm" variant="outline" onClick={() => void confirmSave()}>Retry the same save</Button>}
              {phase === "refresh_error" && <Button className="mt-2" size="sm" variant="outline" onClick={() => void refreshPreview()}>Refresh the preview</Button>}
              {(phase === "uncertain" || queryErrorCode(failure.error) === EBAY_CATEGORY_RULES_VERSION_CONFLICT) && (
                <p className="mt-2 text-xs">Reload saved categories to see what is saved now. Reloading replaces this draft.</p>
              )}
            </div>
          )}
          {message && <p role="status" className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{message}</p>}
        </div>
      )}
    </section>
  );
}

function RuleRow({ rule, index, count, endpoint, open, disabled, pickerOpen, storeConnectionId, renderAuthorizationRecovery,
  onToggle, onChange, onMove, onRemove, onOpenPicker, onClosePicker, onPick }: {
  rule: EbayCategoryRuleEditorRow; index: number; count: number; endpoint: string; open: boolean; disabled: boolean; pickerOpen: boolean;
  storeConnectionId: number; renderAuthorizationRecovery?: RenderEbayAuthorizationRecovery;
  onToggle: (open: boolean) => void; onChange: (patch: Partial<Omit<EbayCategoryRuleEditorRow, "id">>) => void;
  onMove: (direction: -1 | 1) => void; onRemove: () => void; onOpenPicker: () => void; onClosePicker: () => void;
  onPick: (category: EbayCategory) => void;
}) {
  const name = rule.name.trim() || `Rule ${index + 1}`;
  return (
    <li>
      <details className="rounded border p-3" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
        <summary className="cursor-pointer text-sm">
          <span className="font-medium">{index + 1}. {name}</span>
          <span className="text-zinc-500"> → {rule.category ? categoryPathLabel(rule.category) : "No eBay category chosen"}</span>
        </summary>
        {open && (
          <div className="mt-3 space-y-3">
            <label className="block space-y-1 text-xs text-zinc-600">
              <span>Rule name</span>
              <Input value={rule.name} maxLength={120} placeholder="For example: Toploaders" disabled={disabled}
                onChange={(event) => onChange({ name: event.target.value })} />
            </label>
            <ScopePicker endpoint={endpoint} value={rule.scope} disabled={disabled}
              onChange={(scope, targetName) => onChange(!rule.name.trim() && targetName ? { scope, name: targetName.slice(0, 120) } : { scope })} />
            <div className="space-y-2">
              <p className="text-xs text-zinc-600">eBay category</p>
              <p className="text-sm">
                {rule.category
                  ? <>{categoryPathLabel(rule.category)} <span className="text-xs text-zinc-500">#{rule.category.categoryId}</span></>
                  : "No eBay category chosen yet."}
              </p>
              <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onOpenPicker}>
                {rule.category ? "Change eBay category" : "Choose eBay category"}
              </Button>
              {pickerOpen && (
                <DropshipEbayCategoryPicker storeConnectionId={storeConnectionId} label={`eBay category for ${name}`}
                  initialQuery={rule.name.trim()} onPick={onPick} onCancel={onClosePicker}
                  renderAuthorizationRecovery={renderAuthorizationRecovery} />
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="ghost" disabled={disabled || index === 0} onClick={() => onMove(-1)}>Move up</Button>
              <Button type="button" size="sm" variant="ghost" disabled={disabled || index === count - 1} onClick={() => onMove(1)}>Move down</Button>
              <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onRemove}>Remove rule</Button>
            </div>
          </div>
        )}
      </details>
    </li>
  );
}

/** What saving would change, shown before anything is written. */
export function ReviewSummary({ review, ruleNames, saving, disabled, backDisabled, onConfirm, onBack }: {
  review: EbayCategoryRulesReview;
  /** The reviewed rules in saved order, so each rule's coverage reads by name. */
  ruleNames: ReadonlyArray<{ id: string; name: string }>;
  saving: boolean; disabled: boolean; backDisabled: boolean; onConfirm: () => void; onBack: () => void;
}) {
  const summary = describeEbayCategoryReview(review);
  const matchedByRule = new Map(review.byRule.map((row) => [row.ruleId, row.matched]));
  const categories = review.byCategory.slice(0, REVIEW_CATEGORY_ROWS_SHOWN);
  const otherCategories = review.byCategory.slice(REVIEW_CATEGORY_ROWS_SHOWN).reduce((total, row) => total + row.count, 0) + review.otherCategoriesCount;
  return (
    <div className="space-y-3 border-t pt-4" aria-label="eBay category review">
      <div>
        <h3 className="font-medium">{summary.headline}</h3>
        {summary.details.map((line) => <p key={line} className="text-sm text-zinc-600">{line}</p>)}
      </div>
      {ruleNames.length > 0 && (
        <div>
          <p className="text-xs font-medium text-zinc-600">Listings each rule covers</p>
          <ol className="mt-1 space-y-1 text-sm">
            {ruleNames.map((rule, index) => {
              const matched = matchedByRule.get(rule.id) ?? 0;
              return (
                <li key={rule.id}>
                  {index + 1}. {rule.name}: {matched.toLocaleString("en-US")} {matched === 1 ? "listing" : "listings"}
                  {matched === 0 && <span className="text-xs text-amber-700"> · matches no selected listing, or an earlier rule covers them</span>}
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {categories.length > 0 && (
        <div>
          <p className="text-xs font-medium text-zinc-600">Where your selected listings go</p>
          <ul className="mt-1 space-y-1 text-sm">
            {categories.map((row) => (
              <li key={row.categoryId}>{row.count.toLocaleString("en-US")} → {row.categoryName ?? "Unnamed category"} <span className="text-xs text-zinc-500">#{row.categoryId}</span></li>
            ))}
            {otherCategories > 0 && <li className="text-zinc-500">{otherCategories.toLocaleString("en-US")} → other categories</li>}
          </ul>
        </div>
      )}
      {review.changes.length > 0 && (
        <div className="max-h-72 overflow-auto overscroll-contain rounded border">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-zinc-50">
              <tr>{["Listing", "Now", "After saving"].map((label) => <th key={label} className="p-2 font-medium">{label}</th>)}</tr>
            </thead>
            <tbody>
              {review.changes.slice(0, REVIEW_CHANGE_ROWS_SHOWN).map((change) => (
                <tr key={change.productVariantId} className="border-t">
                  <td className="p-2"><div>{change.title}</div>{change.sku && <div className="text-xs text-zinc-500">{change.sku}</div>}</td>
                  <td className="p-2"><CategoryCell summary={change.before} /></td>
                  <td className="p-2"><CategoryCell summary={change.after} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {review.changes.length > 0 && review.changedCount > Math.min(review.changes.length, REVIEW_CHANGE_ROWS_SHOWN) && (
        <p className="text-xs text-zinc-500">Showing {Math.min(review.changes.length, REVIEW_CHANGE_ROWS_SHOWN)} of {review.changedCount.toLocaleString("en-US")} changed listings.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={disabled} onClick={onConfirm}>{saving ? "Saving…" : "Confirm and save"}</Button>
        <Button type="button" variant="outline" disabled={backDisabled} onClick={onBack}>Back to editing</Button>
      </div>
    </div>
  );
}

function CategoryCell({ summary }: { summary: EbayCategoryRulesReview["changes"][number]["before"] }) {
  return (
    <div>
      <div>{summary.categoryName ?? (summary.categoryId ? `#${summary.categoryId}` : "No eBay category")}</div>
      <div className="text-xs text-zinc-500">{ebayCategorySourceLabel(summary.source, null)}</div>
    </div>
  );
}

/** Refusals the vendor can act on get their own words; anything else keeps the server's message. */
function failureMessage(error: unknown, fallback: string): string {
  switch (queryErrorCode(error)) {
    case EBAY_CATEGORY_RULES_VERSION_CONFLICT:
      return "Your saved eBay categories changed in another window. Your draft is kept here; reload saved categories before saving again.";
    case EBAY_CATEGORIES_PERMISSION_REQUIRED:
      return "Your eBay connection needs a refresh before eBay categories can be checked or saved.";
    case "DROPSHIP_EBAY_CATEGORY_RATE_LIMITED":
      return "Too many eBay category requests in the last minute. Wait a moment, then try again.";
    default:
      return queryErrorMessage(error, fallback);
  }
}
