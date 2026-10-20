import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { createSupplierReturnClient, createSupplierReturnRecoveryStore, type SupplierReturnIntent, type SupplierReturnRecovery } from "@/lib/supplier-return-command";
import { invalidateSupplierReturns } from "./supplier-return-query";
import type { SupplierReturnResult } from "@/lib/supplier-return-command";

const RECOVERY_CHANGED = "echelon:supplier-return-recovery-changed";
export function useSupplierReturnCommands() {
  const { user, hasPermission } = useAuth();
  const userId = user?.id ?? null;
  const activeActor = useRef(userId); activeActor.current = userId;
  const canApprove = hasPermission("purchasing", "approve");
  const store = useMemo(() => userId ? createSupplierReturnRecoveryStore(() => window.sessionStorage, userId) : null, [userId]);
  const queryClient = useQueryClient();
  const [recovery, setRecovery] = useState<SupplierReturnRecovery | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<SupplierReturnResult | null>(null);
  const read = useCallback(() => {
    if (activeActor.current !== userId) return;
    try { setRecovery(store?.read() ?? null); setStorageError(null); }
    catch (error) { setRecovery(null); setStorageError(error instanceof Error ? error.message : "Return recovery is unavailable."); }
  }, [store, userId]);
  useEffect(() => {
    setConfirmed(null); read();
    window.addEventListener(RECOVERY_CHANGED, read); window.addEventListener("storage", read);
    return () => { window.removeEventListener(RECOVERY_CHANGED, read); window.removeEventListener("storage", read); };
  }, [read]);
  const permitted = (_intent: SupplierReturnIntent) => canApprove;
  const mutation = useMutation({
    retry: false, networkMode: "always",
    mutationFn: async ({ intent, pinned }: { intent: SupplierReturnIntent; pinned?: SupplierReturnRecovery }) => {
      if (!store || !userId || activeActor.current !== userId || !permitted(intent)) throw new Error("Current purchasing permission is required. The saved return request is retained.");
      return createSupplierReturnClient(() => crypto.randomUUID(), store, () => window.dispatchEvent(new Event(RECOVERY_CHANGED))).execute(intent, pinned);
    },
    onSuccess: result => { if (result.actorId === activeActor.current) setConfirmed(result); },
    onSettled: () => {
      read();
      void invalidateSupplierReturns(queryClient);
    },
  });
  return {
    userId, canApprove, recovery, storageError, confirmed, pending: mutation.isPending, error: mutation.error?.message ?? null,
    blocked: !store || mutation.isPending || recovery !== null || storageError !== null,
    recoverAllowed: recovery !== null && recovery.userId === userId && permitted(recovery.body), refresh: read,
    execute: (intent: SupplierReturnIntent) => mutation.mutateAsync({ intent }),
    recover: () => { if (recovery) mutation.mutate({ intent: recovery.body, pinned: recovery }); },
  };
}
export type SupplierReturnCommands = ReturnType<typeof useSupplierReturnCommands>;
