import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { createReceivingEntryClient, createReceivingEntryRecoveryStore, type ReceivingEntryRecovery } from "@/lib/receiving-entry-command";
import type { ReceivingEntryCommand } from "@shared/procurement/receiving-entry-command";

export function useReceivingEntry() {
  const { user, hasPermission } = useAuth();
  const allowed = hasPermission("inventory", "adjust");
  const context = useMemo(() => {
    if (!user?.id) return null;
    const store = createReceivingEntryRecoveryStore(() => window.sessionStorage, user.id);
    return { store, client: createReceivingEntryClient(() => "receiving-entry-" + crypto.randomUUID(), store), allowed };
  }, [user?.id, allowed]);
  const active = useRef(context);
  active.current = context;
  const mounted = useRef(true);
  const [snapshot, setSnapshot] = useState<{ context: typeof context; recovery: ReceivingEntryRecovery | null; error: string | null } | null>(null);
  function refresh() {
    if (!mounted.current || active.current !== context) return;
    try { setSnapshot({ context, recovery: context?.store.read() ?? null, error: context ? null : "Sign in before recording receiving entries." }); }
    catch (error) { setSnapshot({ context, recovery: null, error: error instanceof Error ? error.message : "Receiving recovery cannot be read." }); }
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
    operatorId: context?.store.userId ?? null,
    ready, allowed, recovery: ready ? snapshot.recovery : null, error: ready ? snapshot.error : null,
    captureVisit: () => ({ isCurrent: () => mounted.current && active.current === context }),
    refresh,
    async execute(command: ReceivingEntryCommand, pinned?: ReceivingEntryRecovery) {
      if (!context || !mounted.current || active.current !== context) throw new Error("The receiving operator changed. Review the current saved request before sending.");
      if (!context.allowed) throw new Error("Inventory adjustment permission is required to record receiving entries.");
      try {
        const request = context.client.execute(command, pinned);
        refresh(); // Expose the saved intent before waiting for the network.
        return await request;
      } finally { refresh(); }
    },
  };
}
