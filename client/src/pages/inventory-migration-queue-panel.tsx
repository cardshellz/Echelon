import React from "react";
import { Link } from "wouter";
import { ShieldCheck } from "lucide-react";
import type { InventoryAvailabilityBackfillQueueResponse, InventoryAvailabilityBackfillQueueRow } from "@shared/types/inventory-availability-backfill";
import { bindingSnapshotEquation, type SupplyTransformationsAdminView } from "./supply-transformations-model";
import { inventoryPlanningProductHref } from "./inventory-planning-navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function MigrationQueuePanel({
  queue,
  rows,
  selectedRow,
  selectedView,
  isLoading,
  error,
  canEdit,
  search,
  stateFilter,
  backfillReason,
  refreshBackfillReason,
  reviewReason,
  isApplying,
  isRefreshing,
  isReviewing,
  onSearchChange,
  onStateFilterChange,
  onSelectProduct,
  onBackfillReasonChange,
  onRefreshBackfillReasonChange,
  onReviewReasonChange,
  onApply,
  onRefresh,
  onReview,
}: {
  queue: InventoryAvailabilityBackfillQueueResponse | null;
  rows: InventoryAvailabilityBackfillQueueRow[];
  selectedRow: InventoryAvailabilityBackfillQueueRow | null;
  selectedView: SupplyTransformationsAdminView | null;
  isLoading: boolean;
  error: Error | null;
  canEdit: boolean;
  search: string;
  stateFilter: string;
  backfillReason: string;
  refreshBackfillReason: string;
  reviewReason: string;
  isApplying: boolean;
  isRefreshing: boolean;
  isReviewing: boolean;
  onSearchChange: (value: string) => void;
  onStateFilterChange: (value: string) => void;
  onSelectProduct: (productId: number) => void;
  onBackfillReasonChange: (value: string) => void;
  onRefreshBackfillReasonChange: (value: string) => void;
  onReviewReasonChange: (value: string) => void;
  onApply: (row: InventoryAvailabilityBackfillQueueRow) => void;
  onRefresh: (row: InventoryAvailabilityBackfillQueueRow) => void;
  onReview: (
    row: InventoryAvailabilityBackfillQueueRow,
    decision: "approved" | "changes_required",
  ) => void;
}) {
  const isManual = selectedRow?.draft?.origin === "operator";
  const reviewDefinition = isManual
    ? selectedRow?.draftDefinition
    : selectedRow?.candidateDefinition;
  const variants = selectedView?.product.id === selectedRow?.productId
    ? selectedView?.variants ?? [] : [];
  const manualEvidenceReady = !isManual || (selectedView?.product.id === selectedRow?.productId
    && selectedView?.draftModel?.id === selectedRow?.draft?.modelId
    && selectedView?.draftModel?.definitionHash === selectedRow?.draft?.definitionHash
    && selectedView?.head?.revision === selectedRow?.draft?.headRevision);
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Phase 3 migration queue</CardTitle>
        <p className="text-sm text-muted-foreground">
          Every active product is classified by one deterministic algorithm. Applying a candidate
          creates only a draft; approval is review evidence, not activation.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <div className="text-sm text-muted-foreground">Classifying active products…</div>}
        {error && <div className="text-sm text-destructive">{error.message}</div>}
        {queue && (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">{queue.summary.totalActiveProducts} active</Badge>
              <Badge variant="destructive">{queue.summary.blocked} blocked</Badge>
              <Badge variant="secondary">{queue.summary.excluded} excluded from ATP</Badge>
              <Badge variant="outline">{queue.summary.notBackfilled} not backfilled</Badge>
              <Badge variant="outline">{queue.summary.conflictingDraft} conflicting draft</Badge>
              <Badge variant="outline">{queue.summary.awaitingReview} awaiting review</Badge>
              <Badge variant="outline">{queue.summary.changesRequired} changes required</Badge>
              <Badge>{queue.summary.approved} approved</Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="migration-queue-search">Search full queue</Label>
                <Input
                  id="migration-queue-search"
                  value={search}
                  onChange={(event) => onSearchChange(event.target.value)}
                  placeholder="Product ID, SKU, or name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="migration-queue-state">Queue state</Label>
                <select
                  id="migration-queue-state"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={stateFilter}
                  onChange={(event) => onStateFilterChange(event.target.value)}
                >
                  <option value="all">All states</option>
                  <option value="blocked">Blocked</option>
                  <option value="excluded">Excluded from ATP</option>
                  <option value="not_backfilled">Not backfilled</option>
                  <option value="conflicting_draft">Conflicting draft</option>
                  <option value="awaiting_review">Awaiting review</option>
                  <option value="changes_required">Changes required</option>
                  <option value="approved">Approved</option>
                </select>
              </div>
            </div>
            <div className="max-h-[32rem] overflow-auto rounded-md border">
              <table className="w-full min-w-[920px] text-left text-sm">
                <thead className="sticky top-0 border-b bg-muted text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">State</th>
                    <th className="px-3 py-2">Legacy strategy</th>
                    <th className="px-3 py-2">Candidate</th>
                    <th className="px-3 py-2 text-right">Variants</th>
                    <th className="px-3 py-2 text-right">Recipes</th>
                    <th className="px-3 py-2 text-right">Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.productId}
                      className={`cursor-pointer border-b last:border-b-0 hover:bg-muted/40 ${
                        selectedRow?.productId === row.productId ? "bg-blue-50" : ""
                      }`}
                      onClick={() => onSelectProduct(row.productId)}
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium">{row.productSku ?? `Product ${row.productId}`}</div>
                        <div className="text-xs text-muted-foreground">{row.productName}</div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={row.queueState === "blocked" ? "destructive" : "outline"}>
                          {formatQueueState(row.queueState)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">{row.legacyInventoryStrategy}</td>
                      <td className="px-3 py-2">{formatQueueState(row.classification)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.activeVariantCount}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.activeRecipeCount}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.issues.length}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No products match.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="text-xs text-muted-foreground">
              Input {queue.catalogInputHash.slice(0, 12)} · result {queue.catalogResultHash.slice(0, 12)} ·
              captured {new Date(queue.capturedAt).toLocaleString()}
            </div>
          </>
        )}

        {selectedRow && (
          <div className="space-y-4 rounded-md border p-4">
            <div>
              <div className="font-semibold">
                {selectedRow.productSku ?? `Product ${selectedRow.productId}`} — {selectedRow.productName}
              </div>
              <div className="text-xs text-muted-foreground">
                {isManual ? "Saved manual rules" : "Generated candidate"} {(
                  isManual ? selectedRow.draft?.definitionHash : selectedRow.candidateDefinitionHash
                )?.slice(0, 12) ?? "blocked"} ·
                input {selectedRow.inputHash.slice(0, 12)} · result {selectedRow.resultHash.slice(0, 12)}
              </div>
            </div>
            <Link
              href={inventoryPlanningProductHref("/inventory/supply-transformations", selectedRow.productId)}
              className="inline-block text-sm underline underline-offset-2"
            >
              Open product transformation editor
            </Link>
            {reviewDefinition && (
              <div className="grid gap-3 text-sm md:grid-cols-3">
                <div>Directed paths: {reviewDefinition.paths.length}</div>
                <div>Recipe bindings: {reviewDefinition.recipeBindings.length}</div>
                <div>Build-to-promise: {reviewDefinition.buildToPromiseEnabled ? "enabled" : "off"}</div>
              </div>
            )}
            {isManual && reviewDefinition && (
              <div className="space-y-2 rounded-md border p-3 text-sm">
                <div className="font-medium">Exact saved directions being reviewed</div>
                {reviewDefinition.paths.map((path) => (
                  <div key={`${path.sourceVariantId}:${path.destinationVariantId}`}>
                    {path.inputQty} × {variantById.get(path.sourceVariantId)?.sku
                      ?? `variant #${path.sourceVariantId}`} → {path.outputQty} ×{" "}
                    {variantById.get(path.destinationVariantId)?.sku
                      ?? `variant #${path.destinationVariantId}`} — {path.authorityState}
                  </div>
                ))}
                <div className="text-muted-foreground">
                  Every conversion step requires a listed allowed direction. Approving does not add the reverse direction.
                  Review the exact saved definition and recipe evidence before approving.
                </div>
                {!manualEvidenceReady && (
                  <div className="text-amber-800">
                    Waiting for matching product and draft details. If they do not load, reload
                    the page before reviewing.
                  </div>
                )}
              </div>
            )}
            {isManual && reviewDefinition && (
              <details className="rounded-md border p-3 text-sm">
                <summary>Exact saved definition and recipe evidence</summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(reviewDefinition, null, 2)}
                </pre>
                {manualEvidenceReady && selectedView?.draftModel && (
                  <div className="mt-3 space-y-2 border-t pt-3">
                    <div className="font-medium">Immutable recipe snapshots</div>
                    {selectedView.draftModel.bindings.length === 0 && (
                      <div className="text-muted-foreground">None recorded.</div>
                    )}
                    {selectedView.draftModel.bindings.map((binding) => (
                      <div key={binding.bindingKey} className="rounded-md border p-3">
                        <div className="font-medium">{binding.recipeCodeSnapshot} v{binding.recipeVersionSnapshot}</div>
                        <div>{bindingSnapshotEquation(binding, selectedView.variants)}</div>
                        <div className="break-all text-xs text-muted-foreground">
                          Immutable recipe hash: {binding.recipeDefinitionHash} · Scope:{" "}
                          {binding.warehouseId === null ? "network" : `warehouse ${binding.warehouseId}`}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </details>
            )}
            {selectedRow.issues.length > 0 && (
              <div className="space-y-2">
                {selectedRow.issues.map((entry) => (
                  <div
                    key={`${entry.code}:${entry.message}`}
                    className={`rounded-md border p-3 text-sm ${
                      entry.severity === "blocking"
                        ? "border-red-300 bg-red-50 text-red-900"
                        : "border-amber-300 bg-amber-50 text-amber-900"
                    }`}
                  >
                    <span className="font-medium">{entry.code}</span>: {entry.message}
                  </div>
                ))}
              </div>
            )}
            {selectedRow.draft && (
              <div className="text-sm">
                Draft v{selectedRow.draft.version} · {selectedRow.draft.origin.replaceAll("_", " ")} ·
                definition {selectedRow.draft.definitionHash.slice(0, 12)} ·
                {isManual
                  ? selectedRow.draft.operatorInputHash === selectedRow.inputHash
                    ? " manual rules; catalog source unchanged"
                    : " manual rules; catalog source changed — save a new version before review"
                  : selectedRow.draft.candidateMatch
                  ? " exact definition and provenance match"
                  : selectedRow.draft.definitionMatch
                    ? " definition matches, provenance is stale"
                    : " definition differs"}
              </div>
            )}
            {canEdit && selectedRow.queueState === "not_backfilled" && (
              <div className="space-y-3">
                <Label htmlFor="backfill-change-reason">Draft reason</Label>
                <Textarea
                  id="backfill-change-reason"
                  value={backfillReason}
                  onChange={(event) => onBackfillReasonChange(event.target.value)}
                  placeholder="Why this deterministic legacy-to-draft mapping is being recorded"
                />
                <Button
                  type="button"
                  disabled={!backfillReason.trim() || isApplying || !selectedRow.candidateDefinition}
                  onClick={() => onApply(selectedRow)}
                >
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  {isApplying ? "Recording draft…" : "Record deterministic draft"}
                </Button>
              </div>
            )}
            {canEdit && selectedRow.queueState === "conflicting_draft"
              && selectedRow.draft?.origin === "phase3_backfill" && (
              <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3">
                <div className="text-sm text-amber-900">
                  The existing Phase 3 draft does not exactly match the current deterministic
                  input, result, and definition. Refreshing preserves it as immutable history and
                  creates the next inactive draft version.
                </div>
                <Label htmlFor="backfill-refresh-reason">Supersession reason</Label>
                <Textarea
                  id="backfill-refresh-reason"
                  value={refreshBackfillReason}
                  onChange={(event) => onRefreshBackfillReasonChange(event.target.value)}
                  placeholder="Why this stale deterministic draft is being superseded"
                />
                <Button
                  type="button"
                  disabled={!refreshBackfillReason.trim() || isRefreshing || !selectedRow.candidateDefinition}
                  onClick={() => onRefresh(selectedRow)}
                >
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  {isRefreshing ? "Refreshing draft…" : "Supersede and refresh draft"}
                </Button>
              </div>
            )}
            {selectedRow.queueState === "conflicting_draft"
              && selectedRow.draft?.origin === "operator" && (
              <div className="text-sm text-amber-800">
                This draft was authored by an operator. Deterministic backfill will not overwrite
                or supersede it; review and edit it manually.
              </div>
            )}
            {canEdit && ["awaiting_review", "changes_required"].includes(selectedRow.queueState)
              && selectedRow.draft && (
              <div className="space-y-3">
                <Label htmlFor="backfill-review-reason">Review reason</Label>
                <Textarea
                  id="backfill-review-reason"
                  value={reviewReason}
                  onChange={(event) => onReviewReasonChange(event.target.value)}
                  placeholder="Evidence supporting approval or required changes"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={!reviewReason.trim() || isReviewing || !manualEvidenceReady}
                    onClick={() => onReview(selectedRow, "approved")}
                  >
                    Approve saved rules
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!reviewReason.trim() || isReviewing || !manualEvidenceReady}
                    onClick={() => onReview(selectedRow, "changes_required")}
                  >
                    Require changes
                  </Button>
                </div>
              </div>
            )}
            {selectedRow.review && (
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                Review: {formatQueueState(selectedRow.review.decision)} by {selectedRow.review.reviewedBy}
                {" "}on {new Date(selectedRow.review.reviewedAt).toLocaleString()} — {selectedRow.review.reason}
              </div>
            )}
            {selectedRow.queueState === "changes_required" && (
              <div className="text-sm text-amber-800">
                Open the product editor if its definition is wrong, or record a later approval with
                new evidence. The review ledger preserves both decisions.
              </div>
            )}
            {selectedRow.queueState === "approved" && (
              <div className="font-medium text-emerald-700">
                Approved — not live. These saved rules are approved for activation, but this
                approval does not change the rules currently in use.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatQueueState(value: string): string {
  return value.replaceAll("_", " ");
}
