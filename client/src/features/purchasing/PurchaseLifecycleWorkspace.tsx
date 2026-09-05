import React from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { purchaseWorkspaceSchema, type PurchaseWorkspace } from "@shared/procurement/purchase-workspace";
import type { ProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PurchaseLifecycleOverview } from "./PurchaseLifecycleOverview";
import { PurchaseRecordInspector } from "./PurchaseRecordInspector";

export interface PurchaseLifecycleWorkspaceProps {
  purchaseOrderId: number;
  navigation: ProcurementNavigation;
}

export async function loadPurchaseWorkspace(purchaseOrderId: number, signal?: AbortSignal): Promise<PurchaseWorkspace> {
  if (!Number.isSafeInteger(purchaseOrderId) || purchaseOrderId <= 0) {
    throw new Error("This purchase link has an invalid purchase order ID.");
  }
  const response = await fetch(`/api/purchase-orders/${purchaseOrderId}/workspace`, {
    credentials: "include",
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("You do not have access to this purchase workspace. Sign in with an authorized account and retry.");
  }
  if (response.status === 404) throw new Error("This purchase order is unavailable or no longer exists.");
  if (response.status === 422) throw new Error("This purchase has too many connected records for this view. Use the Shipments, Receipts and Invoices tabs to inspect source records.");
  if (!response.ok) throw new Error(`Could not load the purchase workspace (HTTP ${response.status}). Please retry.`);
  const result = purchaseWorkspaceSchema.safeParse(await response.json());
  if (!result.success || result.data.purchase.id !== purchaseOrderId) {
    throw new Error("The purchase workspace response could not be verified. Please retry.");
  }
  return result.data;
}

/** Shared query options keep mounted workspace data coherent with PO commands. */
export function purchaseWorkspaceQueryOptions(purchaseOrderId: number) {
  return queryOptions({
    queryKey: [`/api/purchase-orders/${purchaseOrderId}`, "workspace"] as const,
    queryFn: ({ signal }) => loadPurchaseWorkspace(purchaseOrderId, signal),
    enabled: Number.isSafeInteger(purchaseOrderId) && purchaseOrderId > 0,
  });
}

export function PurchaseLifecycleWorkspaceView({ data, navigation }: { data: PurchaseWorkspace; navigation: ProcurementNavigation }) {
  return (
    <div className="space-y-4" data-testid="purchase-lifecycle-workspace">
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <PurchaseLifecycleOverview data={data} navigation={navigation} />
        <PurchaseRecordInspector data={data} navigation={navigation} />
      </div>
      {data.limitations.length > 0 && (
        <details className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium">About these records</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">{data.limitations.map((limitation, index) => <li key={`${index}:${limitation}`}>{limitation}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

export function PurchaseLifecycleWorkspace({ purchaseOrderId, navigation }: PurchaseLifecycleWorkspaceProps) {
  const { data, error, isLoading, isFetching, refetch } = useQuery(purchaseWorkspaceQueryOptions(purchaseOrderId));

  if (isLoading) {
    return <Card><CardContent role="status" className="flex items-center gap-3 p-6 text-sm text-muted-foreground"><RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />Loading connected purchase records…</CardContent></Card>;
  }

  if (!data) {
    return (
      <Card><CardContent className="space-y-3 p-5">
        <p role="alert" className="text-sm">{error instanceof Error ? error.message : "The purchase workspace is unavailable."}</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}><RefreshCw className="h-4 w-4" aria-hidden="true" />Retry</Button>
      </CardContent></Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Purchase lifecycle</h2>
          <p className="mt-1 text-sm text-muted-foreground">Follow {data.purchase.poNumber} through its connected shipments, receipts and financial records.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}><RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} aria-hidden="true" />Refresh</Button>
      </div>
      {error && <p role="alert" className="rounded-md border p-3 text-sm text-amber-700 dark:text-amber-400">Refresh failed. Showing the previously loaded records; use Refresh to try again.</p>}
      <PurchaseLifecycleWorkspaceView data={data} navigation={navigation} />
    </div>
  );
}
