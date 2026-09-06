import React, { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  prepareWarehouseInventorySourceRequestSchema,
  prepareWarehouseInventorySourceResultSchema,
  warehouseInventorySourceViewSchema,
  type WarehouseInventorySourceView,
} from "@shared/types/warehouse-inventory-source";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

const SOURCE_URL = "/api/warehouses/inventory-sources";

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
  const [inventoryAuthority, setInventoryAuthority] = useState("");
  const [fulfillmentAuthority, setFulfillmentAuthority] = useState("");
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
      if (!warehouse || warehouse.isActive !== 1 || warehouse.source) {
        throw new Error("Select an active warehouse that has not already been prepared.");
      }
      const body = {
        warehouseId: warehouse.id, expectedWarehouseFingerprint: warehouse.fingerprint,
        inventoryAuthority, fulfillmentAuthority, changeReason: reason.trim(),
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
        This saves a draft only; it does not move stock, enable publishing, or change who controls live inventory.
      </p>
    </CardHeader>
    <CardContent className="space-y-4">
      {view.isLoading && <p>Loading warehouses…</p>}
      {view.error && <p role="alert" className="text-destructive">{view.error.message}</p>}
      {view.data && <>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="inventory-source-warehouse">Existing warehouse</Label>
            <select id="inventory-source-warehouse" className="h-10 w-full rounded-md border bg-background px-3"
              value={warehouseId} disabled={disabled} onChange={event => {
                setWarehouseId(event.target.value); setInventoryAuthority(""); setFulfillmentAuthority("");
              }}>
              <option value="">Select warehouse</option>
              {view.data.warehouses.map(row => <option key={row.id} value={row.id} disabled={row.isActive !== 1}>
                {row.code} — {row.name}{row.isActive !== 1 ? " (inactive)" : row.source ? " (already prepared)" : ""}
              </option>)}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="inventory-source-authority">Who owns the inventory quantities?</Label>
            <select id="inventory-source-authority" className="h-10 w-full rounded-md border bg-background px-3"
              value={inventoryAuthority} disabled={disabled || Boolean(warehouse?.source)}
              onChange={event => setInventoryAuthority(event.target.value)}>
              <option value="">Choose explicitly</option>
              <option value="echelon">Echelon</option>
              <option value="external_provider">External warehouse provider</option>
              <option value="manual">Manual records</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="inventory-source-fulfillment">Who controls fulfillment?</Label>
            <select id="inventory-source-fulfillment" className="h-10 w-full rounded-md border bg-background px-3"
              value={fulfillmentAuthority} disabled={disabled || Boolean(warehouse?.source)}
              onChange={event => setFulfillmentAuthority(event.target.value)}>
              <option value="">Choose explicitly</option>
              <option value="echelon">Echelon</option>
              <option value="external_provider">External warehouse provider</option>
              <option value="none">Not a fulfillment site</option>
            </select>
          </div>
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
          || !inventoryAuthority || !fulfillmentAuthority || !reason.trim()}
          onClick={() => prepare.mutate()}>
          {prepare.isPending ? "Saving draft…" : "Prepare warehouse source"}
        </Button>
      </>}
    </CardContent>
  </Card>;
}
