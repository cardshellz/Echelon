import { useState } from "react";
import type { ListingOperation } from "@shared/types/channel-listing-publication";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { errorMessage, money } from "./model";
import { ListingStockMembership } from "./ListingStockMembership";

const operationLabels: Record<ListingOperation["state"], string> = {
  queued: "Queued",
  submitting: "Submitting",
  processing: "Walmart processing",
  completed: "Processed",
  partially_completed: "Partially processed",
  needs_attention: "Needs attention",
  needs_reconciliation: "Outcome needs verification",
};
const itemLabels: Record<ListingOperation["items"][number]["state"], string> = {
  queued: "Queued",
  processing: "Processing",
  accepted: "Accepted · verification pending",
  verified: "Item verified",
  needs_attention: "Needs attention",
  needs_reconciliation: "Outcome needs verification",
};
// Listing jobs keep their submission-time stock state. Current membership belongs
// to inventory planning and is inspected in the stock publishing dialog.
const stockLabels: Record<
  ListingOperation["items"][number]["stockState"],
  string
> = {
  waiting_for_item: "Waiting for item verification",
  setup_required: "Review stock publishing",
  ready: "Review stock publishing",
};

export function ListingActivity({
  channelId,
  connectionId,
  operations,
  canEdit,
  onReconcile,
  onEditFailed,
}: {
  channelId: number;
  connectionId: number;
  operations: ListingOperation[];
  canEdit: boolean;
  onReconcile(id: string): Promise<void>;
  onEditFailed(id: string): Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Publication Activity</CardTitle>
        <CardDescription>
          Submitted prices and per-item Walmart outcomes. Jobs continue after
          this page closes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {operations.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No listing submissions yet. Add products, complete their details,
            and review the draft.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {operations.map((operation) => (
          <section
            key={operation.id}
            className="space-y-3 rounded-md border p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Badge
                  variant={
                    operation.state.startsWith("needs_")
                      ? "destructive"
                      : "secondary"
                  }
                >
                  {operationLabels[operation.state]}
                </Badge>
                <p className="mt-1 text-xs text-muted-foreground">
                  Submitted {new Date(operation.createdAt).toLocaleString()} ·{" "}
                  {operation.items.length} items
                </p>
              </div>
              {canEdit && operation.state !== "queued" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(operation.id);
                    setError("");
                    try {
                      await onReconcile(operation.id);
                    } catch (failure) {
                      setError(errorMessage(failure));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === operation.id ? "Checking…" : "Check Walmart status"}
                </Button>
              )}
            </div>
            {operation.error && (
              <p className="text-sm text-destructive">{operation.error}</p>
            )}
            {canEdit && operation.items.some((item) => item.canRetry) && (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(operation.id);
                    setError("");
                    try {
                      await onEditFailed(operation.id);
                    } catch (failure) {
                      setError(errorMessage(failure));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Edit failed items
                </Button>
                <p className="text-xs text-muted-foreground">
                  Add confirmed failed items to the draft for correction and a
                  new review. Existing draft edits are preserved.
                </p>
              </div>
            )}
            {operation.items.some((item) => item.state === "verified") && (
              <p className="text-sm">
                Review stock publishing for current SKU membership and
                readiness. Inventory destinations and policies are managed in{" "}
                <a href="/channels/inventory" className="underline">
                  Channel Inventory
                </a>
                .
              </p>
            )}
            <ListingStockMembership
              channelId={channelId}
              connectionId={connectionId}
              items={operation.items}
            />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="p-2">SKU</th>
                    <th className="p-2">Submitted price</th>
                    <th className="p-2">Listing</th>
                    <th className="p-2">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {operation.items.map((item) => (
                    <tr key={item.variantId} className="border-b align-top">
                      <td className="p-2 font-mono text-xs">{item.sku}</td>
                      <td className="whitespace-nowrap p-2">
                        {money(item.priceCents)}
                      </td>
                      <td className="p-2">
                        {itemLabels[item.state]}
                        {item.error && (
                          <p className="mt-1 text-xs text-destructive">
                            {item.error}
                          </p>
                        )}
                      </td>
                      <td className="p-2">{stockLabels[item.stockState]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Technical details</summary>
              <p className="mt-2 break-all">Operation {operation.id}</p>
              {operation.submissionId && (
                <p className="break-all">
                  Walmart feed {operation.submissionId}
                </p>
              )}
              <p>
                Last updated {new Date(operation.updatedAt).toLocaleString()}
              </p>
            </details>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
