import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { format } from "date-fns";
import { AlertTriangle, Check, ChevronsUpDown, FileText, Package, Plus, Ship, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TabsContent } from "@/components/ui/tabs";
import { ShipmentQuantityControl } from "@/components/purchasing/ShipmentQuantityControl";
import { ShipmentCustodyReceiptLinks } from "@/components/purchasing/ShipmentCustodyReceiptLinks";
import {
  ShipmentReceiptPackResolutionDialog,
  type ShipmentReceiptPackResolution,
  type ShipmentReceiptPackResolutionLine,
} from "@/components/purchasing/ShipmentReceiptPackResolutionDialog";
import { DocumentRelationships } from "@/features/purchasing/DocumentRelationships";
import { ShipmentCreateRecovery } from "@/features/purchasing/ShipmentCreateRecovery";
import type { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { useShipmentCreation } from "@/hooks/use-shipment-creation";
import { useToast } from "@/hooks/use-toast";
import type { ShipmentCreateRecovery as ShipmentRecovery } from "@/lib/shipment-create-command";
import {
  clearReceiptUnitDraft,
  fetchShipmentReceiptResolution,
  parsePoDirectReceiveOption,
  requiresReceiptUnitReview,
  shipmentReceiveCoverageLabel,
} from "@/lib/shipment-receipt-units";
import {
  parseShipmentUnits,
  shipmentQuantityDraft,
  shipmentQuantityPayload,
  shipmentQuantityPreview,
  type ShipmentQuantityDraft,
} from "@/lib/shipment-unit-entry";
import { shipmentCreateSchema, type ShipmentCreateInput } from "@shared/procurement/shipment-create-command";
import { parseShipmentCreateSources } from "@shared/procurement/shipment-create-source";
import type { ShipmentReceiptUnitSelection } from "@shared/procurement/shipment-receipt-plan";
import { centsToMills, formatMills } from "@shared/utils/money";
import {
  formatCents,
  type NavigationSnapshot,
  parsePositiveInt,
  type VendorOption,
} from "./po-detail-types-and-helpers";

export function usePoShipmentsAndReceipts(params: {
  poId: number | null;
  activeTab: string;
  searchStr: string;
  navigate: (to: string, options?: { replace?: boolean }) => void;
  captureNavigation: () => NavigationSnapshot;
}) {
  const { poId, activeTab, searchStr, navigate, captureNavigation } = params;
  const shipmentCreation = useShipmentCreation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [showCreateShipmentDialog, setShowCreateShipmentDialog] = useState(false);
  const [showReceivePicker, setShowReceivePicker] = useState(false);
  const [shipmentReceiptPackResolution, setShipmentReceiptPackResolution] = useState<ShipmentReceiptPackResolution | null>(null);
  const [pendingShipmentReceipt, setPendingShipmentReceipt] = useState<{ shipmentId: number; purchaseOrderId: number } | null>(null);
  const [checkingShipmentReceiptPacks, setCheckingShipmentReceiptPacks] = useState(false);
  const resumeShipmentReceiptHandled = React.useRef<string | null>(null);
  const [newShipmentForm, setNewShipmentForm] = useState({
    mode: "sea_fcl",
    shipmentNumber: "",
    shipperName: "",
    forwarderName: "",
    carrierName: "",
  });
  const [shipperOpen, setShipperOpen] = useState(false);
  const [shipperSearch, setShipperSearch] = useState("");
  const [lineSelections, setLineSelections] = useState<Record<number, { checked: boolean; quantity: ShipmentQuantityDraft }>>({});

  const shippableLinesQuery = useQuery({
    queryKey: [`/api/purchase-orders/${poId}/shippable-lines`, "shipment-create"],
    enabled: !!poId && showCreateShipmentDialog,
    retry: false,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      if (!poId) throw new Error("Select a purchase order before creating a shipment.");
      const response = await fetch(`/api/purchase-orders/${poId}/shippable-lines`, { credentials: "include", signal });
      if (!response.ok) throw new Error("Available purchase lines could not be loaded.");
      try {
        return parseShipmentCreateSources(await response.json(), poId);
      } catch {
        throw new Error("Available purchase line identities or quantities could not be verified.");
      }
    },
  });
  const { isError: shippableLinesError, isPending: shippableLinesLoading, refetch: refetchShippableLines } = shippableLinesQuery;
  const shippableLinesData = shippableLinesError ? undefined : shippableLinesQuery.data;

  useEffect(() => {
    if (shippableLinesData?.lines && showCreateShipmentDialog) {
      const selections: Record<number, { checked: boolean; quantity: ShipmentQuantityDraft }> = {};
      for (const line of shippableLinesData.lines) {
        if (!(line.id in lineSelections)) {
          selections[line.id] = { checked: true, quantity: shipmentQuantityDraft(line.remainingQty, parseShipmentUnits(line.shipmentUnits)) };
        }
      }
      if (Object.keys(selections).length > 0) {
        setLineSelections(prev => ({ ...prev, ...selections }));
      }
    }
  }, [shippableLinesData, showCreateShipmentDialog]);

  const { data: vendors = [], isLoading: vendorsLoading, isError: vendorsError, refetch: refetchVendors } = useQuery<VendorOption[]>({
    queryKey: ["/api/vendors"],
  });

  const { data: receiptsData } = useQuery<{ receipts: any[] }>({
    queryKey: [`/api/purchase-orders/${poId}/receipts`],
    enabled: !!poId && activeTab === "receipts",
  });
  const receipts = receiptsData?.receipts ?? [];

  const { data: receiveOptions, isLoading: receiveOptionsLoading } = useQuery<any>({
    queryKey: [`/api/purchase-orders/${poId}/receive-options`],
    enabled: !!poId && showReceivePicker,
  });

  const createReceiptMutation = useMutation({
    onMutate: captureNavigation,
    mutationFn: async () => {
      const idempotencyKey = (
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? (crypto as any).randomUUID()
          : `po-receipt-${poId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      ) as string;
      const res = await fetch(`/api/purchase-orders/${poId}/create-receipt`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Failed to create receipt"); }
      return res.json();
    },
    onSuccess: (receipt, _variables, context) => {
      const originatingPoId = context?.poId;
      if (originatingPoId) {
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${originatingPoId}`] });
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${originatingPoId}/receipts`] });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      toast({ title: "Receipt created", description: `Receipt ${receipt.receiptNumber} created` });
      if (context?.isCurrent()) navigate(context.childHref(`/receiving?open=${receipt.id}`));
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  async function fetchShipmentReceiptPackResolution(
    paramsToResolve: { shipmentId: number; purchaseOrderId: number },
    selections?: ShipmentReceiptUnitSelection[],
  ) {
    return fetchShipmentReceiptResolution(paramsToResolve, selections);
  }

  async function openShipmentReceiptPackBlocker(
    paramsToCheck: { shipmentId: number; purchaseOrderId: number } | undefined | null,
  ): Promise<boolean> {
    if (!paramsToCheck) return false;
    const navigation = captureNavigation();
    setCheckingShipmentReceiptPacks(true);
    setPendingShipmentReceipt(paramsToCheck);
    try {
      const resolution = await fetchShipmentReceiptPackResolution(paramsToCheck);
      if (!navigation.isCurrent()) return false;
      if (requiresReceiptUnitReview(resolution)) {
        setShipmentReceiptPackResolution(resolution);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      if (navigation.isCurrent()) setCheckingShipmentReceiptPacks(false);
    }
  }

  const createReceiptFromShipmentMutation = useMutation({
    onMutate: (variables: { shipmentId: number; purchaseOrderId: number; navigation?: NavigationSnapshot; receiptUnitSelections?: ShipmentReceiptUnitSelection[] }) =>
      variables.navigation ?? captureNavigation(),
    mutationFn: async ({ shipmentId, purchaseOrderId, receiptUnitSelections = [] }: { shipmentId: number; purchaseOrderId: number; navigation?: NavigationSnapshot; receiptUnitSelections?: ShipmentReceiptUnitSelection[] }) => {
      const idempotencyKey = (
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? (crypto as any).randomUUID()
          : `shp-receipt-${shipmentId}-${purchaseOrderId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      ) as string;
      const res = await fetch(`/api/inbound-shipments/${shipmentId}/create-receipt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ purchaseOrderId, ...(receiptUnitSelections.length ? { receiptUnitSelections } : {}) }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Failed to create receipt"); }
      return res.json();
    },
    onSuccess: (receipt, variables, context) => {
      clearReceiptUnitDraft(variables);
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${variables.purchaseOrderId}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${variables.purchaseOrderId}/receipts`] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${variables.purchaseOrderId}/receive-options`] });
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      toast({ title: "Receipt created", description: `Receipt ${receipt.receiptNumber} created from shipment` });
      if (!context?.isCurrent()) return;
      setShowReceivePicker(false);
      setShipmentReceiptPackResolution(null);
      setPendingShipmentReceipt(null);
      navigate(context.childHref(`/receiving?open=${receipt.id}`));
    },
    onError: async (err: Error, variables, context) => {
      if (!context?.isCurrent()) return;
      const openedBlocker = await openShipmentReceiptPackBlocker(variables);
      if (openedBlocker) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  async function checkAndReceiveShipment(
    paramsToReceive: { shipmentId: number; purchaseOrderId: number },
    navigation: NavigationSnapshot = captureNavigation(),
  ) {
    if (navigation.isCurrent()) {
      setCheckingShipmentReceiptPacks(true);
      setPendingShipmentReceipt(paramsToReceive);
    }
    try {
      const resolution = await fetchShipmentReceiptPackResolution(paramsToReceive);
      if (requiresReceiptUnitReview(resolution)) {
        if (navigation.isCurrent()) setShipmentReceiptPackResolution(resolution);
        return;
      }
      if (navigation.isCurrent()) setShipmentReceiptPackResolution(null);
      createReceiptFromShipmentMutation.mutate({ ...paramsToReceive, navigation });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      if (navigation.isCurrent()) setCheckingShipmentReceiptPacks(false);
    }
  }

  const cleanupEmptyShipmentReceiptMutation = useMutation({
    onMutate: captureNavigation,
    mutationFn: async ({
      receiptId,
    }: {
      receiptId: number;
      shipmentId: number;
      purchaseOrderId: number;
    }) => {
      const res = await fetch(`/api/receiving-orders/${receiptId}/discard`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "Failed to clean up empty receipt");
      return body;
    },
    onSuccess: async (_result, variables, context) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${variables.purchaseOrderId}`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${variables.purchaseOrderId}/receipts`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${variables.purchaseOrderId}/receive-options`] }),
        queryClient.invalidateQueries({ queryKey: ["/api/receiving"] }),
      ]);
      toast({
        title: "Empty receipt cleaned up",
        description: "Rechecking this shipment before creating a new receipt.",
      });
      void checkAndReceiveShipment({
        shipmentId: variables.shipmentId,
        purchaseOrderId: variables.purchaseOrderId,
      }, context);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const voidZeroPostShipmentReceiptMutation = useMutation({
    onMutate: captureNavigation,
    mutationFn: async ({
      receiptId,
    }: {
      receiptId: number;
      shipmentId: number;
      purchaseOrderId: number;
    }) => {
      const res = await fetch(`/api/receiving-orders/${receiptId}/void-zero-post`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "Failed to void zero-post receipt");
      return body;
    },
    onSuccess: async (_result, variables, context) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${variables.purchaseOrderId}`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${variables.purchaseOrderId}/receipts`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${variables.purchaseOrderId}/receive-options`] }),
        queryClient.invalidateQueries({ queryKey: ["/api/receiving"] }),
      ]);
      toast({
        title: "Zero-post receipt voided",
        description: "Rechecking this shipment before creating a new receipt.",
      });
      void checkAndReceiveShipment({
        shipmentId: variables.shipmentId,
        purchaseOrderId: variables.purchaseOrderId,
      }, context);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  async function refreshShipmentReceiptPackResolution(selections?: ShipmentReceiptUnitSelection[]) {
    if (!pendingShipmentReceipt) return;
    const navigation = captureNavigation();
    setCheckingShipmentReceiptPacks(true);
    try {
      const resolution = await fetchShipmentReceiptPackResolution(pendingShipmentReceipt, selections);
      if (!navigation.isCurrent()) return;
      setShipmentReceiptPackResolution(resolution);
    } finally {
      if (navigation.isCurrent()) setCheckingShipmentReceiptPacks(false);
    }
  }

  function createPendingShipmentReceipt(selections: ShipmentReceiptUnitSelection[] = []) {
    if (!pendingShipmentReceipt) return;
    createReceiptFromShipmentMutation.mutate({ ...pendingShipmentReceipt, receiptUnitSelections: selections });
  }

  function openReceiptVariantSetup(line?: ShipmentReceiptPackResolutionLine) {
    const context = pendingShipmentReceipt ?? (shipmentReceiptPackResolution
      ? {
          shipmentId: shipmentReceiptPackResolution.shipmentId,
          purchaseOrderId: shipmentReceiptPackResolution.purchaseOrderId,
        }
      : null);
    const returnParams = new URLSearchParams(searchStr);
    if (context && poId) {
      returnParams.set("resumeShipmentReceipt", "1");
      returnParams.set("shipmentId", String(context.shipmentId));
      returnParams.set("purchaseOrderId", String(context.purchaseOrderId));
    }
    const returnTo = `/purchase-orders/${poId ?? ""}${returnParams.size ? `?${returnParams.toString()}` : ""}`;
    const setupParams = new URLSearchParams({
      receiptSetup: "1",
      returnTo,
    });
    if (line?.sku) setupParams.set("shipmentSku", line.sku);

    if (line?.productId) {
      navigate(`/products/${line.productId}?${setupParams.toString()}`);
      return;
    }

    navigate(`/catalog/variants?${setupParams.toString()}`);
  }

  useEffect(() => {
    if (!poId) return;
    const searchParams = new URLSearchParams(searchStr);
    if (searchParams.get("resumeShipmentReceipt") !== "1") return;

    const shipmentId = parsePositiveInt(searchParams.get("shipmentId"));
    const purchaseOrderId = parsePositiveInt(searchParams.get("purchaseOrderId")) ?? poId;
    searchParams.delete("resumeShipmentReceipt");
    searchParams.delete("shipmentId");
    searchParams.delete("purchaseOrderId");
    const returnHref = `/purchase-orders/${poId}${searchParams.size ? `?${searchParams.toString()}` : ""}`;
    if (!shipmentId || purchaseOrderId !== poId) {
      toast({
        title: "Cannot resume receipt",
        description: "The return link is missing the shipment or PO context.",
        variant: "destructive",
      });
      navigate(returnHref, { replace: true });
      return;
    }

    const resumeKey = `${shipmentId}:${purchaseOrderId}`;
    if (resumeShipmentReceiptHandled.current === resumeKey) return;
    resumeShipmentReceiptHandled.current = resumeKey;
    navigate(returnHref, { replace: true });
    void checkAndReceiveShipment({ shipmentId, purchaseOrderId });
  }, [poId, searchStr]);

  type ShipmentCreateSubmission = {
    body: ShipmentCreateInput;
    recovery?: ShipmentRecovery;
    navigation: NavigationSnapshot;
    visit: ReturnType<typeof shipmentCreation.captureVisit>;
  };

  const createShipmentMutation = useMutation({
    retry: false,
    networkMode: "always",
    mutationFn: (submission: ShipmentCreateSubmission) => {
      if (!submission.visit.isCurrent() || !submission.navigation.isCurrent()) {
        throw new Error("The shipment creation view changed. Review the saved request before sending.");
      }
      return shipmentCreation.execute(submission.body, submission.recovery);
    },
    onSuccess: (shipment, submission) => {
      const owningPoId = submission.body.purchaseOrder?.purchaseOrderId;
      if (owningPoId) {
        void queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${owningPoId}/shipments`] });
        void queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${owningPoId}/shippable-lines`] });
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/inbound-shipments"] });
      if (!submission.navigation.isCurrent() || !submission.visit.isCurrent()) return;
      toast({ title: "Shipment confirmed", description: `${shipment.shipmentNumber} has ${shipment.lineCount} selected lines.` });
      setShowCreateShipmentDialog(false);
      setLineSelections({});
      const href = `/shipments/${shipment.id}`;
      navigate(owningPoId && owningPoId === submission.navigation.poId ? submission.navigation.childHref(href) : href);
    },
    onError: (error: Error, submission) => {
      if (submission.navigation.isCurrent() && submission.visit.isCurrent()) {
        toast({ title: "Shipment creation needs attention", description: error.message, variant: "destructive" });
      }
    },
  });

  const recoverShipmentCreation = (recovery: ShipmentRecovery) => createShipmentMutation.mutate({
    body: recovery.body,
    recovery,
    navigation: captureNavigation(),
    visit: shipmentCreation.captureVisit(),
  });

  const submitShipmentCreation = () => {
    try {
      if (!poId || shippableLinesError || !shippableLinesData) {
        throw new Error("Load and review the available purchase lines before creating a shipment.");
      }
      const lineSelectionsForCreate = shippableLinesData.lines
        .filter((line: any) => lineSelections[line.id]?.checked)
        .map((line) => {
          const { qtyShipped, ...unit } = shipmentQuantityPayload(lineSelections[line.id].quantity, parseShipmentUnits(line.shipmentUnits), line.remainingQty);
          return { poLineId: line.id, qty: qtyShipped, ...unit };
        });
      if (!lineSelectionsForCreate.length) throw new Error("Select at least one purchase line for this shipment.");
      const body = shipmentCreateSchema.parse({
        mode: newShipmentForm.mode || undefined,
        shipmentNumber: newShipmentForm.shipmentNumber || undefined,
        shipperName: newShipmentForm.shipperName || undefined,
        forwarderName: newShipmentForm.forwarderName || undefined,
        carrierName: newShipmentForm.carrierName || undefined,
        purchaseOrder: { purchaseOrderId: poId, lineSelections: lineSelectionsForCreate },
      });
      createShipmentMutation.mutate({ body, navigation: captureNavigation(), visit: shipmentCreation.captureVisit() });
    } catch (error) {
      toast({ title: "Review shipment details", description: error instanceof Error ? error.message : "Invalid shipment details", variant: "destructive" });
    }
  };

  return {
    shipmentCreation,
    showCreateShipmentDialog,
    setShowCreateShipmentDialog,
    showReceivePicker,
    setShowReceivePicker,
    shipmentReceiptPackResolution,
    setShipmentReceiptPackResolution,
    pendingShipmentReceipt,
    checkingShipmentReceiptPacks,
    newShipmentForm,
    setNewShipmentForm,
    shipperOpen,
    setShipperOpen,
    shipperSearch,
    setShipperSearch,
    lineSelections,
    setLineSelections,
    shippableLinesData,
    shippableLinesLoading,
    shippableLinesError,
    refetchShippableLines,
    vendors,
    vendorsLoading,
    vendorsError,
    refetchVendors,
    receipts,
    receiveOptions,
    receiveOptionsLoading,
    createReceiptMutation,
    createReceiptFromShipmentMutation,
    cleanupEmptyShipmentReceiptMutation,
    voidZeroPostShipmentReceiptMutation,
    checkAndReceiveShipment,
    refreshShipmentReceiptPackResolution,
    createPendingShipmentReceipt,
    openReceiptVariantSetup,
    createShipmentMutation,
    recoverShipmentCreation,
    submitShipmentCreation,
  };
}

export type PoShipmentsAndReceiptsController = ReturnType<typeof usePoShipmentsAndReceipts>;

export function PoReceiptsTab(props: {
  receipts: any[];
  childHref: (destination: string) => string;
}) {
  const { receipts, childHref } = props;

  return (
    <TabsContent value="receipts" className="space-y-4">
      {receipts.length === 0 ? (
        <Card>
          <CardContent className="p-4 text-center text-muted-foreground">
            No receipts linked to this PO yet.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PO Line</TableHead>
                <TableHead>Receiving Order</TableHead>
                <TableHead className="text-right">Qty Received</TableHead>
                <TableHead className="text-right">PO Cost</TableHead>
                <TableHead className="text-right">Actual Cost</TableHead>
                <TableHead className="text-right">Variance</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receipts.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell>Line #{r.purchaseOrderLineId}</TableCell>
                  <TableCell>
                    <Link href={childHref(`/receiving?open=${r.receivingOrderId}`)} className="text-primary hover:underline">
                      RO #{r.receivingOrderId}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">{r.qtyReceived}</TableCell>
                  <TableCell className="text-right font-mono">
                    {r.poUnitCostMills != null
                      ? formatMills(Number(r.poUnitCostMills))
                      : r.poUnitCostCents != null
                        ? formatMills(centsToMills(Number(r.poUnitCostCents)))
                        : "$0.0000"}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {r.actualUnitCostMills != null
                      ? formatMills(Number(r.actualUnitCostMills))
                      : r.actualUnitCostCents != null
                        ? formatMills(centsToMills(Number(r.actualUnitCostCents)))
                        : "$0.0000"}
                  </TableCell>
                  <TableCell className={`text-right font-mono ${(r.varianceCents || 0) > 0 ? "text-red-500" : (r.varianceCents || 0) < 0 ? "text-green-500" : ""}`}>
                    {formatCents(r.varianceCents)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {r.createdAt ? format(new Date(r.createdAt), "MMM d, yyyy") : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </TabsContent>
  );
}

export function PoShipmentsTab(props: {
  po: any;
  linesCount: number;
  shippingApplicable: boolean;
  poIncoterms: string | null | undefined;
  shipmentsController: PoShipmentsAndReceiptsController;
}) {
  const { po, linesCount, shippingApplicable, poIncoterms, shipmentsController } = props;

  return (
    <TabsContent value="shipments" className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Inbound shipments carrying goods from this PO.
          {!shippingApplicable && poIncoterms && (
            <span className="ml-2 text-amber-600 font-medium">
              {poIncoterms} — log freight, duty &amp; insurance costs on each shipment.
            </span>
          )}
        </p>
        {linesCount > 0 && !["closed", "cancelled"].includes(po.status) && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              shipmentsController.setNewShipmentForm({
                mode: "sea_fcl",
                shipmentNumber: "",
                shipperName: po?.vendor?.name || "",
                forwarderName: "",
                carrierName: "",
              });
              shipmentsController.setShowCreateShipmentDialog(true);
            }}
          >
            <Plus className="h-4 w-4 mr-1" />
            Create Shipment
          </Button>
        )}
      </div>

      <DocumentRelationships root={{ kind: "purchase", id: po.id }} />
    </TabsContent>
  );
}

export function PoReceiveAndShipmentDialogs(props: {
  po: any;
  shipmentsController: PoShipmentsAndReceiptsController;
  procurementNavigation: ReturnType<typeof useProcurementNavigation>;
  navigate: (to: string, options?: { replace?: boolean }) => void;
}) {
  const { po, shipmentsController: sc, procurementNavigation, navigate } = props;

  return (
    <>
      {/* ═══════ Receive — choose a source ═══════ */}
      <Dialog open={sc.showReceivePicker} onOpenChange={sc.setShowReceivePicker}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Truck className="h-5 w-5" /> Receive {po.poNumber}</DialogTitle>
            <DialogDescription>
              Choose where these goods are coming from. Receiving against a shipment carries its freight onto the received lots.
            </DialogDescription>
          </DialogHeader>
          {(() => {
            if (sc.receiveOptionsLoading) {
              return <div className="py-6 text-center text-sm text-muted-foreground">Checking receive options...</div>;
            }
            const shipmentOptions = sc.receiveOptions?.shipmentOptions ?? [];
            const receivableShipments = shipmentOptions.filter((s: any) => s.receivable);
            const blockedShipments = shipmentOptions.filter((s: any) => !s.receivable);
            const poDirect = parsePoDirectReceiveOption(sc.receiveOptions?.poDirect);
            const busy =
              sc.createReceiptMutation.isPending ||
              sc.createReceiptFromShipmentMutation.isPending ||
              sc.cleanupEmptyShipmentReceiptMutation.isPending ||
              sc.voidZeroPostShipmentReceiptMutation.isPending ||
              sc.checkingShipmentReceiptPacks;
            const renderBlockedShipment = (s: any) => {
              const cleaningThisReceipt =
                sc.cleanupEmptyShipmentReceiptMutation.isPending &&
                sc.cleanupEmptyShipmentReceiptMutation.variables?.receiptId === s.existingReceiptId;
              const voidingThisReceipt =
                sc.voidZeroPostShipmentReceiptMutation.isPending &&
                sc.voidZeroPostShipmentReceiptMutation.variables?.receiptId === s.existingReceiptId;
              return (
                <div key={s.shipmentId} data-testid={`po-receive-option-${s.shipmentId}`} className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="font-mono text-sm font-medium flex items-center gap-1.5">
                        <Ship className="h-4 w-4 text-amber-700" /> {s.shipmentNumber || `Shipment #${s.shipmentId}`}
                      </div>
                      <div className="mt-1 text-xs text-amber-800">
                        {s.reason || "This shipment is blocked from receiving."}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">{shipmentReceiveCoverageLabel(s).text}</div>
                      <ShipmentCustodyReceiptLinks coverage={s} />
                    </div>
                    {s.action === "repair_empty_receipt" && s.existingReceiptId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => sc.cleanupEmptyShipmentReceiptMutation.mutate({
                          receiptId: s.existingReceiptId,
                          shipmentId: s.shipmentId,
                          purchaseOrderId: s.purchaseOrderId,
                        })}
                      >
                        {cleaningThisReceipt ? "Cleaning..." : "Clean up and continue"}
                      </Button>
                    ) : s.action === "void_zero_post_receipt" && s.existingReceiptId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => sc.voidZeroPostShipmentReceiptMutation.mutate({
                          receiptId: s.existingReceiptId,
                          shipmentId: s.shipmentId,
                          purchaseOrderId: s.purchaseOrderId,
                        })}
                      >
                        {voidingThisReceipt ? "Voiding..." : "Void and continue"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            };
            return (
              <div className="space-y-3">
                {receivableShipments.length > 0 ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      This PO has {receivableShipments.length} shipment{receivableShipments.length > 1 ? "s" : ""} ready to receive:
                    </p>
                    {receivableShipments.map((s: any) => (
                      <div key={s.shipmentId} data-testid={`po-receive-option-${s.shipmentId}`} className="flex flex-col items-start justify-between gap-3 rounded-lg border-2 border-blue-200 bg-blue-50/50 p-3 sm:flex-row sm:items-center">
                        <div className="min-w-0">
                          <div className="font-mono text-sm font-medium flex items-center gap-1.5">
                            <Ship className="h-4 w-4 text-blue-600" /> {s.shipmentNumber || `Shipment #${s.shipmentId}`}
                          </div>
                          <div className="text-xs text-muted-foreground capitalize">
                            {(s.status || "").replace(/_/g, " ")}
                            {s.actualTotalCostCents ? ` - freight $${(s.actualTotalCostCents / 100).toFixed(2)}` : ""}
                            {s.lineCount ? ` - ${s.lineCount} line${s.lineCount === 1 ? "" : "s"}` : ""}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">{shipmentReceiveCoverageLabel(s).text}</div>
                          <ShipmentCustodyReceiptLinks coverage={s} />
                        </div>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            if (s.action === "open_existing_receipt" && s.existingReceiptId) {
                              sc.setShowReceivePicker(false);
                              navigate(procurementNavigation.childHref(`/receiving?open=${s.existingReceiptId}`));
                              return;
                            }
                            void sc.checkAndReceiveShipment({
                              shipmentId: s.shipmentId,
                              purchaseOrderId: s.purchaseOrderId,
                            });
                          }}
                        >
                          {sc.checkingShipmentReceiptPacks && sc.pendingShipmentReceipt?.shipmentId === s.shipmentId
                            ? "Checking..."
                            : s.action === "open_existing_receipt" ? "Open receipt" : "Receive this shipment"}
                        </Button>
                      </div>
                    ))}
                    {blockedShipments.map(renderBlockedShipment)}
                    <div data-testid="po-direct-receive-option" className="rounded-lg border p-3">
                      <div className="font-medium text-sm flex items-center gap-1.5">
                        <FileText className="h-4 w-4 text-muted-foreground" /> Receive against the PO directly
                      </div>
                      <div className="mt-1 flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {poDirect.warning}
                      </div>
                      <ShipmentCustodyReceiptLinks coverage={poDirect} />
                      <Button size="sm" variant="outline" className="mt-2" disabled={busy || !poDirect.allowed} onClick={() => sc.createReceiptMutation.mutate()}>
                        {poDirect.allowed && poDirect.blockedPurchaseOrderLineIds?.length ? "Receive eligible PO lines" : "Receive against PO anyway"}
                      </Button>
                      {!poDirect.allowed && poDirect.reason && (
                        <div className="mt-1 text-xs text-muted-foreground">{poDirect.reason}</div>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    {blockedShipments.map(renderBlockedShipment)}
                    <div data-testid="po-direct-receive-option" className="rounded-lg border p-3">
                      <div className="font-medium text-sm">Receive against the PO directly</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {poDirect.warning}
                      </div>
                      <ShipmentCustodyReceiptLinks coverage={poDirect} />
                      <Button size="sm" className="mt-2" disabled={busy || !poDirect.allowed} onClick={() => sc.createReceiptMutation.mutate()}>
                        {poDirect.allowed && poDirect.blockedPurchaseOrderLineIds?.length ? "Receive eligible PO lines" : "Receive against PO"}
                      </Button>
                      {!poDirect.allowed && poDirect.reason && (
                        <div className="mt-1 text-xs text-muted-foreground">{poDirect.reason}</div>
                      )}
                    </div>
                    <div className="text-center">
                      <Button size="sm" variant="ghost" onClick={() => { sc.setShowReceivePicker(false); sc.setShowCreateShipmentDialog(true); }}>
                        <Package className="h-3.5 w-3.5 mr-1.5" /> Create a shipment instead
                      </Button>
                    </div>
                  </>
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* ═══════ Create Shipment Dialog ═══════ */}
      <Dialog
        open={sc.showCreateShipmentDialog}
        onOpenChange={(open) => {
          sc.setShowCreateShipmentDialog(open);
          if (!open) { sc.setLineSelections({}); }
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto min-w-0 max-w-2xl relative">
          <DialogHeader>
            <DialogTitle>Create Inbound Shipment</DialogTitle>
            <DialogDescription>Set up shipment details and select PO lines to include in this shipment.</DialogDescription>
          </DialogHeader>
          <ShipmentCreateRecovery
            recovery={sc.shipmentCreation.recovery}
            error={sc.shipmentCreation.error}
            pending={sc.createShipmentMutation.isPending}
            onRetry={sc.recoverShipmentCreation}
            onRefresh={sc.shipmentCreation.refresh}
          />
          <fieldset
            disabled={sc.createShipmentMutation.isPending || !sc.shipmentCreation.ready || !!sc.shipmentCreation.recovery || !!sc.shipmentCreation.error}
            className="space-y-4 min-w-0"
          >
            {sc.shippableLinesLoading && <p role="status">Loading available purchase lines...</p>}
            {sc.shippableLinesError && (
              <div role="alert">
                Available purchase lines could not be loaded.{" "}
                <Button type="button" variant="outline" onClick={() => void sc.refetchShippableLines()}>Retry purchase lines</Button>
              </div>
            )}
            <div className="space-y-2">
              <Label>Shipment # (optional — auto-generated if blank)</Label>
              <Input
                value={sc.newShipmentForm.shipmentNumber}
                onChange={(e) => sc.setNewShipmentForm(prev => ({ ...prev, shipmentNumber: e.target.value }))}
                placeholder="e.g. SHP-2026-042"
                className="h-10"
              />
            </div>

            <div className="space-y-2">
              <Label>Mode *</Label>
              <Select value={sc.newShipmentForm.mode} onValueChange={(v) => sc.setNewShipmentForm(prev => ({ ...prev, mode: v }))}>
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sea_fcl">Sea — FCL</SelectItem>
                  <SelectItem value="sea_lcl">Sea — LCL</SelectItem>
                  <SelectItem value="air">Air</SelectItem>
                  <SelectItem value="ground">Ground</SelectItem>
                  <SelectItem value="ltl">LTL</SelectItem>
                  <SelectItem value="ftl">FTL</SelectItem>
                  <SelectItem value="courier">Courier</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Shipper (Origin Supplier) *</Label>
              {sc.vendorsLoading ? (
                <Button variant="outline" disabled className="w-full justify-between h-10 font-normal">
                  Loading vendors...
                </Button>
              ) : sc.vendorsError ? (
                <div className="space-y-1">
                  <Button variant="outline" disabled className="w-full justify-between h-10 font-normal text-destructive">
                    Error loading vendors
                  </Button>
                  <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => void sc.refetchVendors()}>Retry</Button>
                </div>
              ) : sc.vendors.length === 0 ? (
                <div className="space-y-1">
                  <Button variant="outline" disabled className="w-full justify-between h-10 font-normal">
                    No vendors found
                  </Button>
                  <a href="/vendors" className="text-xs text-primary hover:underline">Add a vendor first.</a>
                </div>
              ) : (
                <Popover open={sc.shipperOpen} onOpenChange={sc.setShipperOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      className="w-full justify-between h-10 font-normal"
                    >
                      <span className="truncate">
                        {sc.newShipmentForm.shipperName
                          ? sc.vendors.find(v => v.name === sc.newShipmentForm.shipperName)?.name || sc.newShipmentForm.shipperName
                          : "Select shipper..."}
                      </span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                    <Command shouldFilter={false}>
                      <CommandInput
                        placeholder="Search vendors..."
                        value={sc.shipperSearch}
                        onValueChange={sc.setShipperSearch}
                      />
                      <CommandList>
                        <CommandEmpty>No vendors found.</CommandEmpty>
                        <CommandGroup>
                          {sc.vendors
                            .filter(v => v.name.toLowerCase().includes(sc.shipperSearch.toLowerCase()))
                            .map(v => (
                              <CommandItem
                                key={v.id}
                                value={v.name}
                                onSelect={() => {
                                  sc.setNewShipmentForm(prev => ({ ...prev, shipperName: v.name }));
                                  sc.setShipperOpen(false);
                                  sc.setShipperSearch("");
                                }}
                              >
                                <Check className={`mr-2 h-4 w-4 ${sc.newShipmentForm.shipperName === v.name ? "opacity-100" : "opacity-0"}`} />
                                {v.name}
                              </CommandItem>
                            ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              )}
              <p className="text-xs text-muted-foreground">
                Don't see your supplier? <a href="/vendors" className="text-primary hover:underline">Add a vendor.</a>
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Forwarder</Label>
                <Input
                  value={sc.newShipmentForm.forwarderName}
                  onChange={(e) => sc.setNewShipmentForm(prev => ({ ...prev, forwarderName: e.target.value }))}
                  placeholder="e.g. Freightos"
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Carrier</Label>
                <Input
                  value={sc.newShipmentForm.carrierName}
                  onChange={(e) => sc.setNewShipmentForm(prev => ({ ...prev, carrierName: e.target.value }))}
                  placeholder="e.g. Maersk"
                  className="h-10"
                />
              </div>
            </div>

            {/* PO Lines Section */}
            <div className="space-y-2 pt-2 border-t">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-base">Lines from this PO</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Selected lines will be added to the new shipment. Adjust quantities or uncheck lines for partial shipments.
                  </p>
                </div>
                {sc.shippableLinesData?.lines && sc.shippableLinesData.lines.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7"
                    onClick={() => {
                      const allChecked = sc.shippableLinesData!.lines.every((l: any) => sc.lineSelections[l.id]?.checked);
                      const next: Record<number, { checked: boolean; quantity: ShipmentQuantityDraft }> = {};
                      for (const line of sc.shippableLinesData!.lines) {
                        const prev = sc.lineSelections[line.id];
                        next[line.id] = {
                          checked: !allChecked,
                          quantity: prev?.quantity ?? shipmentQuantityDraft(line.remainingQty, parseShipmentUnits(line.shipmentUnits)),
                        };
                      }
                      sc.setLineSelections(next);
                    }}
                  >
                    {sc.shippableLinesData.lines.every((l: any) => sc.lineSelections[l.id]?.checked) ? "Deselect all" : "Select all"}
                  </Button>
                )}
              </div>

              {Array.isArray(sc.shippableLinesData?.reviewRequiredLines) && sc.shippableLinesData.reviewRequiredLines.length > 0 && (
                <div role="alert" className="rounded border border-amber-500/50 p-3 text-sm space-y-1">
                  <p className="font-medium">Some purchase lines need source review before shipping</p>
                  {sc.shippableLinesData.reviewRequiredLines.map((line: { id: number; sku: string | null; error: string }) => (
                    <p key={line.id}>{line.sku ?? `PO line ${line.id}`}: {line.error}</p>
                  ))}
                </div>
              )}
              {sc.shippableLinesData?.lines && sc.shippableLinesData.lines.length > 0 ? (
                <div className="max-h-[50dvh] min-w-0 overflow-y-auto space-y-3">
                  {sc.shippableLinesData.lines.map((line) => {
                    const selected = sc.lineSelections[line.id] ?? {
                      checked: true,
                      quantity: shipmentQuantityDraft(line.remainingQty, parseShipmentUnits(line.shipmentUnits)),
                    };
                    return (
                      <div key={line.id} className="min-w-0 rounded border p-3 space-y-3">
                        <label className="flex gap-2 items-center text-sm font-medium">
                          <Checkbox
                            checked={selected.checked}
                            onCheckedChange={(checked) => sc.setLineSelections((previous) => ({
                              ...previous,
                              [line.id]: { ...selected, checked: !!checked },
                            }))}
                          />
                          <span className="break-all">{line.sku ?? `PO line ${line.id}`}</span>
                        </label>
                        <p className="text-xs text-muted-foreground">
                          {line.productName || line.description || "Product"} · Ordered {line.orderQty.toLocaleString("en-US")} pieces · Shipped {line.alreadyShippedQty.toLocaleString("en-US")} pieces
                        </p>
                        <ShipmentQuantityControl
                          id={`create-shipment-line-${line.id}`}
                          value={selected.quantity}
                          productName={line.productName ?? line.sku ?? "Product"}
                          units={parseShipmentUnits(line.shipmentUnits)}
                          maximumPieces={line.remainingQty}
                          disabled={!selected.checked}
                          onChange={(quantity) => sc.setLineSelections((previous) => ({
                            ...previous,
                            [line.id]: { ...selected, quantity },
                          }))}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : sc.showCreateShipmentDialog && sc.shippableLinesData ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No purchase lines are currently eligible to add. Review source warnings and existing shipments.
                </p>
              ) : null}
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => { sc.setShowCreateShipmentDialog(false); sc.setLineSelections({}); }}>Cancel</Button>
              <Button
                onClick={sc.submitShipmentCreation}
                disabled={
                  sc.createShipmentMutation.isPending ||
                  sc.shippableLinesLoading ||
                  sc.shippableLinesError ||
                  !sc.shippableLinesData ||
                  !Object.values(sc.lineSelections).some(selection => selection.checked) ||
                  !sc.newShipmentForm.shipperName.trim() ||
                  (sc.shippableLinesData !== undefined && sc.shippableLinesData.lines.length === 0) ||
                  sc.shippableLinesData?.lines.some((line) => sc.lineSelections[line.id]?.checked && shipmentQuantityPreview(sc.lineSelections[line.id].quantity, parseShipmentUnits(line.shipmentUnits), line.remainingQty).error !== null)
                }
              >
                {sc.createShipmentMutation.isPending ? "Creating..." : "Create Shipment"}
              </Button>
              {sc.shippableLinesData !== undefined && sc.shippableLinesData.lines.length === 0 && (
                <p className="text-xs text-muted-foreground absolute -bottom-5 right-0">No eligible lines available to add.</p>
              )}
            </div>
          </fieldset>
        </DialogContent>
      </Dialog>

      <ShipmentReceiptPackResolutionDialog
        open={!!sc.shipmentReceiptPackResolution}
        onOpenChange={(open) => {
          if (!open) sc.setShipmentReceiptPackResolution(null);
        }}
        resolution={sc.shipmentReceiptPackResolution}
        creating={sc.createReceiptFromShipmentMutation.isPending}
        refreshing={sc.checkingShipmentReceiptPacks}
        onCreateReceipt={sc.createPendingShipmentReceipt}
        onRefresh={sc.refreshShipmentReceiptPackResolution}
        onOpenCatalog={sc.openReceiptVariantSetup}
      />
    </>
  );
}
