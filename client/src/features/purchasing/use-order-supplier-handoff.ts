import { useEffect, useMemo, useRef, useState } from "react";
import { createOrderSupplierHandoffStore, type OrderSupplierHandoff } from "@/lib/order-supplier-handoff";

/** Browser-session draft recovery, scoped to the signed-in operator. It never submits an order. */
export function useOrderSupplierHandoff(userId: string | null) {
  const store = useMemo(() => userId ? createOrderSupplierHandoffStore(() => window.sessionStorage, userId) : null, [userId]);
  const active = useRef(store);
  active.current = store;
  const mounted = useRef(false);
  const [snapshot, setSnapshot] = useState<{ store: typeof store; record: OrderSupplierHandoff | null; error: string | null } | null>(null);
  function refresh() {
    if (!mounted.current || active.current !== store) return;
    try { setSnapshot({ store, record: store?.read() ?? null, error: null }); }
    catch (error) { setSnapshot({ store, record: null, error: error instanceof Error ? error.message : "Saved order recovery is unavailable." }); }
  }
  useEffect(() => {
    mounted.current = true;
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    return () => { mounted.current = false; window.removeEventListener("focus", refresh); window.removeEventListener("storage", refresh); };
  }, [store]);
  const ready = snapshot !== null && snapshot.store === store;
  return { store, ready, record: ready ? snapshot.record : null, error: ready ? snapshot.error : null,
    refresh, isCurrent: () => mounted.current && active.current === store && store !== null };
}
