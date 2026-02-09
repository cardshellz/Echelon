import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import OpsKpiCards from "@/components/operations/OpsKpiCards";
import ActionQueueSection from "@/components/operations/ActionQueueSection";
import BinInventorySection from "@/components/operations/BinInventorySection";
import SkuLocatorSection from "@/components/operations/SkuLocatorSection";
import RecentActivitySection from "@/components/operations/RecentActivitySection";
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

  // Activity panel state
  const [activityLocationId, setActivityLocationId] = useState<number | null>(null);
  const [activityVariantId, setActivityVariantId] = useState<number | null>(null);

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
        canEdit={canEdit}
        onTransferFrom={openTransferFrom}
        onTransferTo={openTransferTo}
        onAdjust={openAdjust}
        onCountsLoaded={setQueueCounts}
      />

      {/* Visual divider */}
      <div className="flex items-center gap-3 pt-2">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
          Inventory Tools
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>

      {/* Bottom zone: lookup tools */}
      <BinInventorySection
        warehouseId={warehouseId}
        searchQuery={searchQuery}
        canEdit={canEdit}
        onTransfer={openTransferFrom}
        onAdjust={openAdjust}
        onViewActivity={(locationId) => setActivityLocationId(locationId)}
      />

      <SkuLocatorSection
        canEdit={canEdit}
        onTransfer={openTransferFrom}
      />

      <RecentActivitySection
        locationId={activityLocationId}
        variantId={activityVariantId}
        onClearLocation={() => setActivityLocationId(null)}
        onClearVariant={() => setActivityVariantId(null)}
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
