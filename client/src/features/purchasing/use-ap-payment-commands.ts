import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { createApPaymentCommandClient, createApPaymentRecoveryStore, type ApPaymentCommand, type ApPaymentRecovery } from "@/lib/ap-payment-command";
import { invalidateApPaymentQueries } from "./ap-work-list-query";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";

const RECOVERY_CHANGED = "echelon:ap-payment-recovery-changed";
export function useApPaymentCommands() {
  const { user, hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const userId = user?.id ?? null;
  const actor = useRef(userId); actor.current = userId;
  const [confirmed, setConfirmed] = useState<{ key: string; operation: ApPaymentCommand["operation"]; paymentId: number } | null>(null);
  const store = useMemo(() => userId ? createApPaymentRecoveryStore(() => window.sessionStorage, userId) : null, [userId]);
  const [recovery, setRecovery] = useState<ApPaymentRecovery | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const canApprove = hasPermission("purchasing", "approve");
  const read = useCallback(() => {
    try { setRecovery(store?.read() ?? null); setStorageError(null); }
    catch (error) { setRecovery(null); setStorageError(error instanceof Error ? error.message : "Payment recovery is unavailable."); }
  }, [store]);
  useEffect(() => {
    setConfirmed(null);
    read();
    window.addEventListener(RECOVERY_CHANGED, read);
    window.addEventListener("storage", read);
    return () => { window.removeEventListener(RECOVERY_CHANGED, read); window.removeEventListener("storage", read); };
  }, [read]);
  const mutation = useMutation({
    mutationFn: async ({ command, pinned }: { command: ApPaymentCommand; pinned?: ApPaymentRecovery }) => {
      if (!store || !userId || !canApprove) throw new Error("Sign in with payment approval permission to recover or submit this request. The saved request is retained.");
      const client = createApPaymentCommandClient(() => crypto.randomUUID(), store, () => window.dispatchEvent(new Event(RECOVERY_CHANGED)));
      return client.execute(command, pinned);
    },
    // A retry is an explicit operator action. Persistent intent survives both
    // authorization failures and navigation, independently of current form data.
    onSuccess: (result) => {
      if (result.actorId !== actor.current) return;
      setConfirmed({ key: result.idempotencyKey, operation: result.command, paymentId: result.paymentId });
      toast({ title: result.command === "record_payment" ? "Payment recorded" : result.command === "apply_payment" ? "Existing payment applied" : "Payment voided", description: "apLedgerOutcome" in result && result.apLedgerOutcome && typeof result.apLedgerOutcome === "object" && "message" in result.apLedgerOutcome ? String(result.apLedgerOutcome.message) : undefined });
    },
    onSettled: () => {
      read();
      void invalidateApPaymentQueries(queryClient);
      void invalidatePurchaseCosts(queryClient);
    },
  });
  return {
    userId, recovery, storageError, canApprove, confirmed, pending: mutation.isPending, error: mutation.error?.message ?? null,
    blocked: !store || !canApprove || mutation.isPending || storageError !== null || recovery !== null,
    refresh: read,
    execute: (command: ApPaymentCommand) => mutation.mutateAsync({ command }),
    recover: () => { if (recovery) mutation.mutate({ command: recovery.body, pinned: recovery }); },
  };
}
export type ApPaymentCommands = ReturnType<typeof useApPaymentCommands>;
