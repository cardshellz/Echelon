import React, { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { commitInventoryCutoverRequestSchema, inventoryCutoverReviewSchema, inventoryCutoverCommitResultSchema } from "@shared/types/inventory-cutover-commit";
import { finishInventoryCutoverRequestSchema, finishInventoryCutoverResultSchema, inventoryCutoverVerificationSchema } from "@shared/types/inventory-cutover-completion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { isDefinitiveCutoverRejection, postCutoverCommand } from "./inventory-cutover-http";
export { postCutoverCommand } from "./inventory-cutover-http";

type Props = { actorId: string | null; canActivate: boolean; activationRunId: string; runtimeAuthority: "legacy" | "canonical";
  onStateChanged(): void };

/** Mounted with an actor/run/authority key: no operator's evidence or retry body
 * is reused after authentication or authority changes. Commands never auto-run.
 */
export function InventoryCutoverControls(props: Props) {
  const [reason, setReason] = useState("");
  const commitAttempt = useRef<z.infer<typeof commitInventoryCutoverRequestSchema> | null>(null);
  const finishAttempt = useRef<z.infer<typeof finishInventoryCutoverRequestSchema> | null>(null);
  const enabled = props.canActivate && props.actorId !== null;
  const canonical = props.runtimeAuthority === "canonical";
  const review = useQuery({ queryKey: ["cutover-final-review", props.actorId, props.activationRunId], enabled: false,
    queryFn: ({ signal }) => postCutoverCommand("review", { activationRunId: props.activationRunId }, inventoryCutoverReviewSchema, signal),
    retry: false, staleTime: 0, gcTime: 0 });
  const verification = useQuery({ queryKey: ["cutover-full-verification", props.actorId, props.activationRunId], enabled: false,
    queryFn: ({ signal }) => postCutoverCommand("verification", { activationRunId: props.activationRunId }, inventoryCutoverVerificationSchema, signal),
    retry: false, staleTime: 0, gcTime: 0 });

  const commit = useMutation({
    mutationFn: async () => {
      if (!enabled || canonical) throw new Error("An authorized operator must review this legacy-authority run.");
      if (!commitAttempt.current && (!review.data?.ready || review.isFetching || review.isError)) throw new Error("Capture an unblocked final review first.");
      commitAttempt.current ??= commitInventoryCutoverRequestSchema.parse({ activationRunId: props.activationRunId,
        expectedAuthorityRevision: review.data?.authorityRevision, expectedReviewHash: review.data?.reviewHash,
        idempotencyKey: `cutover:${crypto.randomUUID()}`, reason });
      return postCutoverCommand("commit", commitAttempt.current, inventoryCutoverCommitResultSchema);
    },
    onSuccess: () => { commitAttempt.current = null; props.onStateChanged(); },
    onError: (error) => {
      // A rejected/stale command can be reviewed again. An uncertain transport or
      // server outcome retains the exact request and retry key, including reason.
      if (isDefinitiveCutoverRejection(error)) commitAttempt.current = null;
      props.onStateChanged();
    },
  });
  const finish = useMutation({
    mutationFn: async () => {
      if (!enabled || !canonical) throw new Error("An authorized operator must verify this canonical-authority run.");
      if (!finishAttempt.current && (!verification.data?.ready || verification.isFetching || verification.isError)) throw new Error("Verify the complete latest full publication first.");
      finishAttempt.current ??= finishInventoryCutoverRequestSchema.parse({ activationRunId: props.activationRunId,
        expectedVerificationHash: verification.data?.verificationHash, idempotencyKey: `cutover-finish:${crypto.randomUUID()}`, reason });
      return postCutoverCommand("finish", finishAttempt.current, finishInventoryCutoverResultSchema);
    },
    onSuccess: () => { finishAttempt.current = null; void verification.refetch(); props.onStateChanged(); },
    onError: error => {
      if (isDefinitiveCutoverRejection(error)) finishAttempt.current = null;
      props.onStateChanged();
    },
  });
  const evidence = canonical ? verification : review;
  const pending = commit.isPending || finish.isPending;
  const error = commit.error ?? finish.error ?? evidence.error;
  const ready = enabled && !pending && !evidence.isFetching && !evidence.isError && evidence.data?.ready === true && reason.trim().length > 0;
  const retainedAttempt = commitAttempt.current !== null || finishAttempt.current !== null;
  const canRetry = enabled && !pending && retainedAttempt;
  if (!enabled) return <p className="text-sm text-muted-foreground">An operator with inventory activation permission can review and complete this cutover.</p>;

  return <section className="space-y-3 rounded-md border p-3" aria-label="Final inventory cutover controls">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="font-semibold">{canonical ? "Verify full publication and finish" : "Final cutover review"}</h3>
      <Badge variant="outline">{canonical ? "Canonical authority" : "Legacy authority"}</Badge>
    </div>
    <p className="text-sm text-muted-foreground">{canonical
      ? "Canonical ATP and reservations are active. Confirm the latest published quantities before releasing the configuration freeze. This does not return authority to legacy."
      : "Review existing reservations, picked stock and final channel quantities. Switching authority applies the reviewed full-catalog model and queues full publication."}</p>
    <Button variant="outline" disabled={pending || evidence.isFetching}
      onClick={() => { if (canonical) void verification.refetch(); else void review.refetch(); }}>
      {evidence.isFetching ? "Checking…" : canonical ? "Check full publication" : "Capture final review"}
    </Button>
    {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
    {retainedAttempt && !pending && <p className="text-sm">The last outcome is uncertain. A retry sends the same saved command and reason; check current run status first.</p>}
    {canRetry && <Button variant="outline" onClick={() => { if (canonical) finish.mutate(); else commit.mutate(); }}>Retry the same command</Button>}
    {evidence.data && <>
      <p className="text-xs text-muted-foreground">Evidence captured {evidence.data.capturedAt}. A changed result requires another review.</p>
      {!canonical && review.data && <p className="text-sm">{review.data.summary.orders} orders · {review.data.summary.lines} lines · {review.data.publicationRows.length} channel/variant quantities.</p>}
      {!canonical && review.data?.summary.openingBalance && <p className="rounded border p-2 text-sm" role="note">
        This review uses independently verified opening record {review.data.summary.openingBalance.snapshotId}.
        {" "}{review.data.summary.openingBalance.historicalExceptionCount} unresolved historical finding(s) are carried forward separately, not declared resolved.
        The final server check still rejects changed current stock, commitments or evidence.
      </p>}
      {!canonical && review.data?.summary.legacyPromiseReplanning && review.data.summary.legacyPromiseReplanning.positions > 0 &&
        <p className="text-sm" role="note">Re-plan {review.data.summary.legacyPromiseReplanning.orderLines} existing order line(s)
          {" "}from {review.data.summary.legacyPromiseReplanning.positions} empty-bin reservation position(s).
          {" "}Customer demand is retained. This handoff does not change on-hand or picked stock counts.</p>}
      {canonical && verification.data && <p className="text-sm">{verification.data.verifiedPublicationRows}/{verification.data.expectedPublicationRows} latest full publications verified.</p>}
      {!canonical && review.data?.summary.openingReservationRebases && <details>
        <summary className="cursor-pointer text-sm">Verified reservation counter translations: {review.data.summary.openingReservationRebases.length} positions</summary>
        <p className="text-sm">Physical stock, picked custody and outstanding demand are preserved. Only these reviewed legacy counters are reduced to verified physical holds at activation.</p>
        <EvidencePage rows={review.data.summary.openingReservationRebases} render={page => <table className="w-full text-sm"><thead><tr>
          <th>Warehouse / location / variant</th><th>Before reserved</th><th>Physical reserved kept</th>
        </tr></thead><tbody>{page.map(row => <tr key={row.inventoryLevelId}>
          <td>{row.warehouseId} / {row.warehouseLocationId} / {row.productVariantId}</td><td>{row.reservedQty}</td><td>{row.physicalReservedQty}</td>
        </tr>)}</tbody></table>} />
      </details>}
      {evidence.data.blockers.length > 0 && <div className="space-y-2">
        <p className="font-medium text-sm">{evidence.data.blockers.length} finding(s) prevent this step.</p>
        <details open><summary className="cursor-pointer text-sm">Review findings</summary>
          <EvidencePage rows={evidence.data.blockers} render={page => <ul className="space-y-2 py-2 text-sm">{page.map((finding, index) =>
            <li className="rounded border p-2" key={`${finding.code}:${finding.subject}:${index}`}>
              <p>{finding.message}</p><p className="text-xs text-muted-foreground">{finding.subject} · {finding.code}</p>
            </li>)}</ul>} />
        </details>
      </div>}
      {!canonical && review.data && <details><summary className="cursor-pointer text-sm">Reviewed channel quantities</summary>
        <EvidencePage rows={review.data.publicationRows} render={page => <div className="overflow-auto"><table className="w-full text-sm"><thead><tr><th>Target ID</th><th>Variant ID</th><th>Units</th></tr></thead>
          <tbody>{page.map(row => <tr key={`${row.publicationTargetId}:${row.productVariantId}`}>
            <td className="text-center">{row.publicationTargetId}</td><td className="text-center">{row.productVariantId}</td><td className="text-center">{row.desiredQuantity}</td>
          </tr>)}</tbody></table></div>} />
      </details>}
    </>}
    {verification.data?.completedAt || finish.data ? <p role="status" className="text-sm font-medium">Cutover completed. Configuration is unlocked; durable catch-up continues from current canonical plans.</p>
      : <>
        <Label htmlFor={`cutover-reason-${props.activationRunId}`}>Reason for this step</Label>
        <Input id={`cutover-reason-${props.activationRunId}`} value={reason} maxLength={1000}
          disabled={pending || retainedAttempt} onChange={event => setReason(event.target.value)} placeholder="Record why this reviewed result is being applied" />
        {canonical ? <Button disabled={!ready} onClick={() => finish.mutate()}>{finish.isPending ? "Finishing…" : "Finish and unlock configuration"}</Button>
          : <AlertDialog><AlertDialogTrigger asChild><Button disabled={!ready}>Switch to canonical authority</Button></AlertDialogTrigger>
            <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Apply the reviewed inventory cutover?</AlertDialogTitle>
              <AlertDialogDescription>This switches ATP and reservation authority for the full catalog, adopts existing inventory ownership, and queues full channel publication. It does not erase stock or permit a return to legacy authority. The server will reject changed evidence.</AlertDialogDescription>
            </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => commit.mutate()}>Apply reviewed cutover</AlertDialogAction>
            </AlertDialogFooter></AlertDialogContent>
          </AlertDialog>}
      </>}
  </section>;
}

const EVIDENCE_PAGE_SIZE = 20;
/** Bound mounted rows, not the underlying evidence: the server still reviews the
 * complete catalog and the operator can inspect every finding and quantity. */
function EvidencePage<T>({ rows, render }: { rows: T[]; render(page: T[]): React.ReactNode }) {
  const [requestedPage, setRequestedPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(rows.length / EVIDENCE_PAGE_SIZE) - 1);
  const page = Math.min(requestedPage, lastPage);
  return <div>
    {render(rows.slice(page * EVIDENCE_PAGE_SIZE, (page + 1) * EVIDENCE_PAGE_SIZE))}
    {rows.length > EVIDENCE_PAGE_SIZE && <div className="flex items-center gap-3 py-2 text-xs">
      <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setRequestedPage(page - 1)}>Previous</Button>
      <span>Page {page + 1} of {lastPage + 1} · {rows.length} total</span>
      <Button size="sm" variant="outline" disabled={page === lastPage} onClick={() => setRequestedPage(page + 1)}>Next</Button>
    </div>}
  </div>;
}
