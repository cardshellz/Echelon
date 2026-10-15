import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  invoiceReplacementCapabilitySchema, invoiceReplacementHistorySchema, invoiceReplacementInputSchema,
  invoiceReplacementResultSchema, type ReplacementInvoiceResult,
} from "@shared/procurement/invoice-replacement";
import { useAuth } from "@/lib/auth";
import { createInvoiceReplacementRecovery, type InvoiceReplacementIntent } from "@/lib/invoice-replacement-recovery";
import { financialCommandFetchJson, financialCommandRetryDelay, FinancialCommandRequestError, shouldRetryFinancialCommand } from "@/lib/financial-command";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  invoiceId: number; invoiceStatus: string; shipmentId: number | null;
  capability: unknown; history: unknown; childHref: (href: string) => string;
  onReload: () => Promise<unknown>;
};

export function InvoiceShipmentReplacement(props: Props) {
  const { user } = useAuth();
  // Account/document changes discard only component state; saved intents remain
  // scoped to their original account and document until resolved.
  return user ? <ReplacementReview key={`${user.id}:${props.invoiceId}`} {...props} userId={user.id} /> : null;
}

function ReplacementReview({ invoiceId, invoiceStatus, shipmentId, capability, history, childHref, onReload, userId }: Props & { userId: string }) {
  const { hasPermission } = useAuth();
  const canReplace = hasPermission("purchasing", "create") && hasPermission("purchasing", "edit");
  const queryClient = useQueryClient();
  const recovery = useMemo(() => createInvoiceReplacementRecovery(() => window.sessionStorage, userId, invoiceId), [userId, invoiceId]);
  const [initial] = useState(() => {
    try { return { intent: recovery.read(), error: null as string | null }; }
    catch (error) { return { intent: null, error: error instanceof Error ? error.message : "Replacement recovery is unavailable." }; }
  });
  const [intent, setIntent] = useState<InvoiceReplacementIntent | null>(initial.intent);
  const [reason, setReason] = useState(initial.intent?.body.reason ?? "");
  const [localError, setLocalError] = useState<string | null>(initial.error);
  const [storageBlocked, setStorageBlocked] = useState(initial.error !== null);
  const [blockedUntilReload, setBlockedUntilReload] = useState(false);
  const [result, setResult] = useState<ReplacementInvoiceResult | null>(null);
  const availability = invoiceReplacementCapabilitySchema.safeParse(capability);
  const chain = invoiceReplacementHistorySchema.safeParse(history);
  const mutation = useMutation<ReplacementInvoiceResult, Error, InvoiceReplacementIntent>({
    mutationFn: async (saved) => {
      const response = await financialCommandFetchJson<unknown>(`/api/vendor-invoices/${invoiceId}/replacement`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": saved.key }, body: JSON.stringify(saved.body),
      });
      const parsed = invoiceReplacementResultSchema.safeParse(response);
      if (!parsed.success || parsed.data.replacesInvoiceId !== invoiceId) throw new FinancialCommandRequestError(
        "The replacement may have been created, but its response could not be verified. Retry the saved request.",
        { status: 200, code: "AP_INVOICE_REPLACEMENT_RESPONSE_INVALID", retryable: true, ambiguous: true },
      );
      recovery.complete(saved.key);
      return parsed.data;
    },
    retry: shouldRetryFinancialCommand, retryDelay: financialCommandRetryDelay,
    onSuccess: (value) => { setIntent(null); setResult(value); setLocalError(null); },
    onError: (error, saved) => {
      if (error instanceof FinancialCommandRequestError && !error.ambiguous) {
        try { recovery.complete(saved.key); setIntent(null); setBlockedUntilReload(true); }
        catch (failure) { setLocalError(failure instanceof Error ? failure.message : "The saved request could not be cleared."); }
      }
    },
    // Reread even after a lost response: a successor may already be committed.
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/api/vendor-invoices/${invoiceId}`] }),
        queryClient.invalidateQueries({ predicate: (query) => typeof query.queryKey[0] === "string" && /^\/api\/vendor-invoices(?:\?|$)/.test(query.queryKey[0]) }),
        queryClient.invalidateQueries({ queryKey: ["/api/ap/summary"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/ap/command-events?limit=8"] }),
        queryClient.invalidateQueries({ predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/purchase-orders/") }),
        ...(shipmentId === null ? [] : [
          queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}`] }),
          queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}/invoices`] }),
          queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}/costs`] }),
        ]),
      ]);
    },
  });
  const historyRows = chain.success ? chain.data.filter((entry) => entry.id !== invoiceId) : [];
  const visible = invoiceStatus === "voided" && shipmentId !== null || historyRows.length > 0 || intent !== null;
  if (!visible) return null;
  async function reload() {
    try { await onReload(); setIntent(recovery.read()); setStorageBlocked(false); setBlockedUntilReload(false); mutation.reset(); setLocalError(null); }
    catch (error) { setLocalError(error instanceof Error ? error.message : "Invoice could not be reloaded."); }
  }
  function submit() {
    if (!canReplace || mutation.isPending || blockedUntilReload || storageBlocked) return;
    try {
      const saved = intent ?? recovery.acquire(invoiceReplacementInputSchema.parse({
        expectedVersion: availability.success ? availability.data.expectedVersion : "", reason,
      }), () => crypto.randomUUID());
      setIntent(saved); setLocalError(null); mutation.mutate(saved);
    } catch (error) { setLocalError(error instanceof Error ? error.message : "Review the replacement reason."); }
  }
  const successorId = result?.invoiceId ?? (availability.success ? availability.data.successorInvoiceId : null);
  const offerCreate = invoiceStatus === "voided" && availability.success && availability.data.allowed && successorId === null;
  return <section aria-label="Shipment invoice replacement" className="rounded-lg border border-amber-300 bg-amber-50/40 p-4 space-y-3 dark:bg-amber-950/10">
    <h2 className="text-sm font-semibold">Shipment invoice history and recovery</h2>
    {historyRows.length > 0 && <ul className="space-y-1 text-sm">{historyRows.map((entry) => <li key={entry.id}>
      <Link href={childHref(`/ap-invoices/${entry.id}`)} className="text-primary underline">{entry.replacesInvoiceId === invoiceId ? "Replacement" : "Related invoice"} {entry.invoiceNumber} · record #{entry.id}</Link> · {entry.status.replaceAll("_", " ")}
    </li>)}</ul>}
    {invoiceStatus === "voided" && <p className="text-sm">The original invoice remains voided. A replacement copies its shipment charge lines into a new received invoice with the same supplier invoice number. Review and correct that invoice, then approve it through the normal process. Creating it does not approve, pay, or apply inventory costs.</p>}
    {!availability.success && invoiceStatus === "voided" && <p role="alert" className="text-sm">Replacement eligibility could not be verified. Reload the invoice before proceeding.</p>}
    {invoiceStatus === "voided" && availability.success && !availability.data.allowed && successorId === null && <p className="text-sm">{availability.data.message}</p>}
    {successorId !== null && <p role="status" className="text-sm"><Link className="text-primary underline font-medium" href={childHref(`/ap-invoices/${successorId}`)}>Open replacement invoice #{successorId}</Link>{result && " — created as received; review and approval are still required."}</p>}
    {(offerCreate || intent) && <>
      {!canReplace && <p className="text-sm">Purchasing create and edit permissions are required to create or retry a replacement.</p>}
      <div><Label htmlFor={`replacement-reason-${invoiceId}`}>Reason for replacement</Label><Textarea id={`replacement-reason-${invoiceId}`} value={reason} maxLength={2000} disabled={!canReplace || intent !== null || mutation.isPending || blockedUntilReload} onChange={(event) => setReason(event.target.value)} /></div>
      {intent && <p role="status" className="text-sm">The original replacement request is saved. Its details remain locked until the result is confirmed. Retry checks the original request without creating a second invoice.</p>}
      {canReplace && <Button onClick={submit} disabled={mutation.isPending || blockedUntilReload || storageBlocked || (!intent && !reason.trim())}>{mutation.isPending ? "Creating replacement…" : intent ? "Retry saved replacement" : "Create replacement invoice"}</Button>}
    </>}
    {(localError || mutation.error) && <p role="alert" className="text-sm text-destructive">{localError ?? mutation.error?.message}</p>}
    {(!availability.success || blockedUntilReload || storageBlocked) && !intent && <Button variant="outline" onClick={() => void reload()}>Reload invoice for replacement review</Button>}
  </section>;
}
