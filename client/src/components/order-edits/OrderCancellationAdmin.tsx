import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customerOrderCancellationSchema } from "@shared/customer-account/order-cancellation";
import { orderEditRequest, formatOrderEditMoney } from "@/lib/order-edits";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Staff can observe/reconcile the original approval. This screen deliberately
 * has no cancellation submission, manual balance write or hold-release command. */
export function OrderCancellationAdmin({
  operationId,
}: {
  operationId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ["order-cancellation", operationId],
    queryFn: ({ signal }) =>
      orderEditRequest(
        `/cancellations/${operationId}`,
        customerOrderCancellationSchema,
        { signal },
      ),
    retry: false,
    refetchInterval: (query) =>
      query.state.error ||
      !query.state.data ||
      ["completed", "not_submitted", "review_required"].includes(
        query.state.data.status,
      )
        ? false
        : 5_000,
  });
  async function recheck(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await orderEditRequest(
        `/cancellations/${operationId}/reconcile`,
        customerOrderCancellationSchema,
        { method: "POST", body: {}, key: crypto.randomUUID() },
      );
      await status.refetch();
    } catch (error) {
      setFailure(
        error instanceof Error
          ? error.message
          : "Cancellation reconciliation failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  const value = status.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Customer order cancellation{value ? ` · ${value.orderNumber}` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.isLoading && <p role="status">Loading cancellation…</p>}
        {value && (
          <>
            <dl className="grid grid-cols-2 gap-2">
              <dt>Status</dt>
              <dd>{value.status.replaceAll("_", " ")}</dd>
              <dt>Refund</dt>
              <dd>
                {formatOrderEditMoney(value.refundCents, value.currency)} ·{" "}
                {value.refundStatus.replaceAll("_", " ")}
              </dd>
              <dt>Rewards returned</dt>
              <dd>
                {value.rewards.returnedPoints} points ·{" "}
                {value.rewards.settled ? "settled" : "pending"}
              </dd>
            </dl>
            <p className="text-sm text-muted-foreground">
              Status checks reconcile the saved approval with Shopify, the
              rewards ledger and warehouse. They never submit another
              cancellation.
            </p>
          </>
        )}
        {(failure || status.error || value?.error) && (
          <div role="alert">
            <p>
              {failure ??
                (status.error instanceof Error
                  ? status.error.message
                  : value?.error?.message)}
            </p>
            <Button
              variant="outline"
              disabled={busy || status.isFetching}
              onClick={() => void recheck()}
            >
              Recheck cancellation
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Cancellation reference: {operationId}
        </p>
      </CardContent>
    </Card>
  );
}
