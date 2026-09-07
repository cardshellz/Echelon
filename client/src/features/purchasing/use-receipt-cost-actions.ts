import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import type { ReceiptCostActions } from "./PurchaseCostApplications";
import { createReceiptCostRetryClient } from "./receipt-cost-retry";

export function useReceiptCostActions(purchaseOrderId: number): ReceiptCostActions {
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const retry = useMemo(() => createReceiptCostRetryClient({ generateKey: () => crypto.randomUUID() }), []);
  const mutation = useMutation({
    mutationFn: retry,
    onMutate: () => { setMessage(null); },
    onSuccess: async (result) => {
      setMessage(result.state === "applied" ? "The receipt cost attempt completed. Review the recorded applications."
        : result.state === "review_required" ? "The receipt is recorded. Its cost evidence needs review; see the recorded reasons."
        : result.state === "retry_required" ? "The receipt is recorded. Cost processing still requires a retry."
        : "No cost request is recorded for this receipt.");
      await queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${purchaseOrderId}`, "workspace"] });
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${purchaseOrderId}`, "workspace"] });
    },
  });
  return {
    canRetry: hasPermission("purchasing", "approve"),
    pendingReceiptId: mutation.isPending ? mutation.variables ?? null : null,
    onRetry: (receiptId) => { if (!mutation.isPending && hasPermission("purchasing", "approve")) mutation.mutate(receiptId); },
    message,
    error: mutation.error ? mutation.error instanceof Error ? mutation.error.message : "Cost processing could not be verified." : null,
  };
}
