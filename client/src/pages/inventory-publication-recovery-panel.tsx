import React, { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { pendingQuantityPublicationRecoverySchema, quantityPublicationRecoverySchema,
  quantityPublicationRecoveryResultSchema, type QuantityPublicationRecovery } from "@shared/types/inventory-publication-recovery";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isDefinitiveCutoverRejection, postInventoryPlanningCommand } from "./inventory-cutover-http";

type Props = { actorId: string | null; canActivate: boolean; activationRunId: string | null; onStateChanged(): void };

/** Advanced recovery is an explicit human attestation, never automatic clearance
 * based on elapsed time or a fresh quantity readback alone. */
export function InventoryPublicationRecoveryPanel(props: Props) {
  const [attemptId, setAttemptId] = useState("");
  const [evidenceKind, setEvidenceKind] = useState("");
  const [terminalOutcome, setTerminalOutcome] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [evidenceHash, setEvidenceHash] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const retained = useRef<QuantityPublicationRecovery | null>(null);
  const enabled = props.canActivate && props.actorId !== null;
  const pending = useQuery({ queryKey: ["inventory-publication-recovery", props.actorId, props.activationRunId],
    enabled: false, retry: false, gcTime: 0,
    queryFn: ({ signal }) => postInventoryPlanningCommand("publication-recovery", "pending",
      props.activationRunId === null ? {} : { activationRunId: props.activationRunId }, pendingQuantityPublicationRecoverySchema, signal),
  });
  const request = quantityPublicationRecoverySchema.safeParse({ attemptId, evidenceKind, terminalOutcome,
    evidenceReference, evidenceHash, reason, idempotencyKey: "validation-only" });
  const selected = pending.data?.unresolvedAttempts.find(row => row.attemptId === attemptId);
  const attest = useMutation({ mutationFn: async () => {
    if (!enabled) throw new Error("Inventory activation permission is required.");
    if (!retained.current) {
      if (!confirmed || !selected || !request.success || pending.isFetching || pending.isError) {
        throw new Error("Select current owner history and provide retained terminal evidence before attesting.");
      }
      retained.current = { ...request.data, idempotencyKey: `publication-recovery:${crypto.randomUUID()}` };
    }
    return postInventoryPlanningCommand("publication-recovery", "attest", retained.current, quantityPublicationRecoveryResultSchema);
  }, onSuccess: () => {
    retained.current = null; setAttemptId(""); setConfirmed(false);
    void pending.refetch(); props.onStateChanged();
  }, onError: error => {
    if (isDefinitiveCutoverRejection(error)) retained.current = null;
    props.onStateChanged();
  } });
  if (!enabled) return null;
  const fieldsDisabled = attest.isPending || retained.current !== null;
  const canSubmit = !attest.isPending && (retained.current !== null
    || (request.success && confirmed && selected !== undefined && !pending.isFetching && !pending.isError));
  const prefix = `publication-recovery-${props.activationRunId ?? "latest"}`;
  return <details className="rounded-md border p-3 space-y-3">
    <summary className="cursor-pointer text-sm font-medium">Stalled publication recovery</summary>
    <p className="text-sm text-muted-foreground">A timed-out request may still reach the provider. Do not clear it just because stock currently looks correct. Only record an attestation after retaining evidence that the request completed or cannot still be sent.</p>
    <Button variant="outline" disabled={pending.isFetching || attest.isPending} onClick={() => { void pending.refetch(); }}>
      {pending.isFetching ? "Checking recorded history…" : "Check stalled publications"}
    </Button>
    {(pending.error || attest.error) && <p role="alert" className="text-sm text-destructive">{(pending.error ?? attest.error)?.message}</p>}
    {pending.data && <p className="text-sm">{pending.data.unresolvedAttempts.length} unresolved attempts · {pending.data.pendingCatchupCount} catch-up scopes pending. This is recorded owner history, not a provider verification.</p>}
    {attest.data && <p role="status" className="text-sm">Operator attestation recorded for attempt {attest.data.attemptId}. No provider write or provider verification was performed. Capture fresh cutover evidence before proceeding.</p>}
    {((pending.data?.unresolvedAttempts.length ?? 0) > 0 || retained.current) && <div className="space-y-2">
      <Label htmlFor={`${prefix}-attempt`}>Exact unresolved attempt</Label>
      <select id={`${prefix}-attempt`} className="h-10 w-full rounded-md border bg-background px-3 text-sm" disabled={fieldsDisabled}
        value={attemptId} onChange={event => { setAttemptId(event.target.value); setConfirmed(false); }}>
        <option value="">Select an attempt</option>
        {pending.data?.unresolvedAttempts.map(row => <option key={row.attemptId} value={row.attemptId}>
          #{row.attemptId} · {row.providerKey} connection {row.connectionId} · {row.externalInventoryItemId} · {row.state}
        </option>)}
      </select>
      <Label htmlFor={`${prefix}-kind`}>Retained evidence type</Label>
      <select id={`${prefix}-kind`} className="h-10 w-full rounded-md border bg-background px-3 text-sm" disabled={fieldsDisabled}
        value={evidenceKind} onChange={event => setEvidenceKind(event.target.value)}>
        <option value="">Choose evidence type</option>
        <option value="provider_terminal_request_record">Provider terminal request record</option>
        <option value="owner_process_and_request_termination_record">Owner process and request termination record</option>
      </select>
      <Label htmlFor={`${prefix}-outcome`}>Proven terminal outcome</Label>
      <select id={`${prefix}-outcome`} className="h-10 w-full rounded-md border bg-background px-3 text-sm" disabled={fieldsDisabled}
        value={terminalOutcome} onChange={event => setTerminalOutcome(event.target.value)}>
        <option value="">Choose terminal outcome</option><option value="completed">Request completed</option>
        <option value="not_sent">Request was not sent and cannot still be sent</option>
      </select>
      <Label htmlFor={`${prefix}-reference`}>Evidence reference</Label>
      <Input id={`${prefix}-reference`} value={evidenceReference} maxLength={2000} disabled={fieldsDisabled} onChange={event => setEvidenceReference(event.target.value)} />
      <Label htmlFor={`${prefix}-hash`}>Retained evidence SHA-256</Label>
      <Input id={`${prefix}-hash`} value={evidenceHash} maxLength={64} disabled={fieldsDisabled} onChange={event => setEvidenceHash(event.target.value)} />
      <Label htmlFor={`${prefix}-reason`}>Recovery reason (at least 10 characters)</Label>
      <Input id={`${prefix}-reason`} value={reason} maxLength={2000} disabled={fieldsDisabled} onChange={event => setReason(event.target.value)} />
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={fieldsDisabled}
        onChange={event => setConfirmed(event.target.checked)} />I reviewed the retained evidence and attest that this request can no longer change provider quantities.</label>
      {retained.current && <p className="text-sm">Outcome uncertain. Retry retains the exact original evidence and command key.</p>}
      <Button disabled={!canSubmit} onClick={() => attest.mutate()}>{attest.isPending ? "Recording attestation…" : retained.current ? "Retry same attestation" : "Record operator attestation"}</Button>
    </div>}
  </details>;
}
