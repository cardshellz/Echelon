import React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Edit3,
  Focus,
  List,
  MapPin,
  Minus,
  MoreVertical,
  Package,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Scan,
  Unlock,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import AssemblyHandoffPanel from "@/pages/warehouse-work/AssemblyHandoffPanel";
import { cn } from "@/lib/utils";
import { ReplenPredictionBadge } from "./PickingBadges";
import type {
  OrderWithItems,
  PickBatch,
  PickItem,
  SingleOrder,
} from "./picking-types-and-helpers";

export interface PickingActiveItemViewProps {
  hiddenScannerRef: React.RefObject<HTMLInputElement | null>;
  manualInputRef: React.RefObject<HTMLInputElement | null>;
  itemRefs: React.MutableRefObject<Map<number, HTMLDivElement>>;
  processScanRef: React.MutableRefObject<(value: string) => void>;
  scanInput: string;
  setScanInput: React.Dispatch<React.SetStateAction<string>>;
  scanStatus: "idle" | "success" | "error";
  handleBackToQueue: () => void;
  pickingMode: "batch" | "single";
  activeOrderId: string | null;
  canReleaseOrder: (id: string) => boolean;
  handleReleaseOrder: (id: string) => void;
  releaseMutation: { isPending: boolean };
  pickerViewMode: "focus" | "list";
  setPickerViewMode: (mode: "focus" | "list") => void;
  soundEnabled: boolean;
  setSoundSettingsOpen: (open: boolean) => void;
  activeWork: PickBatch | SingleOrder | undefined;
  activeOrder: SingleOrder | undefined;
  completedItems: number;
  totalItems: number;
  progressPercent: number;
  hasPermission: (resource: any, action: any) => boolean;
  getSubOrderIds: (id: string) => number[];
  onAssemblyHandedOff: (ticket: string, station: string) => Promise<void>;
  currentItem: PickItem | undefined;
  currentItemIndex: number;
  openAllocationDialog: (itemIndex: number | null) => void;
  replenBins: Record<string, { locationCode: string }>;
  canViewReplenTasks: boolean;
  handleScan: (value: string) => void;
  processFocusedScan: (value: string) => void;
  setMultiQtyOpen: (open: boolean) => void;
  confirmPick: (qty: number) => void;
  checkReplenGuidance: (item: PickItem, listIndex: number | null) => void;
  replenGuidanceLoading: boolean;
  canManageHolds: boolean;
  releaseLineHoldMutation: {
    mutate: (vars: { wmsOrderId: number; itemId: number }) => void;
    isPending: boolean;
  };
  holdLineItemMutation: {
    isPending: boolean;
  };
  openHoldLine: (item: PickItem | null | undefined) => void;
  handleScanKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  debugLog: string[];
  lastScannedItemId: number | null;
  openEditQtyDialog: (idx: number) => void;
  handleListItemManualPickOne: (idx: number) => void;
  handleListItemPick: (idx: number) => void;
  handleListItemShort: (idx: number) => void;
  handleListItemDecrement: (idx: number) => void;
  updateItemMutation: { isPending: boolean };
  unpickItemMutation: { isPending: boolean };
  onCompleteAll: () => void;
  children?: React.ReactNode;
}

export function PickingActiveItemView({
  hiddenScannerRef,
  manualInputRef,
  itemRefs,
  processScanRef,
  scanInput,
  setScanInput,
  scanStatus,
  handleBackToQueue,
  pickingMode,
  activeOrderId,
  canReleaseOrder,
  handleReleaseOrder,
  releaseMutation,
  pickerViewMode,
  setPickerViewMode,
  soundEnabled,
  setSoundSettingsOpen,
  activeWork,
  activeOrder,
  completedItems,
  totalItems,
  progressPercent,
  hasPermission,
  getSubOrderIds,
  onAssemblyHandedOff,
  currentItem,
  currentItemIndex,
  openAllocationDialog,
  replenBins,
  canViewReplenTasks,
  handleScan,
  processFocusedScan,
  setMultiQtyOpen,
  confirmPick,
  checkReplenGuidance,
  replenGuidanceLoading,
  canManageHolds,
  releaseLineHoldMutation,
  holdLineItemMutation,
  openHoldLine,
  handleScanKeyDown,
  debugLog,
  lastScannedItemId,
  openEditQtyDialog,
  handleListItemManualPickOne,
  handleListItemPick,
  handleListItemShort,
  handleListItemDecrement,
  updateItemMutation,
  unpickItemMutation,
  onCompleteAll,
  children,
}: PickingActiveItemViewProps) {
  return (
    <div className="flex flex-col min-h-full bg-muted/20 overflow-auto select-none">
      {/* Hidden scanner sink - captures hardware barcode scans reliably without software keyboard */}
      <input
        ref={hiddenScannerRef}
        className="opacity-0 absolute -z-10"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const val = e.currentTarget.value.trim();
            if (val && processScanRef.current) {
              setScanInput(val);
              setTimeout(() => {
                processScanRef.current(val);
                setScanInput("");
              }, 10);
            }
            e.currentTarget.value = "";
          }
        }}
        autoComplete="off"
        tabIndex={-1}
        aria-hidden="true"
      />
      {/* Compact Header */}
      <div className="bg-card border-b p-3 md:p-4 sticky top-0 z-10">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={handleBackToQueue} className="text-muted-foreground h-8 px-2">
              <ChevronRight className="h-4 w-4 rotate-180" /> Exit
            </Button>
            {pickingMode === "single" && activeOrderId && canReleaseOrder(activeOrderId) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleReleaseOrder(activeOrderId)}
                className="text-amber-600 hover:text-amber-700 hover:bg-amber-50 h-8 px-2"
                title="End the picking assignment. Pick progress and holds are preserved."
                data-testid="button-release-active-order"
                disabled={releaseMutation.isPending}
              >
                <Unlock className="h-4 w-4 mr-1" /> Release picking assignment
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* View Mode Toggle */}
            <div className="flex items-center border rounded-lg overflow-hidden h-8">
              <Button
                variant={pickerViewMode === "focus" ? "default" : "ghost"}
                size="sm"
                onClick={() => setPickerViewMode("focus")}
                className={cn(
                  "h-8 px-2 rounded-none",
                  pickerViewMode === "focus" && "bg-primary text-primary-foreground",
                )}
                title="Focus View"
                data-testid="button-focus-view"
              >
                <Focus className="h-4 w-4" />
              </Button>
              <Button
                variant={pickerViewMode === "list" ? "default" : "ghost"}
                size="sm"
                onClick={() => setPickerViewMode("list")}
                className={cn(
                  "h-8 px-2 rounded-none",
                  pickerViewMode === "list" && "bg-primary text-primary-foreground",
                )}
                title="List View"
                data-testid="button-list-view"
              >
                <List className="h-4 w-4" />
              </Button>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSoundSettingsOpen(true)}
              className="h-8 w-8"
              title="Sound & Haptic Settings"
            >
              {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </Button>
            {/* Priority badge only - order # shown below */}
            {activeWork?.priority !== undefined && activeWork.priority >= 300 && (
              <Badge
                variant={activeWork.priority >= 9999 ? "destructive" : "outline"}
                className={cn(
                  "text-xs px-2 py-0.5",
                  activeWork.priority >= 9999 && "border-red-300 bg-red-50 text-red-700",
                  activeWork.priority >= 300 && activeWork.priority < 9999 && "border-orange-300 bg-orange-50 text-orange-700",
                )}
              >
                {activeWork.priority >= 9999 ? "🔼 BUMPED" : `P${activeWork.priority}`}
              </Badge>
            )}
          </div>
        </div>

        {/* Order Number - Prominent */}
        <div className="text-center py-1">
          <span className="text-2xl font-bold text-primary">
            {pickingMode === "single" && activeOrder ? activeOrder.orderNumber : activeWork?.id}
          </span>
        </div>

        {/* Progress Bar */}
        <div className="space-y-1">
          <div className="flex justify-between text-sm font-medium">
            <span>{completedItems}/{totalItems} items</span>
            <span>{Math.round(progressPercent)}%</span>
          </div>
          <Progress value={progressPercent} className="h-2" />
        </div>
      </div>

      {hasPermission("warehouse_work", "picking") &&
        pickingMode === "single" &&
        activeOrder &&
        getSubOrderIds(activeOrder.id).map((orderId) => (
          <AssemblyHandoffPanel
            key={orderId}
            orderId={orderId}
            onHandedOff={onAssemblyHandedOff}
          />
        ))}
      {/* Main Pick Interface */}
      {pickerViewMode === "focus" ? (
        /* FOCUS VIEW - Single item at a time, optimized for scanner */
        <div className="flex-1 p-3 md:p-4 flex flex-col max-w-2xl mx-auto w-full">
          {currentItem ? (
            <Card
              className={cn(
                "flex-1 shadow-lg flex flex-col transition-all duration-200",
                scanStatus === "success" && "border-emerald-500 border-2 bg-emerald-50/50 dark:bg-emerald-950/30",
                scanStatus === "error" && "border-red-500 border-2 bg-red-50/50 dark:bg-red-950/30 animate-shake",
              )}
            >
              {/* Location Header - BIG and prominent */}
              <CardHeader className="bg-muted/50 py-4 px-4 text-center border-b">
                <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest mb-1">GO TO</div>
                <div className="text-4xl md:text-5xl font-black font-mono text-primary tracking-wide">
                  {currentItem.location}
                </div>
                {(currentItem.location === "UNASSIGNED" || currentItem.location === "U") && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 h-9"
                    onClick={() => openAllocationDialog(null)}
                    data-testid="button-set-bin-focus"
                  >
                    <MapPin className="h-4 w-4 mr-2" />
                    Set Bin
                  </Button>
                )}
                {replenBins[String(currentItem.id)] && (
                  <div className="mt-1 text-xs font-mono text-muted-foreground" data-testid="replen-bin-focus">
                    ↻ Replen: <span className="font-semibold">{replenBins[String(currentItem.id)].locationCode}</span>
                  </div>
                )}
                {currentItem.replenPrediction && (currentItem.replenPrediction.replenNeeded || currentItem.replenPrediction.existingTaskId) && (
                  <div className="mt-2 flex justify-center">
                    <ReplenPredictionBadge prediction={currentItem.replenPrediction} canOpenTask={canViewReplenTasks} />
                  </div>
                )}
                <div className="flex items-center justify-center gap-2 mt-2">
                  {activeWork?.items.map((item, idx) => (
                    <div
                      key={item.id}
                      className={cn(
                        "h-2 w-2 rounded-full transition-all",
                        item.status === "completed" && "bg-emerald-500",
                        item.status === "short" && "bg-amber-500",
                        idx === currentItemIndex && "bg-primary w-4",
                        item.status === "pending" && idx !== currentItemIndex && "bg-muted-foreground/30",
                      )}
                    />
                  ))}
                </div>
              </CardHeader>

              <CardContent className="flex-1 flex flex-col p-4 gap-4">
                {/* Product Info */}
                <div className="flex items-center gap-4">
                  <div className="relative shrink-0">
                    {currentItem.image ? (
                      <img
                        src={currentItem.image}
                        alt={currentItem.name}
                        className="w-24 h-24 md:w-28 md:h-28 object-cover rounded-lg border-2 border-muted"
                      />
                    ) : (
                      <div className="w-24 h-24 md:w-28 md:h-28 rounded-lg border-2 border-muted bg-muted flex items-center justify-center">
                        <Package className="w-12 h-12 text-muted-foreground" />
                      </div>
                    )}
                    {scanStatus === "success" && (
                      <div className="absolute inset-0 bg-emerald-500/20 rounded-lg flex items-center justify-center">
                        <CheckCircle2 className="w-12 h-12 text-emerald-600" />
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="text-2xl md:text-3xl font-bold font-mono mb-1">{currentItem.sku}</div>
                    <div className="text-muted-foreground text-sm md:text-base truncate">{currentItem.name}</div>
                    <div className="text-xs text-muted-foreground mt-1">Order {currentItem.orderId}</div>
                  </div>
                </div>

                {/* Quantity Badge - HUGE */}
                <div
                  className={cn(
                    "py-4 rounded-xl text-center",
                    scanStatus === "success" ? "bg-emerald-100 dark:bg-emerald-900/50" : "bg-red-100 dark:bg-red-900/30",
                  )}
                >
                  <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Pick Quantity</div>
                  <div
                    className={cn(
                      "text-6xl md:text-7xl font-black",
                      scanStatus === "success" ? "text-emerald-600" : "text-red-600",
                    )}
                  >
                    {currentItem.qty - currentItem.picked}
                  </div>
                </div>

                {/* Scan Input - Always visible and focused */}
                <div className="mt-auto space-y-3">
                  {scanStatus === "success" ? (
                    <div className="h-14 bg-emerald-100 border-2 border-emerald-500 rounded-xl flex items-center justify-center gap-3 text-emerald-700 font-bold text-lg animate-in zoom-in-95">
                      <CheckCircle2 className="h-6 w-6" />
                      Confirmed!
                    </div>
                  ) : scanStatus === "error" ? (
                    <div className="h-14 bg-red-100 border-2 border-red-500 rounded-xl flex items-center justify-center gap-3 text-red-700 font-bold text-lg">
                      <AlertTriangle className="h-6 w-6" />
                      Wrong Item!
                    </div>
                  ) : (
                    <div className="relative">
                      <Scan className="absolute left-4 top-1/2 -translate-y-1/2 text-primary h-6 w-6" />
                      <Input
                        ref={manualInputRef}
                        placeholder="Scan barcode..."
                        className="pl-14 h-14 text-xl font-mono border-2 border-primary/50 focus-visible:ring-primary rounded-xl"
                        value={scanInput}
                        onChange={(e) => handleScan(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === "Tab") {
                            e.preventDefault();
                            processFocusedScan(e.currentTarget.value);
                          }
                        }}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        enterKeyHint="done"
                        data-testid="input-scan-sku"
                      />
                    </div>
                  )}

                  {/* Action Buttons - Large touch targets */}
                  <div className="grid grid-cols-2 gap-3">
                    <Button
                      variant="outline"
                      className="h-14 min-h-[44px] text-base font-medium"
                      onClick={() => (currentItem.qty > 1 ? setMultiQtyOpen(true) : confirmPick(1))}
                      data-testid="button-manual-confirm"
                    >
                      <CheckCircle2 className="h-5 w-5 mr-2" />
                      Manual OK
                    </Button>
                    <Button
                      variant="outline"
                      className="h-14 min-h-[44px] text-base font-medium text-amber-600 border-amber-300 hover:bg-amber-50"
                      onClick={() => currentItem && checkReplenGuidance(currentItem, null)}
                      disabled={replenGuidanceLoading}
                      data-testid="button-short-pick"
                    >
                      <AlertTriangle className="h-5 w-5 mr-2" />
                      Short Pick
                    </Button>
                  </div>
                  {/* Hold this line and keep picking the rest of the order, or release it. */}
                  {canManageHolds && (currentItem.onHold ? (
                    <Button
                      variant="outline"
                      className="w-full mt-3 h-12 min-h-[44px] text-base font-medium text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                      onClick={() => releaseLineHoldMutation.mutate({ wmsOrderId: currentItem.wmsOrderId, itemId: currentItem.id })}
                      disabled={releaseLineHoldMutation.isPending}
                      data-testid="button-release-line"
                    >
                      <Play className="h-5 w-5 mr-2" />
                      Remove hold
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      className="w-full mt-3 h-12 min-h-[44px] text-base font-medium text-slate-700 border-slate-300 hover:bg-slate-50"
                      onClick={() => openHoldLine(currentItem)}
                      disabled={holdLineItemMutation.isPending || currentItem.picked > 0}
                      data-testid="button-hold-line"
                    >
                      <Pause className="h-5 w-5 mr-2" />
                      Hold line
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-muted-foreground">No items remaining</p>
            </div>
          )}
        </div>
      ) : (
        /* LIST VIEW - All items visible, can pick in any order */
        <div className="flex-1 p-3 md:p-4 flex flex-col max-w-2xl mx-auto w-full">
          {/* Scan input at top for list view */}
          <div className="mb-2">
            <div className="relative">
              <Scan className="absolute left-3 top-1/2 -translate-y-1/2 text-primary h-5 w-5" />
              <Input
                ref={manualInputRef}
                placeholder="Scan any item barcode..."
                className="pl-12 h-12 text-lg font-mono border-2 border-primary/50 focus-visible:ring-primary rounded-lg"
                inputMode="numeric"
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                onKeyDown={handleScanKeyDown}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                enterKeyHint="done"
                data-testid="input-scan-sku-list"
              />
            </div>
            {/* Debug log panel - shows scan activity */}
            {debugLog.length > 0 && (
              <div className="mt-1 p-2 bg-slate-900 text-green-400 rounded text-[10px] font-mono max-h-20 overflow-auto">
                {debugLog.map((log, i) => (
                  <div key={i} className={i === 0 ? "font-bold" : "text-green-600"}>{log}</div>
                ))}
              </div>
            )}
          </div>

          {/* Scrollable item list - COMPACT ROWS */}
          <ScrollArea className="flex-1">
            <div className="space-y-1 pb-4">
              {activeWork?.items.map((item, idx) => {
                const isCompleted = item.status === "completed" || item.status === "short";
                const justScanned = item.id === lastScannedItemId;

                return (
                  <div
                    key={item.id}
                    ref={(el) => {
                      if (el) itemRefs.current.set(item.id, el);
                      else itemRefs.current.delete(item.id);
                    }}
                    className={cn(
                      "flex flex-col gap-1 p-1.5 md:p-2 rounded-lg border w-full",
                      item.status === "completed" && "bg-emerald-50 border-emerald-200",
                      item.status === "short" && "bg-amber-50 border-amber-200",
                      !isCompleted && "bg-white border-slate-200",
                      justScanned && "ring-2 ring-emerald-500 bg-emerald-100",
                    )}
                    style={{ overflow: "hidden" }}
                    data-testid={`list-item-${item.id}`}
                  >
                    {/* Top row: Image, Location/Qty, Buttons */}
                    <div className="flex items-center gap-1.5 md:gap-2">
                      {/* Image - fixed size, smaller on mobile */}
                      <div className="w-10 h-10 md:w-12 md:h-12 flex-shrink-0">
                        {item.image ? (
                          <img src={item.image} alt="" className="w-10 h-10 md:w-12 md:h-12 rounded object-cover" />
                        ) : (
                          <div className="w-10 h-10 md:w-12 md:h-12 rounded bg-slate-100 flex items-center justify-center">
                            <Package className="h-4 w-4 md:h-5 md:w-5 text-slate-400" />
                          </div>
                        )}
                      </div>

                      {/* Location + Qty + SKU/Barcode */}
                      <div className="flex-1 min-w-0 overflow-hidden">
                        <div className="flex items-center gap-1.5 md:gap-2 flex-wrap">
                          <span className={cn("text-base md:text-lg font-black font-mono flex-shrink-0", isCompleted ? "text-slate-400" : "text-primary")}>
                            {item.location}
                          </span>
                          {replenBins[String(item.id)] && !isCompleted && (
                            <span
                              className="text-[10px] md:text-xs font-mono text-muted-foreground flex-shrink-0"
                              data-testid={`replen-bin-${item.id}`}
                            >
                              ↻ {replenBins[String(item.id)].locationCode}
                            </span>
                          )}
                          {(item.location === "UNASSIGNED" || item.location === "U") && !isCompleted && (
                            <Button
                              size="icon"
                              variant="outline"
                              className="h-8 w-8 flex-shrink-0 border-amber-300 text-amber-700"
                              onClick={() => openAllocationDialog(idx)}
                              data-testid={`button-set-bin-${item.id}`}
                            >
                              <MapPin className="h-4 w-4" />
                            </Button>
                          )}
                          <button
                            onClick={() => openEditQtyDialog(idx)}
                            className={cn(
                              "text-sm md:text-base font-bold px-2 py-0.5 md:px-2.5 md:py-1 rounded flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all",
                              isCompleted
                                ? "bg-emerald-100 text-emerald-700"
                                : "bg-amber-100 text-amber-800",
                            )}
                            data-testid={`qty-badge-${item.id}`}
                          >
                            {item.picked}/{item.qty}
                          </button>
                        </div>
                        <div className="text-[10px] md:text-xs font-mono font-semibold text-slate-500 truncate">{item.sku}</div>
                        {item.barcode && <div className="text-[9px] md:text-[10px] font-mono text-blue-500 truncate">BC: {item.barcode}</div>}
                        <ReplenPredictionBadge prediction={item.replenPrediction} compact canOpenTask={canViewReplenTasks} />
                      </div>

                      {/* Buttons - fixed width, always visible, touch-friendly */}
                      <div className="flex-shrink-0 flex gap-1 justify-end">
                        {!isCompleted ? (
                          <div className="flex gap-1">
                            {/* +1 Button */}
                            <Button
                              size="icon"
                              variant="outline"
                              className="h-9 w-9 md:h-11 md:w-11 border-blue-400 text-blue-600 flex-shrink-0"
                              onClick={() => handleListItemManualPickOne(idx)}
                              disabled={item.picked >= item.qty}
                              data-testid={`button-plus-${item.id}`}
                            >
                              <Plus className="h-4 w-4 md:h-5 md:w-5" />
                            </Button>
                            {/* Pick All Button */}
                            <Button
                              size="icon"
                              className="h-9 w-9 md:h-11 md:w-11 bg-emerald-500 text-white flex-shrink-0"
                              onClick={() => handleListItemPick(idx)}
                              data-testid={`button-pick-${item.id}`}
                            >
                              <CheckCircle2 className="h-4 w-4 md:h-5 md:w-5" />
                            </Button>
                            {/* ⋯ Overflow — exception-path actions */}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="outline"
                                  className="h-9 w-9 md:h-11 md:w-11 border-slate-300 text-slate-600 flex-shrink-0"
                                  aria-label={`More actions for ${item.sku}`}
                                  data-testid={`button-more-${item.id}`}
                                >
                                  <MoreVertical className="h-4 w-4 md:h-5 md:w-5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  className="text-amber-700 focus:text-amber-800"
                                  disabled={replenGuidanceLoading}
                                  onClick={() => handleListItemShort(idx)}
                                  data-testid={`menu-short-${item.id}`}
                                >
                                  <AlertTriangle className="h-4 w-4 mr-2" />
                                  Short pick
                                </DropdownMenuItem>
                                {canManageHolds && (item.onHold ? (
                                  <DropdownMenuItem
                                    disabled={releaseLineHoldMutation.isPending}
                                    onClick={() => releaseLineHoldMutation.mutate({ wmsOrderId: item.wmsOrderId, itemId: item.id })}
                                    data-testid={`menu-release-${item.id}`}
                                  >
                                    <Play className="h-4 w-4 mr-2" />
                                    Remove hold
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem
                                    disabled={item.picked > 0 || holdLineItemMutation.isPending}
                                    onClick={() => openHoldLine(item)}
                                    data-testid={`menu-hold-${item.id}`}
                                  >
                                    <Pause className="h-4 w-4 mr-2" />
                                    Hold line
                                  </DropdownMenuItem>
                                ))}
                                <DropdownMenuItem
                                  disabled={item.picked <= 0}
                                  onClick={() => handleListItemDecrement(idx)}
                                  data-testid={`menu-minus-${item.id}`}
                                >
                                  <Minus className="h-4 w-4 mr-2" />
                                  Unpick one (−1)
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => openEditQtyDialog(idx)}
                                  data-testid={`menu-editqty-${item.id}`}
                                >
                                  <Edit3 className="h-4 w-4 mr-2" />
                                  Edit quantity
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => openAllocationDialog(idx)}
                                  data-testid={`menu-bin-${item.id}`}
                                >
                                  <MapPin className="h-4 w-4 mr-2" />
                                  Assign bin
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        ) : item.status === "completed" ? (
                          <div className="flex gap-1">
                            <Button
                              size="icon"
                              variant="outline"
                              className="h-9 w-9 md:h-11 md:w-11 border-amber-300 text-amber-700 bg-white hover:bg-amber-50 flex-shrink-0"
                              onClick={() => handleListItemDecrement(idx)}
                              disabled={item.picked <= 0 || unpickItemMutation.isPending}
                              aria-label={`Unpick one ${item.sku}`}
                              title={`Unpick one ${item.sku}`}
                              data-testid={`button-unpick-${item.id}`}
                            >
                              <RotateCcw className="h-4 w-4 md:h-5 md:w-5" />
                            </Button>
                            <div className="h-9 w-9 md:h-11 md:w-11 flex items-center justify-center">
                              <CheckCircle2 className="h-5 w-5 md:h-6 md:w-6 text-emerald-500" />
                            </div>
                          </div>
                        ) : (
                          <div className="h-9 w-9 md:h-11 md:w-11 flex items-center justify-center">
                            <AlertTriangle className="h-5 w-5 md:h-6 md:w-6 text-amber-500" />
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Bottom row: Product name - full width */}
                    <div className="text-xs md:text-sm text-slate-600 pl-0.5">{item.name}</div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>

          {/* Check if all done */}
          {activeWork && activeWork.items.every(i => i.status === "completed" || i.status === "short") && (
            <div className="pt-3">
              <Button
                className="w-full h-14 bg-emerald-600 hover:bg-emerald-700 text-lg"
                disabled={updateItemMutation.isPending || unpickItemMutation.isPending}
                onClick={onCompleteAll}
                data-testid="button-complete-all"
              >
                <CheckCircle2 className="h-5 w-5 mr-2" />
                Complete {pickingMode === "batch" ? "Batch" : "Order"}
              </Button>
            </div>
          )}
        </div>
      )}

      {children}

      {/* CSS for shake animation */}
      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
          20%, 40%, 60%, 80% { transform: translateX(4px); }
        }
        .animate-shake {
          animation: shake 0.5s ease-in-out;
        }
      `}</style>
    </div>
  );
}
