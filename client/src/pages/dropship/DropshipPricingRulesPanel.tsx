import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { pricingProfileStateSchema, pricingReviewResponseSchema,
  PRICING_REVIEW_PAGE_SIZE, type PricingProfile, type PricingReviewResponse } from "@shared/dropship/pricing-rules";
import { Button } from "@/components/ui/button";
import { DropshipCatalogScopePicker as ScopePicker } from "./DropshipCatalogScopePicker";
import { Input } from "@/components/ui/input";
import { createDropshipIdempotencyKey, DropshipApiError, fetchJson, postJson, queryErrorMessage } from "@/lib/dropship-ops-surface";
import { displayListingPrice } from "@/lib/dropship-listing-price";
import { formatListingPreviewIssue } from "@/lib/dropship-listing-preview";
import { parseProfileDraft, profileDraft, type ProfileDraft, type RecipeDraft } from "@/lib/dropship-pricing-rules";

export function DropshipPricingRulesPanel(props: { storeConnectionId: number; storeName: string; onConfigurationChange: () => void }) {
  return <PricingRulesSession key={props.storeConnectionId} {...props} />;
}
function PricingRulesSession({ storeConnectionId, storeName, onConfigurationChange }: {
  storeConnectionId: number; storeName: string; onConfigurationChange: () => void;
}) {
  const endpoint = `/api/dropship/listings/stores/${storeConnectionId}/pricing-rules`;
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: [endpoint], queryFn: async () => pricingProfileStateSchema.parse(await fetchJson(endpoint)), retry: false });
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [revisionId, setRevisionId] = useState<number | null>(null);
  const [releaseFixed, setReleaseFixed] = useState(false);
  const [review, setReview] = useState<PricingReviewResponse | null>(null);
  const [phase, setPhase] = useState<"editing" | "reviewing" | "paging" | "applying" | "uncertain" | "refresh_error">("editing");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const applyKey = useRef<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (query.data && draft === null) { setDraft(profileDraft(query.data.profile)); setRevisionId(query.data.revisionId); }
  }, [query.data, draft]);
  const disabled = phase !== "editing";

  function edit(next: ProfileDraft) { setDraft(next); setReview(null); setError(""); setMessage(""); applyKey.current = null; }
  async function reviewImpact() {
    if (!draft || inFlight.current) return;
    let profile: PricingProfile;
    try { profile = parseProfileDraft(draft); } catch (caught) { setError(queryErrorMessage(caught, "Check your pricing rules.")); return; }
    inFlight.current = true; setPhase("reviewing"); setError(""); setMessage(""); setReview(null); applyKey.current = null;
    try {
      const result = pricingReviewResponseSchema.parse(await postJson(`${endpoint}/reviews`, {
        expectedRevisionId: revisionId, profile, releaseFixedOverrides: releaseFixed,
      }));
      if (mounted.current) setReview(result);
    } catch (caught) { if (mounted.current) setError(queryErrorMessage(caught, "Pricing impact could not be reviewed.")); }
    finally { inFlight.current = false; if (mounted.current) setPhase("editing"); }
  }
  async function reloadRules() {
    const state = pricingProfileStateSchema.parse(await fetchJson(endpoint));
    if (!mounted.current) return;
    queryClient.setQueryData([endpoint], state);
    setDraft(profileDraft(state.profile)); setRevisionId(state.revisionId); setReview(null);
    setReleaseFixed(false); applyKey.current = null;
    await queryClient.invalidateQueries({ predicate: (entry) => String(entry.queryKey[0]).startsWith(`/api/dropship/listings/stores/${storeConnectionId}/variants/`) });
  }
  async function reload() {
    if (inFlight.current) return;
    inFlight.current = true; setPhase("paging"); setError("");
    try { await reloadRules(); if (mounted.current) setPhase("editing"); }
    catch (caught) { if (mounted.current) { setError(queryErrorMessage(caught, "Saved rules could not be loaded.")); setPhase("refresh_error"); } }
    finally { inFlight.current = false; }
  }
  async function apply() {
    if (!review || inFlight.current || review.summary.blocked) return;
    inFlight.current = true; setPhase("applying"); setError("");
    applyKey.current ??= createDropshipIdempotencyKey("pricing-rules");
    let saved = false;
    try {
      onConfigurationChange();
      z.object({ revisionId: z.number().int().positive(), idempotentReplay: z.boolean() }).strict().parse(await postJson(`${endpoint}/apply`, {
        reviewId: review.reviewId, reviewHash: review.reviewHash, idempotencyKey: applyKey.current,
      }));
      saved = true;
      await reloadRules();
      if (!mounted.current) return;
      setPhase("editing"); setMessage("Pricing rules saved. Generate a new listing preview to review the resulting prices. No marketplace listing was changed.");
    } catch (caught) {
      if (!mounted.current) return;
      if (!saved && caught instanceof DropshipApiError && caught.code === "DROPSHIP_PRICING_REVIEW_STALE") {
        setReview(null); applyKey.current = null; setPhase("editing");
        setError(`${caught.message} Your draft was preserved. If another user changed the store rules, reload saved rules before editing.`);
        return;
      }
      setPhase(saved ? "refresh_error" : "uncertain");
      setError(`${saved ? "Rules saved, but refresh failed. " : "The apply outcome was not confirmed. "}${queryErrorMessage(caught, "Retry to confirm the outcome.")}`);
    } finally { inFlight.current = false; }
  }
  async function pageReview(page: number) {
    if (!review || inFlight.current) return;
    inFlight.current = true; setPhase("paging"); setError("");
    try {
      const result = pricingReviewResponseSchema.parse(await fetchJson(`${endpoint}/reviews/${review.reviewId}?page=${page}`));
      if (result.reviewId !== review.reviewId || result.reviewHash !== review.reviewHash) throw new Error("Review identity changed. Review again.");
      if (mounted.current) setReview(result);
    } catch (caught) { if (mounted.current) setError(queryErrorMessage(caught, "Review page could not be loaded.")); }
    finally { inFlight.current = false; if (mounted.current) setPhase("editing"); }
  }
  return <section className="rounded-lg border bg-white" aria-label="Listing pricing rules">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
      <div><h2 className="text-lg font-semibold">Listing pricing rules</h2>
        <p className="mt-1 text-sm text-zinc-500">Set prices across {storeName || "this store"}. Use individual price edits only for exceptions.</p>
        <p className="mt-1 text-xs text-zinc-500">Revision {revisionId ?? "not configured"} · Saving changes local pricing, not live marketplace listings.</p></div>
      <Button size="sm" variant="outline" disabled={inFlight.current} onClick={() => void reload()}>Reload saved rules</Button>
    </div>
    {!draft && <p className="p-4 text-sm" role={query.error ? "alert" : "status"}>{query.error ? queryErrorMessage(query.error, "Pricing rules unavailable.") : "Loading pricing rules…"}</p>}
    {draft && <div className="space-y-4 p-4">
      <fieldset disabled={disabled} className="space-y-4">
        <legend className="mb-2 font-medium">Store default</legend>
        <RecipeFields value={draft.defaultRecipe} onChange={(value) => edit({ ...draft, defaultRecipe: value })} />
        <p className="text-xs text-zinc-500">Basis × (1 + markup %) + flat markup. Per sellable pack. Markup is not profit margin; shipping and marketplace fees are separate.</p>
        <div className="flex items-center justify-between gap-3"><h3 className="font-medium">Group rules ({draft.groups.length})</h3>
          <Button type="button" size="sm" variant="outline" disabled={draft.groups.length >= 100} onClick={() => edit({ ...draft,
            groups: [...draft.groups, { id: createDropshipIdempotencyKey("group").replace(/[^A-Za-z0-9_-]/g, "_"), name: "New group",
              priority: String((draft.groups.length + 1) * 10), scope: { type: "category", category: "" }, recipe: { ...draft.defaultRecipe } }],
          })}>Add group rule</Button></div>
        <p className="text-xs text-zinc-500">Lowest priority number wins. Matching groups never stack; tied priorities block the affected prices.</p>
        <div className="max-h-[28rem] space-y-2 overflow-y-auto overscroll-contain">
          {draft.groups.map((group, index) => <details key={group.id} className="rounded border p-3"
            open={openGroups[group.id] ?? group.name === "New group"}
            onToggle={(event) => { const open = event.currentTarget.open; setOpenGroups((current) => current[group.id] === open ? current : { ...current, [group.id]: open }); }}>
            <summary className="cursor-pointer text-sm font-medium">{group.name || "Unnamed group"} · Priority {group.priority}</summary>
            <div className="mt-3 space-y-3"><div className="grid gap-3 sm:grid-cols-[1fr_8rem_auto]">
              <Field label="Group name"><Input value={group.name} maxLength={120} onChange={(event) => edit({ ...draft, groups: draft.groups.map((row, i) => i === index ? { ...row, name: event.target.value } : row) })} /></Field>
              <Field label="Priority"><Input inputMode="numeric" value={group.priority} onChange={(event) => edit({ ...draft, groups: draft.groups.map((row, i) => i === index ? { ...row, priority: event.target.value } : row) })} /></Field>
              <Button className="self-end" size="sm" variant="outline" onClick={() => edit({ ...draft, groups: draft.groups.filter((_, i) => i !== index) })}>Remove</Button>
            </div>
            {(openGroups[group.id] ?? group.name === "New group") && <ScopePicker endpoint={endpoint} value={group.scope} disabled={disabled} onChange={(scope) => edit({ ...draft, groups: draft.groups.map((row, i) => i === index ? { ...row, scope } : row) })} />}
            <RecipeFields value={group.recipe} onChange={(recipe) => edit({ ...draft, groups: draft.groups.map((row, i) => i === index ? { ...row, recipe } : row) })} />
            </div>
          </details>)}
        </div>
        <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={releaseFixed} onChange={(event) => {
          setReleaseFixed(event.target.checked); setReview(null); applyKey.current = null;
        }} /><span>Replace existing fixed prices with pricing rules.<span className="block text-xs text-zinc-500">Leave unchecked to preserve fixed exceptions. Explicit catalog-default choices will adopt the reviewed rules.</span></span></label>
        <Button onClick={() => void reviewImpact()}>{phase === "reviewing" ? "Reviewing all selected listings…" : "Review pricing impact"}</Button>
      </fieldset>
      {review && <div className="space-y-3 border-t pt-4" aria-label="Pricing impact review">
        <div><h3 className="font-medium">Review all {review.summary.total.toLocaleString()} selected listings</h3>
          <p className="text-sm text-zinc-500">{review.summary.changed} price changes · {review.summary.preserved} fixed prices preserved · {review.summary.blocked} blocked</p></div>
        <div className="max-h-80 overflow-auto overscroll-contain rounded border"><table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-zinc-50"><tr>{["Listing", "Product cost", "Before", "After", "Rule / issue"].map((label) => <th key={label} className="p-2 font-medium">{label}</th>)}</tr></thead>
          <tbody>{review.rows.map((row) => <tr key={row.productVariantId} className="border-t"><td className="p-2"><div>{row.title}</div><div className="text-xs text-zinc-500">{row.sku}</div></td>
            <td className="whitespace-nowrap p-2">{displayListingPrice(row.productCostCents)}</td><td className="whitespace-nowrap p-2">{displayListingPrice(row.previousPriceCents)}</td>
            <td className="whitespace-nowrap p-2 font-medium">{displayListingPrice(row.priceCents)}</td><td className="p-2 text-xs">{row.ruleName}
              {row.issues.map((issue) => <p key={issue} className="text-rose-700">{formatListingPreviewIssue(issue)}</p>)}</td></tr>)}</tbody>
        </table></div>
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-zinc-500">Page {review.page + 1} of {Math.max(1, Math.ceil(review.summary.total / PRICING_REVIEW_PAGE_SIZE))} · {PRICING_REVIEW_PAGE_SIZE} per page</span>
          <div className="flex gap-2"><Button size="sm" variant="outline" disabled={disabled || review.page === 0} onClick={() => void pageReview(review.page - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={disabled || (review.page + 1) * PRICING_REVIEW_PAGE_SIZE >= review.summary.total} onClick={() => void pageReview(review.page + 1)}>Next</Button></div></div>
        <Button disabled={disabled || review.summary.blocked > 0} onClick={() => void apply()}>Apply reviewed rules to {review.summary.total - review.summary.preserved} listings</Button>
        <p className="text-xs text-zinc-500">Future listings inherit these rules. Cost changes appear in new previews and require explicit publication; saving does not automatically reprice live listings.</p>
      </div>}
      {error && <div role="alert" className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>{error}</p>
        {phase === "uncertain" && <Button className="mt-2" size="sm" variant="outline" onClick={() => void apply()}>Retry same apply</Button>}
        {(phase === "uncertain" || phase === "refresh_error") && <p className="mt-2 text-xs">Reload saved rules to see the current state without another write. Reload discards this draft.</p>}</div>}
      {message && <p role="status" className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{message}</p>}
    </div>}
  </section>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1 text-xs text-zinc-600"><span>{label}</span>{children}</label>;
}
const selectClass = "h-9 w-full rounded-md border bg-white px-2 text-sm text-zinc-900";
function RecipeFields({ value, onChange }: { value: RecipeDraft; onChange: (value: RecipeDraft) => void }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
    <Field label="Price basis"><select className={selectClass} value={value.basis} onChange={(event) => onChange({ ...value, basis: event.target.value as RecipeDraft["basis"] })}>
      <option value="product_cost">Your .ops product cost</option><option value="catalog_retail">Catalog reference retail</option></select></Field>
    <Field label="Markup (%)"><Input inputMode="decimal" value={value.percentage} onChange={(event) => onChange({ ...value, percentage: event.target.value })} /></Field>
    <Field label="Plus flat markup (USD)"><Input inputMode="decimal" value={value.flat} onChange={(event) => onChange({ ...value, flat: event.target.value })} /></Field>
    <Field label="Rounding"><select className={selectClass} value={value.rounding} onChange={(event) => onChange({ ...value, rounding: event.target.value as RecipeDraft["rounding"] })}>
      <option value="cent">Nearest cent</option><option value="up_99">Round up to .99</option></select></Field>
  </div>;
}
