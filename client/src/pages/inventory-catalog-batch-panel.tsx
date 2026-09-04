import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  INVENTORY_CATALOG_BATCH_LIMIT, catalogBatchAction, catalogBatchExecutionPreview,
  inventoryCatalogBatchPreviewSchema, inventoryCatalogBatchExecuteRequestSchema,
  inventoryCatalogBatchResultSchema, type InventoryCatalogBatchPreview,
} from "@shared/types/inventory-catalog-batch";
import type { InventoryAvailabilityBackfillQueueRow } from "@shared/types/inventory-availability-backfill";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

const endpoint = "/api/inventory-planning/admin/migration-queue/batch";

export function InventoryCatalogBatchPanel({ rows, canEdit }: {
  rows: InventoryAvailabilityBackfillQueueRow[]; canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<InventoryCatalogBatchPreview["mode"]>("drafts");
  const [selection, setSelection] = useState<number[]>([]);
  const [preview, setPreview] = useState<InventoryCatalogBatchPreview | null>(null);
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState<"approved" | "changes_required">("approved");
  const [confirmed, setConfirmed] = useState(false);
  const previewMutation = useMutation({
    mutationFn: async () => inventoryCatalogBatchPreviewSchema.parse(await (
      await apiRequest("POST", `${endpoint}/preview`, { mode, productIds: selection })).json()),
    onSuccess: (value) => { setPreview(value); setConfirmed(false); executeMutation.reset(); },
  });
  const executeMutation = useMutation({
    mutationFn: async () => {
      const request = inventoryCatalogBatchExecuteRequestSchema.parse({ preview: preview && catalogBatchExecutionPreview(preview), reason,
        decision: mode === "reviews" ? decision : null });
      return inventoryCatalogBatchResultSchema.parse(await (
        await apiRequest("POST", `${endpoint}/execute`, request)).json());
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/inventory-planning/admin/migration-queue"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/inventory-planning/admin/supply-transformations"] }),
      ]);
    },
  });
  const busy = previewMutation.isPending || executeMutation.isPending;
  // Freeze the submitted manifest/reason/decision after an uncertain response. A retry
  // must reproduce the same persisted receipt keys, not create a second review.
  const submitted = executeMutation.isSuccess || executeMutation.isError;
  const eligible = rows.filter((row) => catalogBatchAction(mode, row) !== "skip");
  const error = previewMutation.error ?? executeMutation.error;
  function reset() {
    setPreview(null); setSelection([]); setConfirmed(false); setReason("");
    previewMutation.reset(); executeMutation.reset();
  }
  return <Card>
    <CardHeader><CardTitle>Catalog batch: draft updates and review</CardTitle>
      <p className="text-sm text-muted-foreground">Select up to {INVENTORY_CATALOG_BATCH_LIMIT} products.
        Draft updates and review are separate steps. Neither changes live inventory, sales-channel quantities,
        or runtime authority. Operator-authored drafts are never changed here.</p></CardHeader>
    <CardContent className="space-y-4">
      <label className="block">Batch step <select className="ml-2 rounded border p-2" value={mode}
        disabled={busy || preview !== null} onChange={(event) => { setMode(event.target.value as typeof mode); reset(); }}>
        <option value="drafts">1. Create missing / refresh stale drafts</option>
        <option value="reviews">2. Review exact current drafts</option>
      </select></label>
      {!preview && <>
        <p className="text-sm">{eligible.length} eligible products in the current queue. {selection.length} selected.</p>
        <Button variant="outline" disabled={busy || eligible.length === 0}
          onClick={() => setSelection(eligible.slice(0, INVENTORY_CATALOG_BATCH_LIMIT).map((row) => row.productId))}>
          Select next {INVENTORY_CATALOG_BATCH_LIMIT}</Button>
        <div className="max-h-64 overflow-auto rounded border">
          {eligible.map((row) => <label key={row.productId} className="flex gap-2 border-b p-2 text-sm">
            <input type="checkbox" checked={selection.includes(row.productId)} disabled={busy
              || (!selection.includes(row.productId) && selection.length >= INVENTORY_CATALOG_BATCH_LIMIT)}
              onChange={(event) => setSelection(event.target.checked ? [...selection, row.productId]
                : selection.filter((id) => id !== row.productId))} />
            {row.productSku ?? `Product ${row.productId}`} — {row.productName} — {catalogBatchAction(mode, row)}
          </label>)}
        </div>
      </>}
      <label className="block text-sm">Audit reason
        <Textarea value={reason} maxLength={1000} disabled={busy || submitted}
          onChange={(event) => { setReason(event.target.value); setConfirmed(false); }} />
      </label>
      {mode === "reviews" && <label className="block">Decision <select className="ml-2 rounded border p-2"
        value={decision} disabled={busy || submitted}
        onChange={(event) => { setDecision(event.target.value as typeof decision); setConfirmed(false); }}>
        <option value="approved">Approve the exact definitions below</option>
        <option value="changes_required">Changes required</option>
      </select></label>}
      {!preview && <Button disabled={busy || selection.length === 0} onClick={() => previewMutation.mutate()}>
        Preview selected products</Button>}
      {preview && <>
        <p className="break-all text-xs">Preview: {preview.previewHash}</p>
        {preview.products.map((row) => <details key={row.productId} className="rounded border p-3">
          <summary>{row.productSku ?? `Product ${row.productId}`} — {row.productName} — {catalogBatchAction(preview.mode, row)}
            {row.classification === "recipe_managed_explicit_review" ? " — recipe review required" : ""}</summary>
          <p className="text-sm">Current draft: {row.draft ? `v${row.draft.version}` : "none"}.
            Build to promise: {row.candidateDefinition?.buildToPromiseEnabled ? "enabled in this draft" : "disabled"}.</p>
          {row.candidateDefinition?.paths.length === 0 && <p className="text-sm">No package conversions allowed.</p>}
          {row.candidateDefinition?.paths.map((path, index) => <p key={index} className="text-sm">
            {path.authorityState}: {path.inputQty} source package(s)
            → {path.outputQty} destination package(s) ({path.operationType})
          </p>)}
          {row.issues.map((issue, index) => <p key={index} className="text-sm">{issue.code}: {issue.message}</p>)}
          <details><summary className="text-sm">Exact definition and recipe evidence</summary>
            <p className="break-all text-xs">Definition: {row.candidateDefinitionHash}</p>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(row.candidateDefinition, null, 2)}</pre>
          </details>
        </details>)}
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy}
          onChange={(event) => setConfirmed(event.target.checked)} />
          {mode === "reviews" ? "I reviewed the exact selected definitions, including recipe and conversion rules."
            : "Apply only the draft changes in this preview. This does not approve them."}</label>
        <div className="flex gap-2">
          <Button disabled={!canEdit || busy || !confirmed || !reason.trim()
            || (executeMutation.isSuccess && executeMutation.data.rows.every((row) => row.status !== "failed" && row.status !== "not_attempted"))}
            onClick={() => executeMutation.mutate()}>
            {submitted ? "Retry unchanged batch" : mode === "drafts" ? "Apply draft batch" : "Record review batch"}
          </Button>
          <Button variant="outline" disabled={busy} onClick={reset}>Start a new batch</Button>
        </div>
      </>}
      {error && <p role="alert" className="text-sm text-red-700">{error.message}</p>}
      {executeMutation.data && <div aria-live="polite" className="space-y-2">
        <p className="text-sm">Each product commits separately. Successful rows remain saved if another fails.
          A new preview is required for stale evidence; unchanged transient failures can be retried.</p>
        {executeMutation.data.rows.map((row) => <p key={row.productId} className="text-sm">
          {preview?.products.find((product) => product.productId === row.productId)?.productSku ?? row.productId}:
          {" "}{row.status} — {row.message} {row.failureClass && `(${row.code}; ${row.failureClass})`}
        </p>)}
      </div>}
    </CardContent>
  </Card>;
}
