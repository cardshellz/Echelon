import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useAuth } from "@/lib/auth";
import { createPurchaseOrderEntryClient, createPurchaseOrderEntryRecoveryStore, type PurchaseOrderEntryRecovery } from "@/lib/purchase-order-entry-command";
import type { PurchaseOrderEntryCommand } from "@shared/procurement/purchase-order-entry-command";

export function usePurchaseOrderEntry() {
  const { user, hasPermission } = useAuth();
  const [location] = useLocation();
  const search = useSearch();
  const canCreate = hasPermission("purchasing", "create"), canEdit = hasPermission("purchasing", "edit");
  const context = useMemo(() => {
    if (!user?.id) return null;
    const store = createPurchaseOrderEntryRecoveryStore(() => window.sessionStorage, user.id);
    return { store, canCreate, canEdit };
  }, [user?.id, canCreate, canEdit]);
  const active = useRef(context);
  active.current = context;
  const mounted = useRef(true);
  const route = `${location}?${search}`;
  const visit = useRef({ route, generation: 0 });
  if (visit.current.route !== route) visit.current = { route, generation: visit.current.generation + 1 };
  const running = useRef(new Set<NonNullable<typeof context>>());
  const [pendingContext, setPendingContext] = useState<typeof context>(null);
  const pending = context !== null && pendingContext === context;
  const [commandError, setCommandError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<{ context: typeof context; recovery: PurchaseOrderEntryRecovery | null; error: string | null } | null>(null);
  function refresh() {
    if (!mounted.current || active.current !== context) return;
    try { setSnapshot({ context, recovery: context?.store.read() ?? null, error: context ? null : "Sign in before saving purchase orders." }); }
    catch (error) { setSnapshot({ context, recovery: null, error: error instanceof Error ? error.message : "Purchase recovery cannot be read." }); }
  }
  useEffect(() => {
    mounted.current = true; setCommandError(null); refresh();
    window.addEventListener("focus", refresh); window.addEventListener("storage", refresh);
    return () => { mounted.current = false; window.removeEventListener("focus", refresh); window.removeEventListener("storage", refresh); };
  }, [context]);
  const ready = snapshot !== null && snapshot.context === context;
  const allowed = (action: PurchaseOrderEntryCommand["action"]) => action === "create" || action === "duplicate" || action === "prepare" ? canCreate : canEdit;
  return {
    operatorId: user?.id ?? null, ready, allowed, pending, commandError,
    recovery: ready ? snapshot.recovery : null, error: ready ? snapshot.error : null, refresh,
    captureVisit() {
      const generation = visit.current.generation;
      return { isCurrent: () => mounted.current && active.current === context && visit.current.generation === generation };
    },
    async execute(body: PurchaseOrderEntryCommand, pinned?: PurchaseOrderEntryRecovery) {
      if (!context || !mounted.current || active.current !== context || !allowed(body.action)) throw new Error("The purchasing operator or permission changed. Review the current operator and saved request before sending.");
      if (running.current.has(context)) throw new Error("The saved purchase request is already being confirmed.");
      running.current.add(context); setPendingContext(context); setCommandError(null);
      try {
        const client = createPurchaseOrderEntryClient(() => "purchase-order-" + crypto.randomUUID(), context.store,
          () => mounted.current && active.current === context && allowed(body.action));
        const request = client.execute(body, pinned);
        refresh();
        return await request;
      } catch (error) {
        if (mounted.current && active.current === context) setCommandError(error instanceof Error ? error.message : "The purchase request could not be confirmed.");
        throw error;
      } finally {
        running.current.delete(context);
        if (mounted.current) setPendingContext(current => current === context ? null : current);
        refresh();
      }
    },
  };
}
