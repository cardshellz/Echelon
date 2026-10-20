import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { createReceivingCustodyStore, executeReceivingCustodyAttempt, type ReceivingCustodyAttempt } from "@/lib/receiving-quarantine-client";

/** Saved command verification must remain reachable when the parent receipt read fails. */
export function ReceivingQuarantineRecoveryNotice({ receiptId }: { receiptId: number }) {
  const { user } = useAuth();
  const store = useMemo(() => user?.id ? createReceivingCustodyStore(receiptId, user.id) : null, [receiptId, user?.id]);
  const current = useRef(store); current.current = store;
  const mounted = useRef(true);
  const [saved, setSaved] = useState<ReceivingCustodyAttempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    mounted.current = true; setPending(false); setConfirmed(false); setError(null); setSaved(null);
    try { setSaved(store?.read() ?? null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Quarantine recovery cannot be read."); }
    return () => { mounted.current = false; };
  }, [store]);
  async function retry() {
    if (!saved || !store || pending || current.current !== store) return;
    setPending(true); setError(null);
    try {
      await executeReceivingCustodyAttempt(store, saved);
      if (mounted.current && current.current === store) { setSaved(null); setConfirmed(true); }
    } catch (cause) {
      if (mounted.current && current.current === store) {
        setError(cause instanceof Error ? cause.message : "The quarantine command outcome remains unknown.");
        try { setSaved(store.read()); }
        catch (readError) { setError(readError instanceof Error ? readError.message : "Quarantine recovery storage became unavailable; keep the saved request unchanged."); }
      }
    } finally { if (mounted.current && current.current === store) setPending(false); }
  }
  if (!saved && !error && !confirmed) return null;
  return <section role="alert" aria-label="Quarantine command recovery" className="space-y-2 rounded border border-amber-500/50 p-3 text-sm break-words">
    {saved && <><p>Quarantine command on receipt #{receiptId} needs confirmation. Retry uses its exact saved request.</p>
      <Button type="button" variant="outline" disabled={pending || !store} onClick={() => void retry()}>Retry saved quarantine command</Button></>}
    {confirmed && <p>The saved quarantine command is confirmed. Receipt details can be reloaded when access is restored.</p>}
    {error && <p>{error}</p>}
  </section>;
}
