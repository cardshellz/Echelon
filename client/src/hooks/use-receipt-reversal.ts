import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { createReceiptReversalClient, createReceiptReversalRecoveryStore, type ReceiptReversalCommand, type ReceiptReversalRecovery } from "@/lib/receipt-reversal-command";

export function useReceiptReversal() {
  const { user, hasPermission } = useAuth();
  const allowed = hasPermission("purchasing", "approve");
  const context = useMemo(() => {
    if (!user?.id) return null;
    const store = createReceiptReversalRecoveryStore(() => window.sessionStorage, user.id);
    return { store, client: createReceiptReversalClient(() => "receipt-reversal-" + crypto.randomUUID(), store), allowed };
  }, [user?.id, allowed]);
  const active = useRef(context);
  active.current = context;
  const mounted = useRef(true);
  const [snapshot, setSnapshot] = useState<{ context: typeof context; recovery: ReceiptReversalRecovery | null; error: string | null } | null>(null);
  function refresh() {
    if (!mounted.current || active.current !== context) return;
    try { setSnapshot({ context, recovery: context?.store.read() ?? null, error: context ? null : "Sign in before reversing a receipt." }); }
    catch (error) { setSnapshot({ context, recovery: null, error: error instanceof Error ? error.message : "Reversal recovery cannot be read." }); }
  }
  useEffect(() => {
    mounted.current = true;
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    return () => { mounted.current = false; window.removeEventListener("focus", refresh); window.removeEventListener("storage", refresh); };
  }, [context]);
  const ready = snapshot !== null && snapshot.context === context;
  return {
    ready, allowed, recovery: ready ? snapshot.recovery : null, error: ready ? snapshot.error : null,
    captureVisit: () => ({ isCurrent: () => mounted.current && active.current === context }),
    refresh,
    async execute(command: ReceiptReversalCommand, pinned?: ReceiptReversalRecovery) {
      if (!context || !mounted.current || active.current !== context) throw new Error("This reversal view changed. Review the current operator and saved request before sending.");
      if (!context.allowed) throw new Error("Purchasing approval permission is required to reverse a receipt.");
      try { return await context.client.execute(command, pinned); }
      finally { refresh(); }
    },
  };
}
