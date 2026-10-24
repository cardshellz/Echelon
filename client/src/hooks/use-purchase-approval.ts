import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { createPurchaseApprovalClient, createPurchaseApprovalRecoveryStore, type PurchaseApprovalIntent, type PurchaseApprovalRecovery } from "@/lib/purchase-approval-command";

export function usePurchaseApproval() {
  const { user, hasPermission } = useAuth();
  const allowed = hasPermission("purchasing", "approve");
  const context = useMemo(() => {
    if (!user?.id) return null;
    const store = createPurchaseApprovalRecoveryStore(() => window.sessionStorage, user.id);
    return { store, allowed, client: createPurchaseApprovalClient(() => "purchase-approval-" + crypto.randomUUID(), store) };
  }, [user?.id, allowed]);
  const active = useRef(context);
  active.current = context;
  const mounted = useRef(true);
  const [snapshot, setSnapshot] = useState<{ context: typeof context; recovery: PurchaseApprovalRecovery | null; error: string | null } | null>(null);
  function refresh() {
    if (!mounted.current || active.current !== context) return;
    try { setSnapshot({ context, recovery: context?.store.read() ?? null, error: context ? null : "Sign in before approving a purchase order." }); }
    catch (error) { setSnapshot({ context, recovery: null, error: error instanceof Error ? error.message : "Purchase approval recovery cannot be read." }); }
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
    captureVisit: () => ({ isCurrent: () => mounted.current && active.current === context }), refresh,
    async execute(body: PurchaseApprovalIntent, pinned?: PurchaseApprovalRecovery) {
      if (!context || !context.allowed || !mounted.current || active.current !== context) throw new Error("The approval operator or permission changed. Review the current operator and saved request before sending.");
      const pending = context.client.execute(body, pinned);
      refresh();
      try { return await pending; }
      finally { refresh(); }
    },
  };
}
