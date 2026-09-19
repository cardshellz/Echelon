import React, { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PromiseSafetyPolicyHeadAdmin } from "@shared/types/inventory-promise-safety-admin";
import { safetyDefinitionReviewSchema, safetyDefinitionReceiptSchema, safetyDefinitionProgressSchema,
  type ApplySafetyDefinition, type SafetyDefinitionReview as Review,
} from "@shared/types/inventory-safety-definition";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { fetchJson, HttpResponseError } from "@/pages/inventory-planning-http";
import { formatPromiseSafetyPolicy } from "@/pages/promise-safety-policy-model";

const endpoint = "/api/inventory-planning/admin/safety-definitions";
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export function SafetyDefinitionReview({ head, scopeKey, onBlockedChange }: {
  head: PromiseSafetyPolicyHeadAdmin | null; scopeKey: string; onBlockedChange: (blocked: boolean) => void;
}) {
  const { hasPermission } = useAuth();
  const canApply = hasPermission("inventory_planning", "activate");
  const client = useQueryClient();
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const command = useRef<ApplySafetyDefinition | null>(null);
  const draft = head?.draftPolicy;
  const progressKey = [endpoint, scopeKey, "progress"];
  const progress = useQuery({ queryKey: progressKey,
    queryFn: ({ signal }) => fetchJson(`${endpoint}/progress?scopeKey=${encodeURIComponent(scopeKey)}`, safetyDefinitionProgressSchema.nullable(), { signal }),
    retry: false,
    refetchInterval: query => query.state.data?.publications.some(row => ["desired", "queued", "leased", "published", "acknowledged", "retryable", "drifted"].includes(row.state)) ? 5000 : false,
  });
  const preview = useMutation({
    mutationFn: () => {
      if (!draft || !head) throw new Error("Save a safety draft before reviewing.");
      return fetchJson(`${endpoint}/review`, safetyDefinitionReviewSchema, post({ scopeKey,
        draftPolicyId: draft.policyId, expectedHeadRevision: head.revision, expectedDefinitionHash: draft.definitionHash }));
    },
    onSuccess: result => { setReview(result); setError(null); command.current = null; },
    onError: failure => { setReview(null); setError(failure.message); },
  });
  const apply = useMutation({
    mutationFn: () => {
      if (!canApply || !review) throw new Error("Apply permission and a reviewed policy are required.");
      command.current ??= { ...review.selection, expectedReviewHash: review.reviewHash, idempotencyKey: `safety-definition:${crypto.randomUUID()}` };
      return fetchJson(`${endpoint}/apply`, safetyDefinitionReceiptSchema, post(command.current));
    },
    onSuccess: async () => {
      command.current = null; setUncertain(false); setReview(null); setError(null);
      // Business and SKU policies can be visible on multiple product pages.
      await Promise.all([client.invalidateQueries({ queryKey: ["/api/inventory-planning/admin/promise-safety"] }),
        client.invalidateQueries({ queryKey: progressKey })]);
    },
    onError: failure => {
      const rejected = failure instanceof HttpResponseError && failure.status >= 400 && failure.status < 500;
      setUncertain(!rejected);
      if (rejected) { command.current = null; setReview(null); }
      setError(rejected ? failure.message : "Apply outcome is unknown. Retry the same Apply command to retrieve its recorded result.");
    },
  });
  const stale = review && (review.selection.scopeKey !== scopeKey || review.selection.draftPolicyId !== draft?.policyId
    || review.selection.expectedDefinitionHash !== draft?.definitionHash || review.selection.expectedHeadRevision !== head?.revision);
  useEffect(() => { onBlockedChange(apply.isPending || uncertain); }, [apply.isPending, uncertain, onBlockedChange]);
  return <section className="space-y-3 border-t pt-4" aria-label="Review and apply safety policy">
    {draft && <Button variant="outline" disabled={preview.isPending || apply.isPending || uncertain} onClick={() => preview.mutate()}>
      {preview.isPending ? "Reviewing…" : "Review safety draft"}</Button>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {review && <div className="space-y-3 rounded-md border p-3">
      <h3 className="font-semibold">Safety policy: current → your changes</h3>
      <p className="text-sm">{review.previousPolicy ? formatPromiseSafetyPolicy(review.previousPolicy.value) : "No policy at this scope"} → {formatPromiseSafetyPolicy(review.proposedPolicy)}</p>
      <p className="text-sm">{review.selection.scopeKey === "business" ? "Business-wide review" : "Complete affected scope"}: {review.affectedProductIds.length} products, including dependent builds. No physical stock is moved.</p>
      {stale && <p role="alert">The draft changed. Review it again.</p>}
      <ul className="text-sm text-destructive">{review.blockers.map(message => <li key={message}>{message}</li>)}</ul>
      <div className="max-h-80 overflow-auto"><table className="w-full text-left text-sm">
        <caption className="text-left font-medium">Warehouse ATP</caption>
        <thead><tr><th>SKU</th><th>Warehouse</th><th>Current</th><th>Your changes</th></tr></thead>
        <tbody>{review.atp.map(row => <tr key={`${row.variantId}:${row.warehouseId}`}>
          <td className="break-all">{row.sku ?? row.variantId}</td><td>{row.warehouseName}</td><td>{row.current}</td><td>{row.proposed}</td>
        </tr>)}</tbody>
      </table></div>
      <details><summary>Channel quantities ({review.channels.length})</summary><ul className="max-h-60 overflow-auto text-sm">
        {review.channels.map(row => <li key={`${row.targetId}:${row.variantId}`}>{row.channelName} · {row.sku ?? row.variantId}: {row.current ?? "—"} → {row.proposed}</li>)}
      </ul></details>
      <p className="text-sm">Channel updates start automatically after Apply. Enqueued does not mean provider-confirmed.</p>
      {canApply ? <Button disabled={apply.isPending || (!uncertain && (!review.ready || !!stale))} onClick={() => apply.mutate()}>
        {apply.isPending ? "Applying…" : uncertain ? "Retry same safety Apply" : "Apply reviewed safety policy"}
      </Button> : <p className="text-sm">Your role can review but cannot apply safety policy.</p>}
    </div>}
    {progress.isError ? <p role="alert">Safety publication status unavailable. <button className="underline" onClick={() => progress.refetch()}>Retry</button></p>
      : progress.data && <div role="status" className="rounded-md border p-3 text-sm">
        <p className="font-medium">Safety policy applied</p>
        <p>{progress.data.receipt.appliedAt} · {progress.data.receipt.appliedBy}</p>
        {progress.data.publications.length ? <ul>{progress.data.publications.map(row => <li key={row.id}>
          Target {row.targetId}, SKU #{row.variantId}: {row.state === "verified" ? "Provider quantity verified" : row.state === "superseded" ? "Replaced by a newer inventory update" : row.state}{row.errorCode && ` — ${row.errorCode}`}
        </li>)}</ul> : <p>No live channel destinations required an update.</p>}
      </div>}
  </section>;
}
