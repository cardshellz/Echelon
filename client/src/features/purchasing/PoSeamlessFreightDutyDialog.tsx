import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { usePurchaseTaxTypes } from "@/features/purchasing/PurchaseTaxTypes";
import { apiRequest } from "@/lib/queryClient";
import { financialCommandFetchJson } from "@/lib/financial-command";
import {
  poLandedCostsResponseSchema,
  type PoLandedCostsResponse,
} from "@shared/procurement/po-landed-cost";

export interface PoLinkedShipmentOption {
  id: number;
  number: string;
  status: string;
}

const PO_DIRECT_COST_TYPE_OPTIONS = [
  { value: "freight", label: "Freight / Carrier Shipping" },
  { value: "duty", label: "Customs Duty" },
  { value: "tariff", label: "Import Tariff" },
  { value: "brokerage", label: "Customs Brokerage" },
  { value: "insurance", label: "Cargo Insurance" },
  { value: "drayage", label: "Drayage / Port Trucking" },
  { value: "port_handling", label: "Port Handling" },
  { value: "other", label: "Other Landed Charge" },
];

const SHIPMENT_COST_TYPE_OPTIONS = [
  { value: "freight", label: "Freight / Carrier Shipping" },
  { value: "duty", label: "Customs Duty" },
  { value: "tax", label: "Import Tax / Tariff" },
  { value: "brokerage", label: "Customs Brokerage" },
  { value: "insurance", label: "Cargo Insurance" },
  { value: "drayage", label: "Drayage / Port Trucking" },
  { value: "port_handling", label: "Port Handling" },
  { value: "other", label: "Other Landed Charge" },
];

function parseUsdToCents(raw: string): number {
  const trimmed = raw.trim();
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(trimmed)) {
    throw new Error("Enter a valid non-negative USD amount with up to 2 decimal places.");
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const cents = BigInt(whole || "0") * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  if (cents <= BigInt(0)) {
    throw new Error("Enter a positive USD amount.");
  }
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Amount exceeds the supported limit.");
  }
  return Number(cents);
}

function makeIdempotencyKey(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function usePoDirectLandedCosts(poId: number | null, enabled: boolean) {
  return useQuery<PoLandedCostsResponse>({
    queryKey: [`/api/purchase-orders/${poId}/landed-costs`],
    enabled: Boolean(poId) && enabled,
    queryFn: async () => {
      const res = await fetch(`/api/purchase-orders/${poId}/landed-costs`, {
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Failed to load PO landed costs");
      }
      return poLandedCostsResponseSchema.parse(await res.json());
    },
  });
}

export function PoSeamlessFreightDutyDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poId: number;
  poNumber: string;
  activeShipments: PoLinkedShipmentOption[];
}) {
  const { open, onOpenChange, poId, poNumber, activeShipments } = props;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const hasShipments = activeShipments.length > 0;

  const [selectedShipmentId, setSelectedShipmentId] = useState<string>(() =>
    activeShipments[0] ? String(activeShipments[0].id) : "",
  );
  const [costType, setCostType] = useState<string>("freight");
  const [taxTypeId, setTaxTypeId] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [allocationMethod, setAllocationMethod] = useState<string>("by_value");
  const [invoiceNumber, setInvoiceNumber] = useState<string>("");
  const [costDate, setCostDate] = useState<string>("");
  const [description, setDescription] = useState<string>("");

  const needsTaxType = hasShipments && (costType === "duty" || costType === "tax");
  const purchaseTaxTypes = usePurchaseTaxTypes(open && needsTaxType);

  React.useEffect(() => {
    if (open && activeShipments.length > 0) {
      const exists = activeShipments.some((s) => String(s.id) === selectedShipmentId);
      if (!exists) setSelectedShipmentId(String(activeShipments[0].id));
    }
  }, [open, activeShipments, selectedShipmentId]);

  const { data: vendors = [] } = useQuery<Array<{ id: number; name: string }>>({
    queryKey: ["/api/vendors"],
    enabled: open,
  });
  const [vendorId, setVendorId] = useState<string>("none");

  function resetForm() {
    setCostType("freight");
    setTaxTypeId("");
    setAmount("");
    setAllocationMethod("by_value");
    setVendorId("none");
    setInvoiceNumber("");
    setCostDate("");
    setDescription("");
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const amountCents = parseUsdToCents(amount);
      const parsedVendorId = vendorId !== "none" && Number(vendorId) > 0 ? Number(vendorId) : null;
      const isoDate = costDate ? new Date(`${costDate}T00:00:00`).toISOString() : null;

      if (!hasShipments) {
        const res = await apiRequest("POST", `/api/purchase-orders/${poId}/landed-costs`, {
          costType,
          amountCents,
          currency: "USD",
          allocationMethod,
          vendorId: parsedVendorId,
          invoiceNumber: invoiceNumber.trim() || null,
          costDate: isoDate,
          description: description.trim() || null,
        });
        const data = await res.json();
        return { kind: "po_direct" as const, data };
      }

      const shipment = activeShipments.find((s) => String(s.id) === selectedShipmentId) ?? activeShipments[0];
      if (!shipment) throw new Error("Select a linked Inbound Shipment.");
      if (needsTaxType && !taxTypeId) {
        throw new Error("Choose a configured tax type for duty or tax charges.");
      }

      const wasClosed = shipment.status === "closed";
      const wasCosting = shipment.status === "costing";

      if (wasClosed) {
        await apiRequest("POST", `/api/inbound-shipments/${shipment.id}/reopen-costing`, {
          notes: `Reopened from PO ${poNumber} to record late ${costType} charge`,
        });
      }

      const forcedMethod =
        costType === "duty" || costType === "tax"
          ? "by_value"
          : costType === "brokerage"
            ? "by_line_count"
            : allocationMethod === "default"
              ? null
              : allocationMethod;

      await financialCommandFetchJson(`/api/inbound-shipments/${shipment.id}/costs`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": makeIdempotencyKey(`po-${poId}-shp-${shipment.id}-cost`),
        },
        body: JSON.stringify({
          costType,
          ...(needsTaxType ? { taxTypeId: Number(taxTypeId) } : {}),
          description:
            [description.trim(), invoiceNumber.trim() ? `Ref: ${invoiceNumber.trim()}` : ""]
              .filter(Boolean)
              .join(" · ") || null,
          estimatedCents: amountCents,
          actualCents: amountCents,
          currency: "USD",
          exchangeRate: "1",
          allocationMethod: forcedMethod,
          vendorId: parsedVendorId,
          invoiceDate: isoDate,
          reason: `Added ${costType} charge from PO ${poNumber}`,
        }),
      });

      if (wasClosed) {
        await financialCommandFetchJson(`/api/inbound-shipments/${shipment.id}/close`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes: `Re-closed after adding late ${costType} charge from PO ${poNumber}` }),
        });
      } else if (wasCosting) {
        await financialCommandFetchJson(`/api/inbound-shipments/${shipment.id}/update-costs`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": makeIdempotencyKey(`po-${poId}-shp-${shipment.id}-updcost`),
          },
          body: JSON.stringify({}),
        });
      }

      return { kind: "shipment" as const, shipmentNumber: shipment.number, shipmentId: shipment.id, wasClosed, wasCosting };
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({
        predicate: (q) =>
          typeof q.queryKey[0] === "string" &&
          (q.queryKey[0].startsWith(`/api/purchase-orders/${poId}`) ||
            q.queryKey[0] === "/api/purchase-orders" ||
            q.queryKey[0].startsWith("/api/inbound-shipments")),
      });
      resetForm();
      onOpenChange(false);
      if (result.kind === "po_direct") {
        const lots = result.data?.revaluation?.lotsUpdated ?? 0;
        const cogsRows = result.data?.revaluation?.cogsRowsUpdated ?? 0;
        toast({
          title: "Landed charge saved & applied",
          description:
            lots > 0
              ? `Updated ${lots} FIFO lot(s)${cogsRows > 0 ? ` and ${cogsRows} shipped order COGS row(s)` : ""}.`
              : "Allocated across PO lines. Future receipts will inherit this landed cost automatically.",
        });
      } else {
        toast({
          title: "Shipment charge saved",
          description:
            result.wasClosed || result.wasCosting
              ? `Attached to ${result.shipmentNumber} and pushed updated landed costs to inventory lots.`
              : `Attached to ${result.shipmentNumber}. Landed costs will push to lots when the shipment closes.`,
        });
      }
    },
    onError: (err: Error) => {
      toast({
        title: "Could not save landed charge",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const costTypeOptions = hasShipments ? SHIPMENT_COST_TYPE_OPTIONS : PO_DIRECT_COST_TYPE_OPTIONS;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saveMutation.isPending) onOpenChange(next); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Freight, Duty, or Tariff</DialogTitle>
          <DialogDescription>
            {hasShipments
              ? "Attach a freight, customs duty, or brokerage bill to this PO's Inbound Shipment. Closed shipments automatically reopen, re-allocate, and update FIFO COGS."
              : `Attach a freight, customs duty, or tariff bill directly to ${poNumber}. Already-received FIFO lots and order COGS update automatically.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5">
          {hasShipments && activeShipments.length > 1 && (
            <div className="space-y-1.5">
              <Label>Target Inbound Shipment</Label>
              <Select value={selectedShipmentId} onValueChange={setSelectedShipmentId}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {activeShipments.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.number} ({s.status.replace(/_/g, " ")})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Charge Type *</Label>
              <Select
                value={costType}
                onValueChange={(val) => {
                  setCostType(val);
                  if (val === "duty" || val === "tariff" || val === "tax") {
                    setAllocationMethod("by_value");
                  } else if (val === "brokerage") {
                    setAllocationMethod("by_line_count");
                  }
                }}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {costTypeOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Amount (USD) *</Label>
              <Input
                type="number"
                step="0.01"
                min="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="h-9 font-mono"
              />
            </div>
          </div>

          {needsTaxType && (
            <div className="space-y-1.5">
              <Label htmlFor="po-seamless-tax-type">Tax / Duty Rule *</Label>
              <select
                id="po-seamless-tax-type"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={taxTypeId}
                onChange={(e) => setTaxTypeId(e.target.value)}
              >
                <option value="">Choose configured tax/duty type...</option>
                {purchaseTaxTypes.data?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.code} · {t.name} ({t.treatment})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Split Across Items By</Label>
              <Select value={allocationMethod} onValueChange={setAllocationMethod}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="by_value">By Product Value ($)</SelectItem>
                  <SelectItem value="by_quantity">By Quantity (Pieces)</SelectItem>
                  <SelectItem value="by_line_count">By Line Count (Equal)</SelectItem>
                  {hasShipments && (
                    <>
                      <SelectItem value="by_volume">By Volume (CBM)</SelectItem>
                      <SelectItem value="by_weight">By Weight (kg)</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Carrier / Broker (Optional)</Label>
              <Select value={vendorId} onValueChange={setVendorId}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None / Unspecified</SelectItem>
                  {vendors.map((v) => (
                    <SelectItem key={v.id} value={String(v.id)}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Bill / Reference # (Optional)</Label>
              <Input
                placeholder="e.g. CBP-7501 or UPS-9921"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                className="h-9"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Bill Date (Optional)</Label>
              <Input
                type="date"
                value={costDate}
                onChange={(e) => setCostDate(e.target.value)}
                className="h-9"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Description / Notes</Label>
            <Input
              placeholder="e.g. Ocean LCL drayage + customs entry"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="h-9"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              disabled={saveMutation.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={saveMutation.isPending || !amount.trim()}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? "Applying..." : "Save & Apply to COGS"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
