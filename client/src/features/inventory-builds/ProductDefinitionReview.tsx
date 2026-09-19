import React, { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupplyTransformationsAdminView } from "@shared/types/inventory-availability-admin";
import { productDefinitionReviewSchema, productDefinitionReceiptSchema, productDefinitionProgressSchema,
  type ApplyProductDefinition, type ProductDefinitionReview as Review,
} from "@shared/types/inventory-product-definition";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { fetchJson, HttpResponseError } from "@/pages/inventory-planning-http";
import { transformationQueryKey } from "./package-conversion-draft";

const endpoint = "/api/inventory-planning/admin/product-definitions";
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Mounted only by the planning-view-authorized product card. */
export function ProductDefinitionReview({ view, onApplyBlockedChange }: {
  view: SupplyTransformationsAdminView; onApplyBlockedChange: (blocked: boolean) => void;
}) {
  const { hasPermission } = useAuth();
  const canApply = hasPermission("inventory_planning", "activate");
  const client = useQueryClient();
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const command = useRef<ApplyProductDefinition | null>(null);
  const draft = view.draftModel;
  const progressKey = [endpoint, view.product.id, "progress"];
  const progress = useQuery({ queryKey: progressKey,
    queryFn: ({ signal }) => fetchJson(`${endpoint}/${view.product.id}/progress`, productDefinitionProgressSchema.nullable(), { signal }),
    retry: false,
    refetchInterval: query => query.state.data?.publications.some(row => ["desired", "queued", "leased", "published", "acknowledged", "retryable", "drifted"].includes(row.state)) ? 5000 : false,
  });
  const preview = useMutation({
    mutationFn: () => {
      if (!draft || !view.head) throw new Error("Save a draft before reviewing.");
      return fetchJson(`${endpoint}/review`, productDefinitionReviewSchema, post({ productId: view.product.id,
        draftModelId: draft.id, expectedHeadRevision: view.head.revision, expectedDefinitionHash: draft.definitionHash }));
    },
    onSuccess: result => { setReview(result); setError(null); command.current = null; },
    onError: failure => { setReview(null); setError(failure.message); },
  });
  const apply = useMutation({
    mutationFn: () => {
      if (!canApply || !review) throw new Error("Apply permission and a reviewed draft are required.");
      command.current ??= { ...review.selection, expectedReviewHash: review.reviewHash,
        idempotencyKey: `product-definition:${view.product.id}:${crypto.randomUUID()}` };
      return fetchJson(`${endpoint}/apply`, productDefinitionReceiptSchema, post(command.current));
    },
    onSuccess: async () => {
      command.current = null; setUncertain(false); setReview(null); setError(null);
      await Promise.all([client.invalidateQueries({ queryKey: transformationQueryKey(view.product.id) }),
        client.invalidateQueries({ queryKey: progressKey })]);
    },
    onError: failure => {
      const rejected = failure instanceof HttpResponseError && failure.status >= 400 && failure.status < 500;
      setUncertain(!rejected);
      if (rejected) { command.current = null; setReview(null); }
      setError(rejected ? failure.message : "Apply outcome is unknown. Retry the same Apply command to retrieve its recorded result.");
    },
  });
  const stale = review && (review.selection.draftModelId !== draft?.id
    || review.selection.expectedDefinitionHash !== draft?.definitionHash || review.selection.expectedHeadRevision !== view.head?.revision);
  useEffect(() => { onApplyBlockedChange(apply.isPending || uncertain); }, [apply.isPending, uncertain, onApplyBlockedChange]);
  return <section className="space-y-3 border-t pt-4" aria-label="Review and apply conversion rules">
    {draft && <Button variant="outline" onClick={() => preview.mutate()} disabled={preview.isPending || apply.isPending || uncertain}>
      {preview.isPending ? "Reviewing…" : "Review draft changes"}</Button>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {review && <div className="space-y-3 rounded-md border p-3">
      <h3 className="font-semibold">Current → Your changes</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {[{ label: "Current rules", model: view.activeModel }, { label: "Your saved draft", model: draft }].map(({ label, model }) =>
          <div key={label} className="rounded border p-2 text-sm">
            <h4 className="font-medium">{label}</h4>
            <p>{model ? `Version ${model.version} · Build to promise ${model.buildToPromiseEnabled ? "on" : "off"}` : "No active model"}</p>
            <ul>{model?.paths.map(path => <li key={`${path.sourceVariantId}:${path.destinationVariantId}`}>
              {path.inputQty} {view.variants.find(v => v.id === path.sourceVariantId)?.sku ?? path.sourceVariantId} → {path.outputQty} {view.variants.find(v => v.id === path.destinationVariantId)?.sku ?? path.destinationVariantId}: {path.authorityState}
            </li>)}</ul>
            <p>{model?.bindings.length ?? 0} recipe bindings</p>
          </div>)}
      </div>
      <p className="text-sm">{review.affectedProductIds.length} affected product(s), including dependent builds. Applying changes rules only—it does not move or assemble stock.</p>
      {stale && <p role="alert">The draft changed. Review it again.</p>}
      {review.blockers.length > 0 && <ul className="list-disc pl-5 text-sm text-destructive">{review.blockers.map(message => <li key={message}>{message}</li>)}</ul>}
      <div className="max-h-80 overflow-auto"><table className="w-full text-left text-sm">
        <caption className="text-left font-medium">Warehouse ATP</caption>
        <thead><tr><th>SKU</th><th>Warehouse</th><th>Current</th><th>Your changes</th></tr></thead>
        <tbody>{review.atp.map(row => <tr key={`${row.variantId}:${row.warehouseId}`}>
          <td className="break-all">{row.sku ?? row.variantId}</td><td>{row.warehouseName}</td><td>{row.current}</td><td>{row.proposed}</td>
        </tr>)}</tbody>
      </table></div>
      <details><summary className="cursor-pointer">Channel quantities ({review.channels.length})</summary>
        <ul className="max-h-60 overflow-auto text-sm">{review.channels.map(row => <li key={`${row.targetId}:${row.variantId}`}>
          {row.channelName} · {row.sku ?? row.variantId}: {row.current ?? "—"} → {row.proposed}
        </li>)}</ul>
      </details>
      <p className="text-sm text-muted-foreground">Channel updates start automatically after Apply. Provider confirmation is reported separately below.</p>
      {canApply ? <Button onClick={() => apply.mutate()} disabled={apply.isPending || (!uncertain && (!review.ready || !!stale))}>
        {apply.isPending ? "Applying…" : uncertain ? "Retry same Apply" : "Apply reviewed changes"}</Button>
        : <p className="text-sm">Your role can review but cannot apply inventory rules.</p>}
    </div>}
    {progress.isError ? <p role="alert" className="text-sm">Channel update status unavailable. <button className="underline" onClick={() => progress.refetch()}>Retry</button></p>
      : progress.data && <div className="rounded-md border p-3 text-sm" role="status">
        <p className="font-semibold">Rules applied</p>
        <p>{progress.data.receipt.appliedAt} · {progress.data.receipt.appliedBy}</p>
        {progress.data.publications.length === 0 ? <p>No live channel destinations required an update.</p>
          : <ul>{progress.data.publications.map(row => <li key={row.id}>
            Target {row.targetId}, SKU #{row.variantId}: {row.state === "verified" ? "Provider quantity verified" : row.state === "superseded" ? "Replaced by a newer inventory update" : row.state}
            {row.errorCode && ` — ${row.errorCode}`}
          </li>)}</ul>}
      </div>}
  </section>;
}
