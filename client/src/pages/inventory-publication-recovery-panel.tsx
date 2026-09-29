import React, { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { pendingQuantityPublicationRecoverySchema, quantityPublicationProviderAnswerRecoveryResultSchema,
  quantityPublicationRecoverySchema, quantityPublicationRecoveryResultSchema,
  type QuantityPublicationRecovery } from "@shared/types/inventory-publication-recovery";
import { attestationPrefill, describeRecoveryEvidenceBatch, describeRecoveryEvidenceResult,
  recoveryEvidenceConfirmations, recoveryEvidenceLabel } from "@/lib/inventory-publication-recovery";
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
  const [answersConfirmed, setAnswersConfirmed] = useState(false);
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
  const prefill = selected ? attestationPrefill(selected) : null;
  /** Selecting an attempt fills the form from the evidence on file, or clears it: evidence belongs to one
   * attempt, and the server records the hash as given, so nothing typed for another attempt may carry over.
   * The operator still reads, confirms and records. */
  function selectAttempt(nextAttemptId: string): void {
    setAttemptId(nextAttemptId); setConfirmed(false);
    const row = pending.data?.unresolvedAttempts.find(candidate => candidate.attemptId === nextAttemptId);
    const filled = row ? attestationPrefill(row) : null;
    setEvidenceKind(filled?.evidenceKind ?? ""); setTerminalOutcome(filled?.terminalOutcome ?? "");
    setEvidenceReference(filled?.evidenceReference ?? ""); setEvidenceHash(filled?.evidenceHash ?? ""); setReason(filled?.reason ?? "");
  }
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
  /** One click records one attestation per listed attempt whose stored evidence the operator saw. The hashes
   * sent are the ones on screen, so the server confirms exactly what was reviewed and reports the rest. */
  const confirmations = pending.data ? recoveryEvidenceConfirmations(pending.data.unresolvedAttempts) : [];
  const batchSummary = pending.data ? describeRecoveryEvidenceBatch(pending.data.unresolvedAttempts) : null;
  const confirmAnswers = useMutation({ mutationFn: async () => {
    if (!enabled) throw new Error("Inventory activation permission is required.");
    if (!answersConfirmed || confirmations.length === 0 || pending.isFetching || pending.isError) {
      throw new Error("Check the stalled publications and confirm the listed evidence before recording it.");
    }
    return postInventoryPlanningCommand("publication-recovery", "attest-provider-answers",
      { ...(props.activationRunId === null ? {} : { activationRunId: props.activationRunId }), confirmations },
      quantityPublicationProviderAnswerRecoveryResultSchema);
  }, onSuccess: () => {
    // The selected attempt may be among the confirmed ones; drop it and its filled evidence.
    setAnswersConfirmed(false); selectAttempt("");
    void pending.refetch(); props.onStateChanged();
  }, onError: () => { props.onStateChanged(); } });
  if (!enabled) return null;
  const fieldsDisabled = attest.isPending || confirmAnswers.isPending || retained.current !== null;
  const canSubmit = !attest.isPending && !confirmAnswers.isPending && (retained.current !== null
    || (request.success && confirmed && selected !== undefined && !pending.isFetching && !pending.isError));
  const batchDisabled = confirmAnswers.isPending || attest.isPending || retained.current !== null;
  const canConfirmAnswers = answersConfirmed && confirmations.length > 0 && !batchDisabled && !pending.isFetching && !pending.isError;
  const prefix = `publication-recovery-${props.activationRunId ?? "latest"}`;
  return <details className="rounded-md border p-3 space-y-3">
    <summary className="cursor-pointer text-sm font-medium">Stalled publication recovery</summary>
    <p className="text-sm text-muted-foreground">A timed-out request may still reach the provider. Do not clear it just because stock currently looks correct. Only record an attestation after retaining evidence that the request completed or cannot still be sent.</p>
    <Button variant="outline" disabled={pending.isFetching || attest.isPending || confirmAnswers.isPending} onClick={() => { void pending.refetch(); }}>
      {pending.isFetching ? "Checking recorded history…" : "Check stalled publications"}
    </Button>
    {(pending.error || attest.error || confirmAnswers.error) && <p role="alert" className="text-sm text-destructive">{(pending.error ?? attest.error ?? confirmAnswers.error)?.message}</p>}
    {pending.data && <p className="text-sm">{pending.data.unresolvedAttempts.length} unresolved attempts · {pending.data.pendingCatchupCount} catch-up scopes pending. This is recorded owner history, not a provider verification.</p>}
    {batchSummary && retained.current === null && <div className="space-y-2 rounded-md border p-3" data-testid={`${prefix}-provider-answers`}>
      <p className="text-sm">{batchSummary}</p>
      <label className="flex gap-2 text-sm"><input id={`${prefix}-answers-confirm`} type="checkbox" checked={answersConfirmed} disabled={batchDisabled}
        onChange={event => setAnswersConfirmed(event.target.checked)} />I reviewed this evidence and attest that none of these requests can still change provider quantities.</label>
      <Button disabled={!canConfirmAnswers} onClick={() => confirmAnswers.mutate()}>
        {confirmAnswers.isPending ? "Recording attestations…" : `Confirm all ${confirmations.length} ${confirmations.length === 1 ? "entry" : "entries"}`}
      </Button>
    </div>}
    {confirmAnswers.data && <p role="status" className="text-sm">{describeRecoveryEvidenceResult(confirmAnswers.data)}</p>}
    {attest.data && <p role="status" className="text-sm">Operator attestation recorded for attempt {attest.data.attemptId}. No provider write or provider verification was performed. Capture fresh cutover evidence before proceeding.</p>}
    {((pending.data?.unresolvedAttempts.length ?? 0) > 0 || retained.current) && <div className="space-y-2">
      <Label htmlFor={`${prefix}-attempt`}>Exact unresolved attempt</Label>
      <select id={`${prefix}-attempt`} className="h-10 w-full rounded-md border bg-background px-3 text-sm" disabled={fieldsDisabled}
        value={attemptId} onChange={event => selectAttempt(event.target.value)}>
        <option value="">Select an attempt</option>
        {pending.data?.unresolvedAttempts.map(row => <option key={row.attemptId} value={row.attemptId}>
          #{row.attemptId} · {row.providerKey} connection {row.connectionId} · {row.externalInventoryItemId} · {row.state}{recoveryEvidenceLabel(row)}
        </option>)}
      </select>
      {prefill && <p className="text-sm" data-testid={`${prefix}-provider-answer`}>{prefill.summary}</p>}
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
      <label className="flex gap-2 text-sm"><input id={`${prefix}-attest-confirm`} type="checkbox" checked={confirmed} disabled={fieldsDisabled}
        onChange={event => setConfirmed(event.target.checked)} />I reviewed the retained evidence and attest that this request can no longer change provider quantities.</label>
      {retained.current && <p className="text-sm">Outcome uncertain. Retry retains the exact original evidence and command key.</p>}
      <Button disabled={!canSubmit} onClick={() => attest.mutate()}>{attest.isPending ? "Recording attestation…" : retained.current ? "Retry same attestation" : "Record operator attestation"}</Button>
    </div>}
  </details>;
}
