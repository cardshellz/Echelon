import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import OpsKpiCards from "@/components/operations/OpsKpiCards";
import ActionQueueSection from "@/components/operations/ActionQueueSection";
import BinInventorySection from "@/components/operations/BinInventorySection";
import BinHistorySheet from "@/components/operations/BinHistorySheet";
import InlineTransferDialog from "@/components/operations/InlineTransferDialog";
import InlineAdjustDialog from "@/components/operations/InlineAdjustDialog";
import type { ActionFilter, ActionQueueCounts } from "@/components/operations/types";

interface OperationsViewProps {
  warehouseId: number | null;
  searchQuery: string;
}

export interface TransferDialogState {
  open: boolean;
  fromLocationId?: number;
  fromLocationCode?: string;
  toLocationId?: number;
  toLocationCode?: string;
  variantId?: number;
  sku?: string;
}

export interface AdjustDialogState {
  open: boolean;
  locationId?: number;
  locationCode?: string;
  variantId?: number;
  sku?: string;
  currentQty?: number;
}

export default function OperationsView({ warehouseId, searchQuery }: OperationsViewProps) {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("inventory", "edit");

  const [transferDialog, setTransferDialog] = useState<TransferDialogState>({ open: false });
  const [adjustDialog, setAdjustDialog] = useState<AdjustDialogState>({ open: false });

  // Action queue filter state
  const [activeFilter, setActiveFilter] = useState<ActionFilter>("all");
  const [queueCounts, setQueueCounts] = useState<ActionQueueCounts | undefined>();

  // Bin history sheet state
  const [historySheet, setHistorySheet] = useState<{ open: boolean; locationId: number | null; locationCode: string }>({
    open: false,
    locationId: null,
    locationCode: "",
  });

  const healthQuery = useQuery({
    queryKey: ["/api/operations/location-health", warehouseId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (warehouseId) params.set("warehouseId", warehouseId.toString());
      const res = await fetch(`/api/operations/location-health?${params}`);
      if (!res.ok) throw new Error("Failed to fetch location health");
      return res.json();
    },
    staleTime: 30_000,
  });

  // Helper: open transfer dialog with source pre-filled (standard flow)
  const openTransferFrom = (fromLocationId: number, fromLocationCode: string, variantId?: number, sku?: string) =>
    setTransferDialog({ open: true, fromLocationId, fromLocationCode, variantId, sku });

  // Helper: open transfer dialog with destination pre-filled (replen flow)
  const openTransferTo = (toLocationId: number, toLocationCode: string, variantId?: number, sku?: string) =>
    setTransferDialog({ open: true, toLocationId, toLocationCode, variantId, sku });

  const openAdjust = (locationId: number, locationCode: string, variantId: number, sku: string, currentQty: number) =>
    setAdjustDialog({ open: true, locationId, locationCode, variantId, sku, currentQty });

  return (
    <div className="space-y-6 flex-1 overflow-auto pb-6">
      {/* Top zone: KPI cards + action queue */}
      <OpsKpiCards
        healthData={healthQuery.data}
        queueCounts={queueCounts}
        isLoading={healthQuery.isLoading}
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
      />

      <ActionQueueSection
        warehouseId={warehouseId}
        activeFilter={activeFilter}
        searchQuery={searchQuery}
        canEdit={canEdit}
        onTransferFrom={openTransferFrom}
        onTransferTo={openTransferTo}
        onAdjust={openAdjust}
        onCountsLoaded={setQueueCounts}
      />

      <BinInventorySection
        warehouseId={warehouseId}
        searchQuery={searchQuery}
        canEdit={canEdit}
        onTransfer={openTransferFrom}
        onAdjust={openAdjust}
        onViewActivity={(locationId, locationCode) =>
          setHistorySheet({ open: true, locationId, locationCode })
        }
      />

      <BinHistorySheet
        open={historySheet.open}
        onOpenChange={(open) => setHistorySheet((prev) => ({ ...prev, open }))}
        locationId={historySheet.locationId}
        locationCode={historySheet.locationCode}
      />

      <InlineTransferDialog
        open={transferDialog.open}
        onOpenChange={(open) => setTransferDialog((prev) => ({ ...prev, open }))}
        defaultFromLocationId={transferDialog.fromLocationId}
        defaultFromLocationCode={transferDialog.fromLocationCode}
        defaultToLocationId={transferDialog.toLocationId}
        defaultToLocationCode={transferDialog.toLocationCode}
        defaultVariantId={transferDialog.variantId}
        defaultSku={transferDialog.sku}
      />

      <InlineAdjustDialog
        open={adjustDialog.open}
        onOpenChange={(open) => setAdjustDialog((prev) => ({ ...prev, open }))}
        locationId={adjustDialog.locationId}
        locationCode={adjustDialog.locationCode}
        variantId={adjustDialog.variantId}
        sku={adjustDialog.sku}
        currentQty={adjustDialog.currentQty}
      />
    </div>
  );
}
