import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TabsContent } from "@/components/ui/tabs";
import {
  createEmptyPoLinePricingDraft,
  evaluatePoLinePricingDraft,
  type PoLinePricingEditorDraft,
} from "@/features/po-edit/PoLinePricingEditor";
import { createStoredPoLinePricingDraft } from "@/features/po-edit/stored-po-line-pricing";
import {
  changedPoLineQuoteMetadata,
  createEmptyPoLineQuoteMetadataDraft,
  createPoLineQuoteMetadataDraftFromStored,
  evaluatePoLineQuoteMetadataDraft,
  populatedPoLineQuoteMetadata,
  reusableCatalogQuoteDateMissing,
  type PoLineQuoteMetadataDraft,
} from "@/features/po-edit/PoLineQuoteMetadataEditor";
import { PoLineShipmentLinks, PoLineShippingQuantity } from "@/features/purchasing/PoLineShipping";
import { PoLineLandedCost } from "@/features/purchasing/PoLineLandedCost";
import type { usePoShipmentCosts } from "@/features/purchasing/use-po-shipment-costs";
import type { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { useToast } from "@/hooks/use-toast";
import {
  createFinancialCommandIntentStore,
  financialCommandFetchJson,
  financialCommandRetryDelay,
  shouldRetryFinancialCommand,
} from "@/lib/financial-command";
import type { PurchaseLineShipping } from "@shared/procurement/purchase-line-shipping";
import { projectPoLineLandedCosts } from "@shared/procurement/po-line-landed-cost";
import { formatIntegerCents } from "@shared/utils/format-integer-cents";
import {
  type AddPoLineRequestBody,
  type CancelPoLineRequestBody,
  createEmptyNewLine,
  formatCents,
  formatLineUnitCost,
  formatStoredLineQuote,
  genPoLineIdempotencyKey,
  type PoLineHttpCommand,
  type UpdatePoLineRequestBody,
} from "./po-detail-types-and-helpers";

export function usePoLineEditing(params: {
  poId: number | null;
  po: any;
  canEditLine: (line: any) => boolean;
}) {
  const { poId, po, canEditLine } = params;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [addLineIntent] = useState(() =>
    createFinancialCommandIntentStore(genPoLineIdempotencyKey),
  );
  const [updateLineIntent] = useState(() =>
    createFinancialCommandIntentStore(genPoLineIdempotencyKey),
  );
  const [cancelLineIntent] = useState(() =>
    createFinancialCommandIntentStore(genPoLineIdempotencyKey),
  );

  const [showAddLineDialog, setShowAddLineDialog] = useState(false);

  // Inline line editing state
  const [editingLineId, setEditingLineId] = useState<number | null>(null);
  const [editingLineField, setEditingLineField] = useState<"sku" | null>(null);
  const [skuVariants, setSkuVariants] = useState<Array<{ id: number; sku: string; name: string; unitsPerVariant: number }>>([]);
  const [editingPricingLine, setEditingPricingLine] = useState<any | null>(null);
  const [editLinePricing, setEditLinePricing] = useState<PoLinePricingEditorDraft>(
    createEmptyPoLinePricingDraft,
  );
  const [editLineQuoteMetadata, setEditLineQuoteMetadata] = useState<PoLineQuoteMetadataDraft>(
    createEmptyPoLineQuoteMetadataDraft,
  );
  const [originalEditLineQuoteMetadata, setOriginalEditLineQuoteMetadata] = useState<PoLineQuoteMetadataDraft>(
    createEmptyPoLineQuoteMetadataDraft,
  );
  const [editRequiresLegacyConfirmation, setEditRequiresLegacyConfirmation] = useState(false);
  const [legacyPricingConfirmed, setLegacyPricingConfirmed] = useState(false);
  const [editSaveToVendorCatalog, setEditSaveToVendorCatalog] = useState(false);
  const [editSetAsPreferred, setEditSetAsPreferred] = useState(false);

  // Add line form
  const [productSearch, setProductSearch] = useState("");
  const [productOpen, setProductOpen] = useState(false);
  const [variantOpen, setVariantOpen] = useState(false);
  const [selectedProductForLine, setSelectedProductForLine] = useState<any>(null);
  const [linePricing, setLinePricing] = useState<PoLinePricingEditorDraft>(
    createEmptyPoLinePricingDraft,
  );
  const [lineQuoteMetadata, setLineQuoteMetadata] = useState<PoLineQuoteMetadataDraft>(
    createEmptyPoLineQuoteMetadataDraft,
  );
  const [saveToVendorCatalog, setSaveToVendorCatalog] = useState(true);
  const [setAsPreferred, setSetAsPreferred] = useState(false);
  const [addLineMode, setAddLineMode] = useState<"catalog" | "search">("catalog");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [selectedCatalogEntry, setSelectedCatalogEntry] = useState<any>(null);
  const [catalogPricingUntouched, setCatalogPricingUntouched] = useState(false);
  const [newLine, setNewLine] = useState(createEmptyNewLine);

  const { data: products = [] } = useQuery<any[]>({
    queryKey: ["/api/products"],
    enabled: showAddLineDialog,
  });

  const { data: vendorCatalog = [], isLoading: catalogLoading } = useQuery<any[]>({
    queryKey: [`/api/vendor-products`, po?.vendorId],
    queryFn: async () => {
      if (!po?.vendorId) return [];
      const res = await fetch(`/api/vendor-products?vendorId=${po.vendorId}&isActive=1`);
      const data = await res.json();
      return Array.isArray(data) ? data : (data.vendorProducts ?? []);
    },
    enabled: showAddLineDialog && !!po?.vendorId,
  });

  const filteredProducts = products
    .filter((p: any) =>
      !productSearch ||
      p.name?.toLowerCase().includes(productSearch.toLowerCase()) ||
      p.sku?.toLowerCase().includes(productSearch.toLowerCase())
    )
    .slice(0, 50);

  const selectedReceiveVariantId = newLine.expectedReceiveVariantId || newLine.productVariantId;
  const selectedVariant = selectedProductForLine?.variants?.find(
    (v: any) => v.id === selectedReceiveVariantId
  );
  const receiveUnitsPerVariant =
    newLine.expectedReceiveUnitsPerVariant || newLine.unitsPerUom || 1;
  const linePricingEvaluation = evaluatePoLinePricingDraft(linePricing);
  const editLinePricingEvaluation = evaluatePoLinePricingDraft(editLinePricing);
  const lineQuoteMetadataEvaluation = evaluatePoLineQuoteMetadataDraft(lineQuoteMetadata);
  const editLineQuoteMetadataEvaluation = evaluatePoLineQuoteMetadataDraft(editLineQuoteMetadata);
  const catalogQuoteDateMissing = reusableCatalogQuoteDateMissing(
    saveToVendorCatalog,
    linePricing.basis,
    lineQuoteMetadataEvaluation.metadata,
  );
  const editCatalogQuoteDateMissing = reusableCatalogQuoteDateMissing(
    editSaveToVendorCatalog,
    editLinePricing.basis,
    editLineQuoteMetadataEvaluation.metadata,
  );

  const addLineMutation = useMutation({
    mutationFn: ({ idempotencyKey, requestUrl, body }: PoLineHttpCommand<AddPoLineRequestBody>) =>
      financialCommandFetchJson(requestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      }),
    retry: shouldRetryFinancialCommand,
    retryDelay: financialCommandRetryDelay,
    onSuccess: (_result, command) => {
      addLineIntent.complete(command.idempotencyKey);
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      if (command.body.catalogWrite) {
        queryClient.invalidateQueries({ queryKey: ["/api/vendor-products"] });
      }
      setShowAddLineDialog(false);
      setNewLine(createEmptyNewLine());
      setProductSearch("");
      setSelectedProductForLine(null);
      setLinePricing(createEmptyPoLinePricingDraft());
      setLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
      setSaveToVendorCatalog(true);
      setSetAsPreferred(false);
      setCatalogSearch("");
      setSelectedCatalogEntry(null);
      setCatalogPricingUntouched(false);
      toast({ title: "Line added" });
    },
    onError: (err: Error, command) => {
      addLineIntent.fail(command.idempotencyKey, err);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteLineMutation = useMutation({
    mutationFn: ({ idempotencyKey, requestUrl, body }: PoLineHttpCommand<CancelPoLineRequestBody>) =>
      financialCommandFetchJson(requestUrl, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      }),
    retry: shouldRetryFinancialCommand,
    retryDelay: financialCommandRetryDelay,
    onSuccess: (_result, command) => {
      cancelLineIntent.complete(command.idempotencyKey);
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      toast({ title: "Line removed" });
    },
    onError: (err: Error, command) => {
      cancelLineIntent.fail(command.idempotencyKey, err);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateLineMutation = useMutation({
    mutationFn: ({ idempotencyKey, requestUrl, body }: PoLineHttpCommand<UpdatePoLineRequestBody>) =>
      financialCommandFetchJson(requestUrl, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      }),
    retry: shouldRetryFinancialCommand,
    retryDelay: financialCommandRetryDelay,
    onSuccess: (_result, command) => {
      updateLineIntent.complete(command.idempotencyKey);
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      if (command.body.catalogWrite) {
        queryClient.invalidateQueries({ queryKey: ["/api/vendor-products"] });
      }
      setEditingLineId(null);
      setEditingLineField(null);
      setSkuVariants([]);
      setEditingPricingLine(null);
      setEditLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
      setOriginalEditLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
      setEditRequiresLegacyConfirmation(false);
      setLegacyPricingConfirmed(false);
      setEditSaveToVendorCatalog(false);
      setEditSetAsPreferred(false);
      toast({ title: "Line updated" });
    },
    onError: (err: Error, command) => {
      updateLineIntent.fail(command.idempotencyKey, err);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function submitLineUpdate(line: any, updates: Record<string, unknown>) {
    if (!po?.updatedAt || !line?.updatedAt) {
      toast({
        title: "Error",
        description: "The PO or line version is unavailable. Reload before editing this line.",
        variant: "destructive",
      });
      return;
    }
    const requestUrl = `/api/purchase-orders/lines/${line.id}`;
    const body: UpdatePoLineRequestBody = {
      ...updates,
      expectedPoUpdatedAt: po.updatedAt,
      expectedLineUpdatedAt: line.updatedAt,
    };
    const idempotencyKey = updateLineIntent.acquire({ method: "PATCH", requestUrl, body });
    updateLineMutation.mutate({ idempotencyKey, requestUrl, body });
  }

  function submitLineCancellation(line: any) {
    if (!po?.updatedAt || !line?.updatedAt) {
      toast({
        title: "Error",
        description: "The PO or line version is unavailable. Reload before removing this line.",
        variant: "destructive",
      });
      return;
    }
    const requestUrl = `/api/purchase-orders/lines/${line.id}`;
    const body: CancelPoLineRequestBody = {
      expectedPoUpdatedAt: po.updatedAt,
      expectedLineUpdatedAt: line.updatedAt,
      reason: "Removed from draft purchase order",
    };
    const idempotencyKey = cancelLineIntent.acquire({ method: "DELETE", requestUrl, body });
    deleteLineMutation.mutate({ idempotencyKey, requestUrl, body });
  }

  function startPricingEdit(line: any) {
    if (!canEditLine(line)) return;
    const stored = createStoredPoLinePricingDraft(line);
    setEditingPricingLine(line);
    setEditLinePricing(stored.draft);
    const storedMetadata = createPoLineQuoteMetadataDraftFromStored(line);
    setEditLineQuoteMetadata(storedMetadata);
    setOriginalEditLineQuoteMetadata(storedMetadata);
    setEditRequiresLegacyConfirmation(stored.requiresLegacyConfirmation);
    setLegacyPricingConfirmed(false);
    setEditSaveToVendorCatalog(false);
    setEditSetAsPreferred(false);
  }

  async function startSkuEdit(line: any) {
    if (!canEditLine(line)) return;
    setEditingLineId(line.id);
    setEditingLineField("sku");
    try {
      const res = await fetch(`/api/products/${line.productId}`);
      if (res.ok) {
        const data = await res.json();
        setSkuVariants(data.variants || []);
      }
    } catch { /* ignore */ }
  }

  function saveSkuEdit(line: any, variant: { id: number; sku: string; unitsPerVariant: number }) {
    if (!canEditLine(line)) return;
    submitLineUpdate(line, {
      expectedReceiveVariantId: variant.id,
      expectedReceiveUnitsPerVariant: variant.unitsPerVariant || 1,
    });
  }

  function savePricingEdit() {
    if (!editingPricingLine || !canEditLine(editingPricingLine)) return;
    const evaluation = evaluatePoLinePricingDraft(editLinePricing);
    const metadataEvaluation = evaluatePoLineQuoteMetadataDraft(editLineQuoteMetadata);
    if (!evaluation.pricing) {
      toast({
        title: "Invalid vendor quote",
        description: evaluation.error ?? "Enter a complete vendor quote.",
        variant: "destructive",
      });
      return;
    }
    if (!metadataEvaluation.metadata) {
      toast({
        title: "Invalid quote details",
        description: metadataEvaluation.error ?? "Enter valid quote details.",
        variant: "destructive",
      });
      return;
    }
    if (editRequiresLegacyConfirmation && !legacyPricingConfirmed) {
      toast({
        title: "Confirm the quote basis",
        description: "This legacy line has no stored vendor quote basis. Confirm the quote before saving.",
        variant: "destructive",
      });
      return;
    }
    if (editCatalogQuoteDateMissing) {
      toast({
        title: "Quote date required",
        description: "Enter the supplier quote date or turn off the supplier-price update.",
        variant: "destructive",
      });
      return;
    }
    submitLineUpdate(editingPricingLine, {
      pricing: evaluation.pricing,
      pricingSource: "manual",
      ...changedPoLineQuoteMetadata(
        originalEditLineQuoteMetadata,
        editLineQuoteMetadata,
        metadataEvaluation.metadata,
      ),
      ...(editSaveToVendorCatalog && evaluation.pricing.basis !== "extended_total"
        ? {
            catalogWrite: {
              mode: "upsert" as const,
              setPreferred: editSetAsPreferred,
            },
            quotedAt: metadataEvaluation.metadata.quotedAt,
          }
        : {}),
    });
  }

  function cancelLineEdit() {
    setEditingLineId(null);
    setEditingLineField(null);
    setSkuVariants([]);
  }

  function closePricingEdit() {
    setEditingPricingLine(null);
    setEditLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
    setOriginalEditLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
    setEditRequiresLegacyConfirmation(false);
    setLegacyPricingConfirmed(false);
    setEditSaveToVendorCatalog(false);
    setEditSetAsPreferred(false);
  }

  function submitAddLine() {
    const pricing = linePricingEvaluation.pricing;
    const quoteMetadata = lineQuoteMetadataEvaluation.metadata;
    if (!pricing || !quoteMetadata || !po?.updatedAt || catalogQuoteDateMissing) return;
    const requestUrl = `/api/purchase-orders/${poId}/lines`;
    const pricingSource = selectedCatalogEntry && catalogPricingUntouched
      ? "vendor_catalog" as const
      : "manual" as const;
    const body: AddPoLineRequestBody = {
      productId: newLine.productId,
      expectedReceiveVariantId: selectedReceiveVariantId,
      expectedReceiveUnitsPerVariant: receiveUnitsPerVariant,
      vendorProductId: selectedCatalogEntry?.id,
      vendorSku: newLine.vendorSku || undefined,
      description: newLine.description || undefined,
      pricingSource,
      pricing,
      ...populatedPoLineQuoteMetadata(quoteMetadata),
      ...(saveToVendorCatalog &&
        pricingSource === "manual" &&
        pricing.basis !== "extended_total"
        ? {
            catalogWrite: {
              mode: "upsert" as const,
              setPreferred: setAsPreferred,
            },
          }
        : {}),
      expectedPoUpdatedAt: po.updatedAt,
    };
    const idempotencyKey = addLineIntent.acquire({
      method: "POST",
      requestUrl,
      body,
    });
    addLineMutation.mutate({ idempotencyKey, requestUrl, body });
  }

  return {
    showAddLineDialog,
    setShowAddLineDialog,
    editingLineId,
    editingLineField,
    skuVariants,
    editingPricingLine,
    editLinePricing,
    setEditLinePricing,
    editLineQuoteMetadata,
    setEditLineQuoteMetadata,
    editRequiresLegacyConfirmation,
    legacyPricingConfirmed,
    setLegacyPricingConfirmed,
    editSaveToVendorCatalog,
    setEditSaveToVendorCatalog,
    editSetAsPreferred,
    setEditSetAsPreferred,
    productSearch,
    setProductSearch,
    productOpen,
    setProductOpen,
    variantOpen,
    setVariantOpen,
    selectedProductForLine,
    setSelectedProductForLine,
    linePricing,
    setLinePricing,
    lineQuoteMetadata,
    setLineQuoteMetadata,
    saveToVendorCatalog,
    setSaveToVendorCatalog,
    setAsPreferred,
    setSetAsPreferred,
    addLineMode,
    setAddLineMode,
    catalogSearch,
    setCatalogSearch,
    selectedCatalogEntry,
    setSelectedCatalogEntry,
    catalogPricingUntouched,
    setCatalogPricingUntouched,
    newLine,
    setNewLine,
    products,
    vendorCatalog,
    catalogLoading,
    filteredProducts,
    selectedReceiveVariantId,
    selectedVariant,
    receiveUnitsPerVariant,
    linePricingEvaluation,
    editLinePricingEvaluation,
    lineQuoteMetadataEvaluation,
    editLineQuoteMetadataEvaluation,
    catalogQuoteDateMissing,
    editCatalogQuoteDateMissing,
    addLineMutation,
    deleteLineMutation,
    updateLineMutation,
    submitLineCancellation,
    startPricingEdit,
    startSkuEdit,
    saveSkuEdit,
    savePricingEdit,
    cancelLineEdit,
    closePricingEdit,
    submitAddLine,
  };
}

export type PoLineEditingController = ReturnType<typeof usePoLineEditing>;

export function PoLinesTab(props: {
  po: any;
  lines: any[];
  canEditLines: boolean;
  canEditLine: (line: any) => boolean;
  lineEditing: PoLineEditingController;
  relationshipsError: boolean;
  relationshipsPending: boolean;
  onRefetchRelationships: () => void;
  shippingByLine: Map<number, PurchaseLineShipping>;
  shipmentCosts: ReturnType<typeof usePoShipmentCosts>;
  onRefetchPo: () => Promise<unknown>;
  procurementNavigation: ReturnType<typeof useProcurementNavigation>;
}) {
  const {
    po,
    lines,
    canEditLines,
    canEditLine,
    lineEditing,
    relationshipsError,
    relationshipsPending,
    onRefetchRelationships,
    shippingByLine,
    shipmentCosts,
    onRefetchPo,
    procurementNavigation,
  } = props;

  const landedCosts = projectPoLineLandedCosts({ poHeader: po, poLines: lines, costs: shipmentCosts.data });
  const landedCostByLine = new Map(
    landedCosts.status === "complete"
      ? landedCosts.lines.map(line => [line.purchaseOrderLineId, line])
      : [],
  );
  const landedCurrency = shipmentCosts.data?.summary.currency ?? po?.currency ?? "USD";

  return (
    <TabsContent value="lines" className="@container/po-lines space-y-4">
      {lines.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Quantities are pieces. Shipped counts departed shipments. Still to ship excludes cancellations and includes planned shipments. Received is the posted receipt count.
        </p>
      )}
      {relationshipsError && (
        <div role="alert" className="rounded-md border border-destructive p-3 text-sm">
          <p>Shipment progress could not be loaded. Shipped and still-to-ship quantities are unavailable.</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={onRefetchRelationships}>Retry shipment progress</Button>
        </div>
      )}
      {lines.length > 0 && (
        <div className="text-xs text-muted-foreground" role="status">
          {landedCosts.status === "complete"
            ? (
              <>
                Landed costs include the supplier line amount and its allocated shipment charges. Per-piece rates are rounded; line totals keep exact cents.
                {landedCosts.poLevelAdjustmentCents !== 0 && (
                  <> PO-level charges or discounts of {formatIntegerCents(landedCosts.poLevelAdjustmentCents, landedCurrency)} are included in the PO total, separately from these lines.</>
                )}
              </>
            )
            : shipmentCosts.isPending ? "Loading landed costs…" : landedCosts.reason}
          {landedCosts.status === "unavailable" && !shipmentCosts.isPending && (
            <Button variant="outline" size="sm" className="ml-2" onClick={() => void Promise.all([onRefetchPo(), shipmentCosts.refetch()])}>
              Reload costs
            </Button>
          )}
        </div>
      )}
      {canEditLines && (
        <Button variant="outline" onClick={() => lineEditing.setShowAddLineDialog(true)} className="min-h-[44px]">
          <Plus className="h-4 w-4 mr-2" />
          Add Line
        </Button>
      )}

      {/* Mobile cards */}
      <div className="@4xl/po-lines:hidden space-y-3">
        {lines.length === 0 ? (
          <Card>
            <CardContent className="p-4 text-center text-muted-foreground">
              No lines. {canEditLines ? "Add items to this PO." : ""}
            </CardContent>
          </Card>
        ) : (
          lines.map((line: any) => {
            const canEditThisLine = canEditLine(line);
            const isEditingSkuMobile = canEditThisLine && lineEditing.editingLineId === line.id && lineEditing.editingLineField === "sku";
            const shipping = shippingByLine.get(line.id);
            const orderedPieces = shipping?.line.orderedPieces ?? line.orderQty ?? 0;
            const receivedPieces = shipping?.line.receivedPieces ?? line.receivedQty ?? 0;
            return (
              <Card
                key={line.id}
                data-testid={`po-line-${line.id}`}
                className={shippingByLine.get(line.id)?.shipments.some(shipment => shipment.shipmentLineId === procurementNavigation.record?.relationship?.line) ? "border-primary" : undefined}
              >
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      {isEditingSkuMobile ? (
                        <div className="space-y-1 mb-2">
                          {lineEditing.skuVariants.length === 0 ? (
                            <span className="text-xs text-muted-foreground">Loading...</span>
                          ) : (
                            lineEditing.skuVariants.map((v) => (
                              <div
                                key={v.id}
                                className={`text-xs px-2 py-1 rounded cursor-pointer hover:bg-muted ${v.id === (line.expectedReceiveVariantId ?? line.productVariantId) ? "bg-muted font-bold" : ""}`}
                                onClick={() => {
                                  if (v.id !== (line.expectedReceiveVariantId ?? line.productVariantId)) {
                                    lineEditing.saveSkuEdit(line, v);
                                  } else {
                                    lineEditing.cancelLineEdit();
                                  }
                                }}
                              >
                                {v.sku} — {v.name} ({v.unitsPerVariant}pc)
                              </div>
                            ))
                          )}
                          <Button variant="ghost" size="sm" className="h-6 text-xs w-full" onClick={lineEditing.cancelLineEdit}>Cancel</Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span
                            className={`font-mono text-sm ${canEditThisLine ? "cursor-pointer underline decoration-dotted" : ""}`}
                            onClick={() => canEditThisLine && void lineEditing.startSkuEdit(line)}
                          >
                            {line.sku || "—"}
                          </span>
                          <Badge variant="outline" className="text-xs">{line.status}</Badge>
                        </div>
                      )}
                      <div className="text-sm mt-1 truncate">{line.productName || "—"}</div>
                      <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
                        <span
                          className={canEditThisLine ? "cursor-pointer underline decoration-dotted" : ""}
                          onClick={() => canEditThisLine && lineEditing.startPricingEdit(line)}
                          title={canEditThisLine ? "Edit vendor quote and quantity" : undefined}
                        >
                          Ordered: {orderedPieces.toLocaleString()} pcs
                        </span>
                        <span
                          className={canEditThisLine ? "cursor-pointer underline decoration-dotted" : ""}
                          onClick={() => canEditThisLine && lineEditing.startPricingEdit(line)}
                          title={canEditThisLine ? "Edit vendor quote and quantity" : undefined}
                        >
                          Product {formatLineUnitCost(line)}/pc
                        </span>
                        <span className="font-medium">Supplier {formatCents(line.lineTotalCents)}</span>
                      </div>
                      {(!line.lineType || line.lineType === "product") && (
                        <>
                          <dl className="grid grid-cols-3 gap-2 my-3 text-sm" aria-label="Shipment progress">
                            <div>
                              <dt className="text-xs text-muted-foreground">Shipped</dt>
                              <dd data-testid="shipped-pieces"><PoLineShippingQuantity progress={shippingByLine.get(line.id)} kind="shipped" loading={relationshipsPending} /></dd>
                            </div>
                            <div>
                              <dt className="text-xs text-muted-foreground">Still to ship</dt>
                              <dd data-testid="remaining-pieces"><PoLineShippingQuantity progress={shippingByLine.get(line.id)} kind="remaining" loading={relationshipsPending} /></dd>
                            </div>
                            <div>
                              <dt className="text-xs text-muted-foreground">Received</dt>
                              <dd data-testid="received-pieces" className="tabular-nums">{receivedPieces.toLocaleString()}</dd>
                            </div>
                          </dl>
                          <PoLineShipmentLinks progress={shippingByLine.get(line.id)} loading={relationshipsPending} navigation={procurementNavigation} poNumber={po.poNumber} />
                        </>
                      )}
                      {formatStoredLineQuote(line) && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          Vendor quote: {formatStoredLineQuote(line)}
                        </div>
                      )}
                      <div className="mt-2 text-sm">
                        <span className="text-xs text-muted-foreground">Total landed cost</span>
                        <PoLineLandedCost line={landedCostByLine.get(line.id)} currency={landedCurrency} kind="total" supplierCents={line.lineTotalCents} />
                        <PoLineLandedCost line={landedCostByLine.get(line.id)} currency={landedCurrency} kind="unit" />
                      </div>
                    </div>
                    {canEditThisLine && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-[44px] min-w-[44px] p-0"
                        onClick={() => {
                          if (confirm("Remove this line?")) {
                            lineEditing.submitLineCancellation(line);
                          }
                        }}
                        disabled={lineEditing.deleteLineMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {/* Desktop table */}
      <Card className="hidden @4xl/po-lines:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Product / SKU</TableHead>
              <TableHead className="text-right">Ordered</TableHead>
              <TableHead className="text-right">Shipped</TableHead>
              <TableHead className="text-right">Still to ship</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead>Shipments</TableHead>
              <TableHead className="text-right">Cost / piece</TableHead>
              <TableHead className="text-right">Total landed cost</TableHead>
              {canEditLines && <TableHead className="w-12"></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.length === 0 ? (
              <TableRow>
                <TableCell colSpan={canEditLines ? 10 : 9} className="text-center text-muted-foreground py-8">
                  No lines. {canEditLines ? "Click \"Add Line\" to add items." : ""}
                </TableCell>
              </TableRow>
            ) : (
              lines.map((line: any) => {
                const canEditThisLine = canEditLine(line);
                const isEditingSku = canEditThisLine && lineEditing.editingLineId === line.id && lineEditing.editingLineField === "sku";
                const shipping = shippingByLine.get(line.id);
                const orderedPieces = shipping?.line.orderedPieces ?? line.orderQty ?? 0;
                const receivedPieces = shipping?.line.receivedPieces ?? line.receivedQty ?? 0;
                return (
                  <TableRow
                    key={line.id}
                    data-testid={`po-line-${line.id}`}
                    className={shippingByLine.get(line.id)?.shipments.some(shipment => shipment.shipmentLineId === procurementNavigation.record?.relationship?.line) ? "bg-primary/5" : undefined}
                  >
                    <TableCell className="text-muted-foreground">{line.lineNumber}</TableCell>
                    <TableCell className="max-w-[200px]">
                      {isEditingSku ? (
                        <div className="space-y-1">
                          {lineEditing.skuVariants.length === 0 ? (
                            <span className="text-xs text-muted-foreground">Loading...</span>
                          ) : (
                            lineEditing.skuVariants.map((v) => (
                              <div
                                key={v.id}
                                className={`text-xs px-2 py-1 rounded cursor-pointer hover:bg-muted ${v.id === (line.expectedReceiveVariantId ?? line.productVariantId) ? "bg-muted font-bold" : ""}`}
                                onClick={() => {
                                  if (v.id !== (line.expectedReceiveVariantId ?? line.productVariantId)) {
                                    lineEditing.saveSkuEdit(line, v);
                                  } else {
                                    lineEditing.cancelLineEdit();
                                  }
                                }}
                              >
                                {v.sku} — {v.name} ({v.unitsPerVariant}pc)
                              </div>
                            ))
                          )}
                          <Button variant="ghost" size="sm" className="h-6 text-xs w-full" onClick={lineEditing.cancelLineEdit}>Cancel</Button>
                        </div>
                      ) : (
                        <span
                          className={`font-mono text-xs ${canEditThisLine ? "cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1" : ""}`}
                          onClick={() => canEditThisLine && void lineEditing.startSkuEdit(line)}
                        >
                          {line.sku || "—"}
                        </span>
                      )}
                      <p className="truncate" title={line.productName}>{line.productName || "—"}</p>
                      {line.vendorSku && <p className="text-xs text-muted-foreground truncate" title={line.vendorSku}>Vendor SKU: {line.vendorSku}</p>}
                      <Badge variant="outline" className="text-xs mt-1">{line.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <span
                        className={canEditThisLine ? "cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1" : ""}
                        onClick={() => canEditThisLine && lineEditing.startPricingEdit(line)}
                        title={canEditThisLine ? "Edit vendor quote and quantity" : undefined}
                      >
                        {(line.expectedReceiveUnitsPerVariant || line.unitsPerUom || 1) > 1
                          ? (
                            <>
                              {orderedPieces.toLocaleString()} pcs<br />
                              <span className="text-xs text-muted-foreground">({Math.ceil(orderedPieces / (line.expectedReceiveUnitsPerVariant || line.unitsPerUom || 1))} expected)</span>
                            </>
                          )
                          : orderedPieces.toLocaleString()}
                      </span>
                    </TableCell>
                    <TableCell className="text-right" data-testid="shipped-pieces">
                      {(!line.lineType || line.lineType === "product") ? <PoLineShippingQuantity progress={shippingByLine.get(line.id)} kind="shipped" loading={relationshipsPending} /> : "—"}
                    </TableCell>
                    <TableCell className="text-right" data-testid="remaining-pieces">
                      {(!line.lineType || line.lineType === "product") ? <PoLineShippingQuantity progress={shippingByLine.get(line.id)} kind="remaining" loading={relationshipsPending} /> : "—"}
                    </TableCell>
                    <TableCell className="text-right" data-testid="received-pieces">
                      {(line.expectedReceiveUnitsPerVariant || line.unitsPerUom || 1) > 1
                        ? (
                          <span>
                            {receivedPieces.toLocaleString()} pcs<br />
                            <span className="text-xs text-muted-foreground">({Math.ceil(receivedPieces / (line.expectedReceiveUnitsPerVariant || line.unitsPerUom || 1))} expected)</span>
                          </span>
                        )
                        : receivedPieces.toLocaleString()}
                      {(line.damagedQty || 0) > 0 && (
                        <span className="text-red-500 ml-1">({line.damagedQty} dmg)</span>
                      )}
                    </TableCell>
                    <TableCell className="min-w-[170px] max-w-[240px]">
                      {(!line.lineType || line.lineType === "product") ? <PoLineShipmentLinks progress={shippingByLine.get(line.id)} loading={relationshipsPending} navigation={procurementNavigation} poNumber={po.poNumber} /> : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      <span
                        className={canEditThisLine ? "cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1" : ""}
                        onClick={() => canEditThisLine && lineEditing.startPricingEdit(line)}
                        title={canEditThisLine ? "Edit vendor quote and quantity" : undefined}
                      >
                        <span className="font-sans text-xs text-muted-foreground">Product </span>{formatLineUnitCost(line)}
                      </span>
                      {formatStoredLineQuote(line) && (
                        <div className="text-[11px] font-sans text-muted-foreground">
                          {formatStoredLineQuote(line)}
                        </div>
                      )}
                      <PoLineLandedCost line={landedCostByLine.get(line.id)} currency={landedCurrency} kind="unit" />
                    </TableCell>
                    <TableCell className="text-right">
                      <PoLineLandedCost line={landedCostByLine.get(line.id)} currency={landedCurrency} kind="total" supplierCents={line.lineTotalCents} />
                    </TableCell>
                    {canEditThisLine && (
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (confirm("Remove this line?")) {
                              lineEditing.submitLineCancellation(line);
                            }
                          }}
                          disabled={lineEditing.deleteLineMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
    </TabsContent>
  );
}
