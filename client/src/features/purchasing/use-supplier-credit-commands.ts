import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { createSupplierCreditClient, createSupplierCreditRecoveryStore, type SupplierCreditIntent, type SupplierCreditRecovery } from "@/lib/supplier-credit-command";
import { invalidateApPaymentQueries } from "./ap-work-list-query";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import type { SupplierCreditCommandResult } from "@shared/procurement/supplier-credit";

const RECOVERY_CHANGED = "echelon:supplier-credit-recovery-changed";
export function useSupplierCreditCommands() {
  const { user, hasPermission } = useAuth();
  const userId = user?.id ?? null;
  const activeActor = useRef(userId); activeActor.current = userId;
  const canCreate = hasPermission("purchasing", "edit");
  const canApprove = hasPermission("purchasing", "approve");
  const store = useMemo(() => userId ? createSupplierCreditRecoveryStore(() => window.sessionStorage, userId) : null, [userId]);
  const queryClient = useQueryClient();
  const [recovery, setRecovery] = useState<SupplierCreditRecovery | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<SupplierCreditCommandResult | null>(null);
  const read = useCallback(() => {
    if (activeActor.current !== userId) return;
    try { setRecovery(store?.read() ?? null); setStorageError(null); }
    catch (error) { setRecovery(null); setStorageError(error instanceof Error ? error.message : "Credit recovery is unavailable."); }
  }, [store, userId]);
  useEffect(() => {
    setConfirmed(null); read();
    window.addEventListener(RECOVERY_CHANGED, read); window.addEventListener("storage", read);
    return () => { window.removeEventListener(RECOVERY_CHANGED, read); window.removeEventListener("storage", read); };
  }, [read]);
  const permitted = (intent: SupplierCreditIntent) => intent.command === "create" ? canCreate : canApprove;
  const mutation = useMutation({
    retry: false, networkMode: "always",
    mutationFn: async ({ intent, pinned }: { intent: SupplierCreditIntent; pinned?: SupplierCreditRecovery }) => {
      if (!store || !userId || activeActor.current !== userId || !permitted(intent)) throw new Error("Current purchasing permission is required. The saved credit request is retained.");
      return createSupplierCreditClient(() => crypto.randomUUID(), store, () => window.dispatchEvent(new Event(RECOVERY_CHANGED))).execute(intent, pinned);
    },
    onSuccess: result => { if (result.actorId === activeActor.current) setConfirmed(result); },
    onSettled: () => {
      read();
      void queryClient.invalidateQueries({ predicate: query => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/supplier-credits") });
      void invalidateApPaymentQueries(queryClient); void invalidatePurchaseCosts(queryClient);
    },
  });
  return {
    userId, canCreate, canApprove, recovery, storageError, confirmed, pending: mutation.isPending, error: mutation.error?.message ?? null,
    blocked: !store || mutation.isPending || recovery !== null || storageError !== null,
    recoverAllowed: recovery !== null && recovery.userId === userId && permitted(recovery.body), refresh: read,
    execute: (intent: SupplierCreditIntent) => mutation.mutateAsync({ intent }),
    recover: () => { if (recovery) mutation.mutate({ intent: recovery.body, pinned: recovery }); },
  };
}
export type SupplierCreditCommands = ReturnType<typeof useSupplierCreditCommands>;
