import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { createRfqCommandClient, createRfqRecoveryStore, type RfqCommandRecovery } from "@/lib/rfq-command";
import { rfqCommandReceiptSchema, type RfqCommandIntent, type RfqCommandReceipt } from "@shared/procurement/rfq-command";

const RECOVERY_CHANGED = "echelon:rfq-recovery-changed";
const RECEIPT_CONFIRMED = "echelon:rfq-receipt-confirmed";
export async function invalidateRfqQueries(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ predicate: query => {
    const key = query.queryKey[0];
    return typeof key === "string" && (key === "rfq-workflow" || key === "rfq-quote-history"
      || /^\/api\/purchasing\/(?:rfqs|rfq-queue|auto-draft\/runs|recommendation-decisions)(?:[/?]|$)/.test(key)
      || /^\/api\/purchase-orders(?:[/?]|$)/.test(key));
  } });
}

/** All RFQ entrypoints share one immutable, actor-bound pending request. */
export function useRfqCommands(scopeRfqId?: number) {
  const { user, hasPermission } = useAuth();
  const userId = user?.id ?? null;
  const canEdit = hasPermission("purchasing", "edit");
  const context = useRef({ userId, canEdit, scopeRfqId });
  context.current = { userId, canEdit, scopeRfqId };
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const store = useMemo(() => userId ? createRfqRecoveryStore(() => window.sessionStorage, userId) : null, [userId]);
  const queryClient = useQueryClient();
  const [recovery, setRecovery] = useState<RfqCommandRecovery | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<RfqCommandReceipt | null>(null);
  const resetFeedback = useRef<() => void>(() => undefined);
  const read = useCallback(() => {
    if (!mounted.current || context.current.userId !== userId) return;
    try { setRecovery(store?.read() ?? null); setStorageError(null); }
    catch (error) { setRecovery(null); setStorageError(error instanceof Error ? error.message : "RFQ recovery is unavailable."); }
  }, [store, userId]);
  useEffect(() => {
    setConfirmed(null); read();
    const receive = (event: Event) => {
      const receipt = rfqCommandReceiptSchema.safeParse((event as CustomEvent<unknown>).detail);
      if (!mounted.current || context.current.userId !== userId || context.current.scopeRfqId !== scopeRfqId
        || !receipt.success || receipt.data.actorId !== userId
        || (scopeRfqId !== undefined && receipt.data.intent.rfqId !== scopeRfqId)) return;
      setConfirmed(receipt.data); resetFeedback.current(); read();
    };
    window.addEventListener(RECEIPT_CONFIRMED, receive);
    window.addEventListener(RECOVERY_CHANGED, read); window.addEventListener("storage", read); window.addEventListener("focus", read);
    return () => { window.removeEventListener(RECEIPT_CONFIRMED, receive); window.removeEventListener(RECOVERY_CHANGED, read); window.removeEventListener("storage", read); window.removeEventListener("focus", read); };
  }, [read, scopeRfqId]);
  const permitted = (intent: RfqCommandIntent) => mounted.current && context.current.userId === userId && context.current.canEdit
    && context.current.scopeRfqId === scopeRfqId && (scopeRfqId === undefined || intent.rfqId === scopeRfqId);
  const feedbackScope = useRef<{ userId: string | null; scopeRfqId?: number } | null>(null);
  const mutation = useMutation({
    retry: false, networkMode: "always",
    mutationFn: async ({ intent, pinned }: { intent: RfqCommandIntent; pinned?: RfqCommandRecovery }) => {
      if (!store || !userId) throw new Error("Sign in before creating or recovering an RFQ request.");
      return createRfqCommandClient(() => crypto.randomUUID(), store, {
        canExecute: permitted, changed: () => window.dispatchEvent(new Event(RECOVERY_CHANGED)),
      }).execute(intent, pinned);
    },
    onMutate: () => { feedbackScope.current = { userId, scopeRfqId }; setConfirmed(null); },
    onSuccess: result => {
      if (mounted.current && result.actorId === context.current.userId && context.current.scopeRfqId === scopeRfqId
        && (scopeRfqId === undefined || result.intent.rfqId === scopeRfqId)) {
        setConfirmed(result);
        // A page-level recovery can settle a request first submitted by an
        // embedded editor. Share only the verified receipt with matching views.
        window.dispatchEvent(new CustomEvent(RECEIPT_CONFIRMED, { detail: result }));
      }
    },
    onSettled: () => { read(); void invalidateRfqQueries(queryClient); },
  });
  resetFeedback.current = mutation.reset;
  const currentRecovery = recovery?.userId === userId ? recovery : null;
  const feedbackIsCurrent = feedbackScope.current?.userId === userId && feedbackScope.current?.scopeRfqId === scopeRfqId;
  const currentConfirmation = confirmed?.actorId === userId && (scopeRfqId === undefined || confirmed.intent.rfqId === scopeRfqId) ? confirmed : null;
  return {
    userId, canEdit, recovery: currentRecovery, storageError, confirmed: currentConfirmation, pending: feedbackIsCurrent && mutation.isPending,
    error: feedbackIsCurrent ? mutation.error : null, refresh: read,
    blocked: !store || mutation.isPending || recovery !== null || storageError !== null,
    recoverAllowed: currentRecovery !== null && permitted(currentRecovery.body),
    submit: (intent: RfqCommandIntent) => mutation.mutate({ intent }),
    recover: () => { if (currentRecovery) mutation.mutate({ intent: currentRecovery.body, pinned: currentRecovery }); },
  };
}
export type RfqCommands = ReturnType<typeof useRfqCommands>;
