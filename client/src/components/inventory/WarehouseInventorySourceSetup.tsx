import React, { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  prepareWarehouseInventorySourceRequestSchema,
  prepareWarehouseInventorySourceResultSchema,
  warehouseInventorySourceViewSchema,
  type WarehouseInventorySourceView,
  type WarehouseConfiguredSource,
} from "@shared/types/warehouse-inventory-source";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

const SOURCE_URL = "/api/warehouses/inventory-sources";

export function SavedWarehouseSourceSummary({ configuration }: { configuration: WarehouseConfiguredSource | undefined }) {
  if (!configuration) return <p role="alert">Reload to read the saved warehouse settings before preparing this source.</p>;
  if (configuration.status === "blocked") return <p role="alert">{configuration.message}</p>;
  const fulfillment = { echelon: "Echelon pick and pack", external_provider: "External warehouse", none: "Storage only; does not fulfill orders" };
  const inventory = { internal: "Stock managed in Echelon", inbound: "Stock read from the warehouse's saved source channel", manual: "Manually maintained stock" };
  return <div className="space-y-1 text-sm" aria-label="Saved warehouse settings">
    <p>{inventory[configuration.inventoryDirection]}</p>
    <p>{fulfillment[configuration.fulfillmentAuthority]}</p>
    {configuration.inventoryDirection === "inbound" && <p>
      This is an incoming inventory feed. Preparing it does not enable sending quantities back to that channel.
    </p>}
  </div>;
}

async function responseBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      && body.error && typeof body.error === "object" && "message" in body.error
      && typeof body.error.message === "string" ? body.error.message : "Warehouse setup request failed.";
    throw new Error(message);
  }
  return body;
}

/** Lives in existing channel setup; it prepares sources, never activates or publishes. */
export function WarehouseInventorySourceSetup({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [warehouseId, setWarehouseId] = useState("");
  const [reason, setReason] = useState("");
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const view = useQuery<WarehouseInventorySourceView>({
    queryKey: [SOURCE_URL],
    queryFn: async () => warehouseInventorySourceViewSchema.parse(
      await responseBody(await fetch(SOURCE_URL, { credentials: "include" })),
    ),
  });
  const warehouse = view.data?.warehouses.find(row => String(row.id) === warehouseId);
  const prepare = useMutation({
    mutationFn: async () => {
      if (!warehouse || warehouse.isActive !== 1 || warehouse.source || warehouse.configuredSource?.status !== "ready") {
        throw new Error("Select an active warehouse that has not already been prepared.");
      }
      const body = {
        warehouseId: warehouse.id, expectedWarehouseFingerprint: warehouse.fingerprint,
        authoritySource: "warehouse_settings", changeReason: reason.trim(),
      };
      // Keep the key for an uncertain retry of the exact payload. A changed
      // selection, reason, or server fingerprint is a different command.
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      const request = prepareWarehouseInventorySourceRequestSchema.parse({
        ...body, idempotencyKey: attempt.current.key,
      });
      return prepareWarehouseInventorySourceResultSchema.parse(await responseBody(await fetch(SOURCE_URL, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
      })));
    },
    onSuccess: async () => {
      attempt.current = null;
      setReason("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [SOURCE_URL] }),
        queryClient.invalidateQueries({ queryKey: ["/api/inventory-planning/admin/channel-exposure"] }),
      ]);
      toast({ title: "Warehouse source prepared", description: "Saved as a draft. Live inventory and publishing are unchanged." });
    },
    onError: (error: Error) => toast({
      title: "Warehouse source was not prepared", description: error.message, variant: "destructive",
    }),
  });
  const disabled = !canEdit || prepare.isPending;
  return <Card>
    <CardHeader>
      <CardTitle>Prepare an existing warehouse</CardTitle>
      <p className="text-sm text-muted-foreground">
        Make an existing warehouse available in the source selectors below.
        Uses the building type and inventory source already saved in Warehouse settings; no duplicate ownership choices.
        This saves a draft only; it does not move stock, enable publishing, or change who controls live inventory.
      </p>
    </CardHeader>
    <CardContent className="space-y-4">
      {view.isLoading && <p>Loading warehouses…</p>}
      {view.error && <p role="alert" className="text-destructive">{view.error.message}</p>}
      {view.data && <>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="inventory-source-warehouse">Existing warehouse</Label>
            <select id="inventory-source-warehouse" className="h-10 w-full rounded-md border bg-background px-3"
              value={warehouseId} disabled={disabled} onChange={event => setWarehouseId(event.target.value)}>
              <option value="">Select warehouse</option>
              {view.data.warehouses.map(row => <option key={row.id} value={row.id} disabled={row.isActive !== 1}>
                {row.code} — {row.name}{row.isActive !== 1 ? " (inactive)" : row.source ? " (already prepared)" : ""}
              </option>)}
            </select>
          </div>
          {warehouse && !warehouse.source && <SavedWarehouseSourceSummary configuration={warehouse.configuredSource} />}
        </div>
        {warehouse?.source && <p className="text-sm">
          {warehouse.code} already has a {warehouse.source.lifecycleStatus} source. Select it below; this action will not replace it.
        </p>}
        <div className="space-y-2">
          <Label htmlFor="inventory-source-reason">Reason for preparing this warehouse</Label>
          <Textarea id="inventory-source-reason" value={reason} maxLength={1000}
            disabled={disabled || Boolean(warehouse?.source)} onChange={event => setReason(event.target.value)} />
        </div>
        <Button disabled={disabled || !warehouse || warehouse.isActive !== 1 || Boolean(warehouse.source)
          || warehouse.configuredSource?.status !== "ready" || !reason.trim()}
          onClick={() => prepare.mutate()}>
          {prepare.isPending ? "Saving draft…" : "Prepare warehouse source"}
        </Button>
      </>}
    </CardContent>
  </Card>;
}
