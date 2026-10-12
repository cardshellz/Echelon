import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { poVarianceApprovalRequestSchema, poVarianceContextSchema, poVarianceResultSchema, type PoVarianceContext } from "@shared/procurement/po-variance-approval";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { financialCommandFetchJson, FinancialCommandRequestError, shouldRetryFinancialCommand, financialCommandRetryDelay } from "@/lib/financial-command";
import { exactMoneyAsInput } from "@/lib/exact-money-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
const intentSchema = z.object({ key: z.string().uuid(), body: poVarianceApprovalRequestSchema, context: poVarianceContextSchema }).strict();
type Intent = z.infer<typeof intentSchema>;
function VarianceEditor({ context, storageKey, onSaved, setBusy, onClose }: { context: PoVarianceContext; storageKey: string; onSaved: () => void; setBusy: (value: boolean) => void; onClose: () => void }) {
  const initial = useRef<{ intent: Intent | null; error: string | null } | null>(null);
  if (!initial.current) {
    try {
      const stored = sessionStorage.getItem(storageKey), intent = stored ? intentSchema.parse(JSON.parse(stored)) : null;
      if (intent && (intent.context.exceptionId !== context.exceptionId || intent.context.sourceVersion !== intent.body.sourceVersion)) throw new Error("Invalid receipt");
      initial.current = { intent, error: null };
    } catch { initial.current = { intent: null, error: "A saved approval could not be read. Resolve its outcome with an Administrator before submitting again." }; }
  }
  const [pending, setPending] = useState(initial.current.intent);
  const active = useRef(initial.current.intent);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [localError, setLocalError] = useState<string | null>(initial.current.error);
  const [saved, setSaved] = useState(false);
  const review = pending?.context ?? context;
  const mutation = useMutation<z.infer<typeof poVarianceResultSchema>, Error, Intent>({
    mutationFn: async (intent: Intent) => {
      const result = poVarianceResultSchema.safeParse(await financialCommandFetchJson(`/api/po-exceptions/${context.exceptionId}/variance-approval`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": intent.key }, body: JSON.stringify(intent.body) }));
      if (!result.success || result.data.exceptionId !== context.exceptionId || result.data.context.sourceVersion !== intent.body.sourceVersion) {
        throw new FinancialCommandRequestError("Approval may have completed. Retry the saved confirmation to verify.", { status: 200, retryable: true, ambiguous: true });
      }
      return result.data;
    }, retry: shouldRetryFinancialCommand, retryDelay: financialCommandRetryDelay,
    onMutate: () => setBusy(true),
    onSuccess: () => { setSaved(true); setPending(null); active.current = null; setBusy(false);
      try { sessionStorage.removeItem(storageKey); } catch { setLocalError("Approval saved. Reopening will safely verify its retained browser receipt."); } onSaved(); },
    onError: error => {
      const ambiguous = error instanceof FinancialCommandRequestError && (error.ambiguous || error.retryable || (error.status ?? 0) >= 500 || [401, 403].includes(error.status ?? 0));
      if (!ambiguous) { try { sessionStorage.removeItem(storageKey); active.current = null; setPending(null); } catch { setLocalError("The rejected receipt could not be cleared. Reload before submitting again."); } }
      setBusy(false);
    },
  });
  const blocked = !context.canApprove ? "An Administrator with purchasing approval permission must accept this variance." : context.blockedReason;
  const locked = mutation.isPending || !!pending || saved || !!localError || !!mutation.error;
  function approve() {
    if (locked || blocked || !confirmed || active.current) return;
    try {
      const body = poVarianceApprovalRequestSchema.parse({ sourceVersion: context.sourceVersion, reason, approvalConfirmed: true });
      const intent = { key: crypto.randomUUID(), body, context };
      sessionStorage.setItem(storageKey, JSON.stringify(intent)); active.current = intent; setPending(intent); mutation.mutate(intent);
    } catch { setLocalError("Include a reason of at least 10 characters. Session storage must be available for safe retries."); }
  }
  return <div className="flex min-h-0 flex-col">
    <div className="min-h-0 space-y-3 overflow-y-auto">
      <p className="text-sm font-medium">Invoice {review.invoiceNumber}</p>
      <div className="max-w-full overflow-x-auto"><table className="w-full min-w-[580px] text-xs" aria-label="Current invoice variance">
        <thead><tr className="border-b"><th className="p-2 text-left">Line</th><th>Invoice pieces</th><th>PO / received pieces</th><th>Invoice / PO unit price</th><th>Invoice amount</th></tr></thead>
        <tbody>{review.issues.map(line => <tr className="border-b" key={line.lineId}><th className="p-2 text-left font-normal">{line.lineNumber}. {line.name}</th>
          <td className="p-2 text-right">{line.invoiceQuantity.toLocaleString("en-US")}</td><td className="p-2 text-right">{line.orderedQuantity.toLocaleString("en-US")} / {line.receivedQuantity.toLocaleString("en-US")}</td>
          <td className="p-2 text-right">{exactMoneyAsInput(line.invoiceUnitCostMills, 4)} / {exactMoneyAsInput(line.poUnitCostMills, 4)}</td><td className="p-2 text-right">{exactMoneyAsInput(line.invoiceLineAmountCents, 2)} {review.currency}</td></tr>)}</tbody>
      </table></div>
      <p className="text-sm">Accepting allows this variance when closing the PO. It leaves invoice amounts and payments unchanged. Correct the invoice first if its recorded values are wrong.</p>
      {!saved && !pending && <><Label htmlFor={`variance-reason-${context.exceptionId}`}>Why is this variance acceptable?</Label>
        <Textarea id={`variance-reason-${context.exceptionId}`} rows={2} maxLength={2000} disabled={locked || !!blocked} value={reason} onChange={event => { setReason(event.target.value); setConfirmed(false); }} />
        <div className="flex items-start gap-2"><Checkbox id={`variance-confirm-${context.exceptionId}`} checked={confirmed} disabled={locked || !!blocked} onCheckedChange={checked => setConfirmed(checked === true)} />
          <Label htmlFor={`variance-confirm-${context.exceptionId}`}>I reviewed these values and approve accepting this variance.</Label></div></>}
      {(blocked || localError || mutation.error) && <p role="alert" className="text-sm text-destructive">{blocked ?? localError ?? mutation.error?.message}</p>}
      {saved && <p role="status" className="font-medium text-green-800">Current variance approved and recorded.</p>}
    </div>
    <div className="mt-4 flex shrink-0 gap-2 border-t pt-3"><Button variant="outline" disabled={mutation.isPending} onClick={onClose}>Close</Button>
      {pending ? <Button disabled={mutation.isPending} onClick={() => mutation.mutate(pending)}>Retry saved confirmation</Button>
        : !saved && <Button disabled={locked || !!blocked || !confirmed || reason.trim().length < 10} onClick={approve}>Approve variance</Button>}
    </div>
  </div>;
}
/** A resolved exception must remain reachable when the browser lost its receipt. */
export function hasPendingPoVarianceApproval(purchaseOrderId: number | null, userId: string | undefined): boolean {
  if (!purchaseOrderId || !userId) return false;
  const prefix = `po-variance-approval:${userId}:`;
  try {
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const intent = intentSchema.safeParse(JSON.parse(sessionStorage.getItem(key)!));
      if (!intent.success || intent.data.context.purchaseOrderId === purchaseOrderId) return true;
    }
    return false;
  } catch { return true; }
}
export function PoVarianceApproval({ exceptionId, disabled, onSaved, resolved = false }: { exceptionId: number; disabled: boolean; onSaved: () => void; resolved?: boolean }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [epoch, setEpoch] = useState(0);
  const storageKey = `po-variance-approval:${user?.id}:${exceptionId}`;
  const context = useQuery({ queryKey: [`/api/po-exceptions/${exceptionId}/variance-approval`, epoch], enabled: open,
    queryFn: async () => {
      try {
        const result = poVarianceContextSchema.parse(await financialCommandFetchJson(`/api/po-exceptions/${exceptionId}/variance-approval`, { credentials: "include" }));
        if (result.exceptionId !== exceptionId) throw new Error("The review does not match this exception. Reload the PO.");
        return result;
      } catch (error) {
        // Current evidence may have changed after the command committed. A saved
        // review only exposes the exact retry; the server ledger owns its result.
        const stored = sessionStorage.getItem(storageKey);
        if (!stored) throw error;
        const intent = intentSchema.parse(JSON.parse(stored));
        if (intent.context.exceptionId !== exceptionId || intent.context.sourceVersion !== intent.body.sourceVersion) throw error;
        return intent.context;
      }
    } });
  function changeOpen(value: boolean) { if (busy) return; setOpen(value); if (!value) setEpoch(value => value + 1); }
  let hasReceipt: boolean;
  try { hasReceipt = sessionStorage.getItem(storageKey) !== null; } catch { hasReceipt = true; }
  if (resolved && !hasReceipt && !open) return null;
  return <><Button size="sm" disabled={disabled} onClick={() => setOpen(true)}>{resolved ? "Verify saved variance approval" : "Accept current variance"}</Button>
    <Dialog open={open} onOpenChange={changeOpen}><DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-3xl" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>Review and approve invoice variance</DialogTitle><DialogDescription>Administrator approval applies to these current invoice and PO values.</DialogDescription></DialogHeader>
      {context.isLoading && <p>Loading current values…</p>}{context.error && <p role="alert">{context.error.message}</p>}
      {context.data && <VarianceEditor key={epoch} context={context.data} storageKey={storageKey} setBusy={setBusy} onSaved={() => { toast({ title: "Invoice variance approved", description: "The current values and approval were recorded." }); onSaved(); }} onClose={() => changeOpen(false)} />}
      {!context.data && <Button variant="outline" onClick={() => changeOpen(false)}>Close</Button>}
    </DialogContent></Dialog></>;
}
