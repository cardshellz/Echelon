import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { createShipmentCreateClient, createShipmentCreateRecoveryStore, type ShipmentCreateRecovery } from "@/lib/shipment-create-command";
import type { ShipmentCreateInput } from "@shared/procurement/shipment-create-command";

export function useShipmentCreation() {
  const { user } = useAuth();
  const context = useMemo(() => {
    if (!user?.id) return null;
    const store = createShipmentCreateRecoveryStore(() => window.sessionStorage, user.id);
    return { store, client: createShipmentCreateClient(() => "shipment-create-" + crypto.randomUUID(), store) };
  }, [user?.id]);
  const active = useRef(context);
  active.current = context;
  const mounted = useRef(true);
  const [snapshot, setSnapshot] = useState<{ context: typeof context; recovery: ShipmentCreateRecovery | null; error: string | null } | null>(null);
  function refresh() {
    if (!mounted.current || active.current !== context) return;
    try { setSnapshot({ context, recovery: context?.store.read() ?? null, error: context ? null : "Sign in before creating a shipment." }); }
    catch (error) { setSnapshot({ context, recovery: null, error: error instanceof Error ? error.message : "Shipment recovery cannot be read." }); }
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
    ready, recovery: ready ? snapshot.recovery : null, error: ready ? snapshot.error : null,
    captureVisit: () => ({ isCurrent: () => mounted.current && active.current === context }),
    refresh,
    async execute(body: ShipmentCreateInput, pinned?: ShipmentCreateRecovery) {
      if (!context || !mounted.current || active.current !== context) throw new Error("This shipment creation view changed. Review the current operator and saved request before sending.");
      try { return await context.client.execute(body, pinned); }
      finally { refresh(); }
    },
  };
}
