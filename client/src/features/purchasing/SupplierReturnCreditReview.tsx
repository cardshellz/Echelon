import React, { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supplierReturnCreditReviewInputSchema, supplierReturnCreditReviewSchema, supplierReturnCreditReviewDispositionSchema, type SupplierReturnCreditReview as Review } from "@shared/procurement/supplier-return-credit";
import { formatPaymentAmount, parsePaymentAmount, sumPaymentCents } from "@/lib/ap-payment-command";
import { FinancialCommandRequestError } from "@/lib/financial-command";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SupplierReturnRecovery } from "./SupplierReturnRecovery";
import { SupplierReturnValue } from "./SupplierReturnValue";
import { formatWorkspaceDate, formatWorkspaceMills } from "./purchase-workspace-format";
import type { SupplierReturnCommands } from "./use-supplier-return-commands";
type AssignmentDraft = { product: string; packaging: string; landed: string };
const dispositionLabels = { attribution_only: "Attribute existing supplier credit", awaiting_supplier_note: "Awaiting another supplier note", supplier_declined: "Supplier declined the difference" } as const;
function attributionDrafts(review: Review): Record<number, AssignmentDraft> {
  if (!review.reviewCurrent) return {};
  return Object.fromEntries((review.latestReview?.assignments ?? []).map(row => [row.creditLinkId, { product: formatCentsInput(row.productCents), packaging: formatCentsInput(row.packagingCents), landed: formatCentsInput(row.landedCents) }]));
}
function formatCentsInput(cents: number): string { return `${BigInt(cents) / BigInt(100)}.${String(BigInt(cents) % BigInt(100)).padStart(2, "0")}`; }
export function SupplierReturnDifferenceSummary({ review }: { review: Review }) {
  return <section aria-label="Current supplier credit differences" className="space-y-3">
    <p className="text-sm">{review.quantity.toLocaleString()} recorded return units matched to these supplier credits.</p>
    <SupplierReturnValue value={review.currentCosts} label="Current value of matched returned quantity" />
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">{([ ["Product difference", "productMills"], ["Packaging difference", "packagingMills"], ["Landed difference", "landedMills"], ["Total difference", "totalMills"] ] as const).map(([label, key]) => <div key={key}><dt>{label}</dt><dd className="font-mono">{formatWorkspaceMills(review.differences[key], "USD")}</dd></div>)}</dl>
    <p className="text-xs text-muted-foreground">Positive differences are returned value above supplier credit; negative differences are supplier credit above returned value. Total difference includes credit awaiting component attribution.</p>
    {review.differences.unassignedCreditCents > 0 && <p className="text-sm rounded border border-amber-400 p-2">{formatPaymentAmount(review.differences.unassignedCreditCents)} of existing supplier credit still needs component attribution.</p>}
    {review.latestReview && <p className="text-sm">{review.reviewCurrent ? `Current follow-up: ${dispositionLabels[review.latestReview.disposition]}.` : "The previous review is stale because returned costs or supplier credits changed. Review the current evidence again."}</p>}
    <p className="text-sm">Awaiting or declined records the supplier follow-up. Any remaining difference stays unresolved; this review does not create a refund or expense.</p>
  </section>;
}
export function SupplierReturnCreditReview({ entitlementId, returnId, commands, onClose }: { entitlementId: number; returnId: number; commands: SupplierReturnCommands; onClose: () => void }) {
  const actor = useRef(commands.userId); actor.current = commands.userId;
  const query = useQuery({ queryKey: [`/api/supplier-return-entitlements/${entitlementId}/review`, commands.userId], staleTime: 0, retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/supplier-return-entitlements/${entitlementId}/review`, { credentials: "include", signal });
      if (!response.ok) throw new Error("Current return value and supplier credits could not be loaded.");
      const data = supplierReturnCreditReviewSchema.parse(await response.json());
      if (data.entitlementId !== entitlementId || data.returnId !== returnId) throw new Error("Credit difference evidence belongs to another return.");
      return data;
    },
  });
  const [reviewed, setReviewed] = useState<Review | null>(null);
  const [assignments, setAssignments] = useState<Record<number, AssignmentDraft>>({});
  const [disposition, setDisposition] = useState<keyof typeof dispositionLabels>("attribution_only");
  const [evidence, setEvidence] = useState(""); const [reason, setReason] = useState(""); const [acknowledged, setAcknowledged] = useState(false); const [error, setError] = useState<string | null>(null);
  function acceptSource(value: Review) { setReviewed(value); setAssignments(attributionDrafts(value)); setDisposition("attribution_only"); setEvidence(""); setReason(""); setAcknowledged(false); setError(null); }
  useEffect(() => { if (!reviewed && query.data) acceptSource(query.data); }, [query.data, reviewed]);
  useEffect(() => { setReviewed(null); setAssignments({}); setEvidence(""); setReason(""); setAcknowledged(false); setError(null); }, [commands.userId, entitlementId]);
  useEffect(() => { const result = commands.confirmed; if (result?.command === "review_credit_difference" && result.entitlementId === entitlementId && result.actorId === actor.current) acceptSource(result.review); }, [commands.confirmed, entitlementId]);
  const changed = reviewed !== null && query.data?.version !== reviewed.version;
  const blocked = commands.blocked || !commands.canApprove || query.isFetching || query.isError || changed || !reviewed;
  async function reload() { const currentActor = commands.userId; const result = await query.refetch(); if (result.data && !result.error && actor.current === currentActor) acceptSource(result.data); }
  async function submit() {
    if (blocked || !reviewed || !acknowledged) return;
    const submittedActor = commands.userId;
    try {
      const allocation = Object.entries(assignments).filter(([, value]) => Object.values(value).some(field => field.trim())).map(([id, value]) => {
        const link = reviewed.creditLinks.find(row => row.id === Number(id) && row.status === "approved" && row.component === "unassigned");
        if (!link) throw new Error("An attributed credit is no longer an active unassigned source. Reload the evidence.");
        const cents = { productCents: parsePaymentAmount(value.product.trim() || "0"), packagingCents: parsePaymentAmount(value.packaging.trim() || "0"), landedCents: parsePaymentAmount(value.landed.trim() || "0") };
        for (const component of ["product", "packaging", "landed"] as const) if (cents[`${component}Cents`] > 0 && !link.attributionComponents.includes(component)) throw new Error("The original invoice does not authorize this component attribution.");
        if (sumPaymentCents(Object.values(cents)) !== link.amountCents) throw new Error(`Attribution for ${link.supplierReference} must equal its existing ${formatPaymentAmount(link.amountCents)} credit exactly.`);
        return { creditLinkId: link.id, ...cents };
      });
      const payload = supplierReturnCreditReviewInputSchema.parse({ expectedVersion: reviewed.version, reason, evidenceReference: evidence, disposition, assignments: allocation });
      setError(null); await commands.execute({ command: "review_credit_difference", entitlementId, payload, reviewed });
    } catch (failure) {
      if (actor.current !== submittedActor) return;
      if (failure instanceof FinancialCommandRequestError && !failure.ambiguous && failure.details?.supplierReturnCommandOutcome === "rejected" && failure.details.actorId === submittedActor && failure.details.command === "review_credit_difference" && failure.details.entitlementId === entitlementId) setAcknowledged(false);
      setError(failure instanceof Error ? failure.message : "Review the difference fields.");
    }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="w-[calc(100%-2rem)] max-w-3xl max-h-[90vh] overflow-y-auto">
    <DialogHeader><DialogTitle>Review supplier credit difference</DialogTitle><DialogDescription>Credit matching for return #{returnId}. The recorded return and supplier document amounts stay unchanged.</DialogDescription></DialogHeader>
    {(commands.recovery || commands.storageError) && <SupplierReturnRecovery commands={commands} />}
    {query.isPending ? <p role="status">Loading return credit evidence…</p> : query.isError || !reviewed ? <div role="alert"><p>Return credit evidence is unavailable.</p><Button onClick={() => void reload()}>Retry credit difference evidence</Button></div> : <div className="space-y-4">
      <SupplierReturnDifferenceSummary review={reviewed} />
      {changed && <p role="alert">Returned costs or credits changed after this review opened. Reload the evidence before recording a review.</p>}
      <Button variant="outline" disabled={query.isFetching || commands.pending} onClick={() => void reload()}>Reload credit difference evidence</Button>
      <fieldset disabled={blocked} className="space-y-4">
        {reviewed.creditLinks.filter(link => link.status === "approved" && link.component === "unassigned").map(link => {
          const value = assignments[link.id] ?? { product: "", packaging: "", landed: "" };
          return <section key={link.id} aria-label={`Attribute credit ${link.supplierReference}`} className="rounded border p-3 space-y-3"><p className="font-medium">{link.supplierReference}: {formatPaymentAmount(link.amountCents)} combined supplier credit</p><p className="text-sm">Attribute the existing document amount using its evidence. Leave all fields blank to retain an unassigned amount.</p>
            <div className="grid gap-3 sm:grid-cols-3">{(["product", "packaging", "landed"] as const).map(component => <div key={component}><Label htmlFor={`attribute-${link.id}-${component}`}>{component} amount</Label><Input id={`attribute-${link.id}-${component}`} inputMode="decimal" value={value[component]} disabled={!link.attributionComponents.includes(component)} placeholder="0.00" onChange={event => { setAssignments(current => ({ ...current, [link.id]: { ...value, [component]: event.target.value } })); setAcknowledged(false); }} /></div>)}</div>
            {!link.attributionComponents.includes("landed") && <p className="text-xs text-muted-foreground">This source invoice does not authorize landed-cost attribution; a freight credit requires its own verified invoice source.</p>}
          </section>;
        })}
        <div><Label htmlFor="return-credit-disposition">Difference follow-up</Label><select id="return-credit-disposition" className="w-full rounded border bg-background p-2" value={disposition} onChange={event => { const parsed = supplierReturnCreditReviewDispositionSchema.safeParse(event.target.value); if (parsed.success) setDisposition(parsed.data); setAcknowledged(false); }}>{Object.entries(dispositionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div><Label htmlFor="return-credit-evidence">Supplier evidence reference</Label><Input id="return-credit-evidence" maxLength={1000} value={evidence} onChange={event => { setEvidence(event.target.value); setAcknowledged(false); }} /></div>
        <div><Label htmlFor="return-credit-reason">Reason for difference review</Label><Textarea id="return-credit-reason" maxLength={2000} value={reason} onChange={event => { setReason(event.target.value); setAcknowledged(false); }} /></div>
        <label className="flex items-start gap-3 text-sm"><input className="mt-1 size-5 shrink-0" type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />I reviewed the current returned value, supplier credit and supporting evidence.</label>
        <Button disabled={!acknowledged || !evidence.trim() || reason.trim().length < 3} onClick={() => void submit()}>{commands.pending ? "Recording review…" : "Record credit difference review"}</Button>
      </fieldset>
      {!commands.canApprove && <p>Purchasing approval permission is required to record this review.</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {reviewed.reviewHistory.length > 0 && <details><summary className="cursor-pointer py-2">Previous difference reviews</summary><div className="space-y-2">{reviewed.reviewHistory.map(entry => <article key={entry.id} className="rounded border p-3 text-sm"><p className="font-medium">{dispositionLabels[entry.disposition]}</p><p>{entry.evidenceReference} · {entry.reason}</p><p>{entry.recordedBy} · {formatWorkspaceDate(entry.recordedAt)} · Review #{entry.id}</p>{entry.assignments.map(row => <p key={row.creditLinkId}>Credit link #{row.creditLinkId}: product {formatPaymentAmount(row.productCents)}, packaging {formatPaymentAmount(row.packagingCents)}, landed {formatPaymentAmount(row.landedCents)}</p>)}</article>)}</div></details>}
    </div>}
    <Button variant="outline" onClick={onClose}>Close difference review</Button>
  </DialogContent></Dialog>;
}
