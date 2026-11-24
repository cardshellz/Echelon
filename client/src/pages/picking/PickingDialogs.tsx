import React from "react";
import { AlertTriangle, PackageCheck, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import {
  previewTheme,
  themeDescriptions,
  themeNames,
  type SoundTheme,
} from "@/lib/sounds";
import { cn } from "@/lib/utils";
import { CompletedOrderDetailDialog } from "./PickingQueueViews";
import type {
  PickBatch,
  PickInventoryContext,
  PickItem,
  ReplenGuidanceData,
  SingleOrder,
} from "./picking-types-and-helpers";

export type FoundOnShelfPromptState = {
  itemId: number;
  sku: string;
  locationCode: string;
  systemQty: number;
  status: "pending" | "in_progress" | "completed" | "short";
  pickedQuantity: number;
  pickMethod: "scan" | "manual" | "pick_all" | "button";
  replenSourceLocationId?: number;
};

export interface PickingDialogsProps {
  multiQtyOpen: boolean;
  setMultiQtyOpen: (open: boolean) => void;
  multiQtyMethod?: "scan" | "manual";
  pickQty: number;
  setPickQty: (qty: number) => void;
  currentItem: PickItem | undefined;
  confirmPick: (qty: number, method?: "scan" | "manual") => void;
  foundOnShelfPrompt?: FoundOnShelfPromptState | null;
  setFoundOnShelfPrompt?: (prompt: FoundOnShelfPromptState | null) => void;
  onConfirmFoundOnShelf?: () => void;
  onShortFromFoundOnShelf?: () => void;
  editQtyOpen: boolean;
  setEditQtyOpen: (open: boolean) => void;
  editQtyIdx: number | null;
  setEditQtyIdx: (idx: number | null) => void;
  editQtyValue: number;
  setEditQtyValue: (val: number) => void;
  activeWork: PickBatch | SingleOrder | undefined;
  handleEditQtyConfirm: () => void;
  soundSettingsOpen: boolean;
  setSoundSettingsOpen: (open: boolean) => void;
  soundTheme: SoundTheme;
  setSoundTheme: (theme: SoundTheme) => void;
  hapticEnabled: boolean;
  setHapticEnabled: (enabled: boolean) => void;
  replenGuidanceOpen: boolean;
  setReplenGuidanceOpen: (open: boolean) => void;
  replenGuidanceData: ReplenGuidanceData | null;
  setReplenGuidanceData: (data: ReplenGuidanceData | null) => void;
  shortPickListIndex: number | null;
  setShortPickListIndex: (idx: number | null) => void;
  reportReplenSourceEmptyMutation: {
    mutate: (vars: { itemId: number; sourceLocationCode?: string | null }) => void;
  };
  shortPickOpen: boolean;
  setShortPickOpen: (open: boolean) => void;
  shortPickReason: string;
  setShortPickReason: (reason: string) => void;
  shortPickQty: string;
  setShortPickQty: (qty: string) => void;
  handleShortPick: () => void;
  selectedCompletedOrder: SingleOrder | null;
  setSelectedCompletedOrder: (order: SingleOrder | null) => void;
  binCountOpen: boolean;
  binCountContext: PickInventoryContext | null;
  binCountQty: string;
  setBinCountQty: (qty: string) => void;
  binCountMutation: {
    mutate: (vars: { sku: string; locationId: number; binCount: number; didReplen: boolean }) => void;
    isPending: boolean;
  };
  allocationDialogOpen: boolean;
  setAllocationDialogOpen: (open: boolean) => void;
  allocationTargetIndex: number | null;
  allocationBinCode: string;
  setAllocationBinCode: (code: string) => void;
  resolveAllocationMutation: { isPending: boolean };
  submitAllocationDialog: () => void;
}

export function PickingDialogs({
  multiQtyOpen,
  setMultiQtyOpen,
  multiQtyMethod = "scan",
  pickQty,
  setPickQty,
  currentItem,
  confirmPick,
  foundOnShelfPrompt,
  setFoundOnShelfPrompt,
  onConfirmFoundOnShelf,
  onShortFromFoundOnShelf,
  editQtyOpen,
  setEditQtyOpen,
  editQtyIdx,
  setEditQtyIdx,
  editQtyValue,
  setEditQtyValue,
  activeWork,
  handleEditQtyConfirm,
  soundSettingsOpen,
  setSoundSettingsOpen,
  soundTheme,
  setSoundTheme,
  hapticEnabled,
  setHapticEnabled,
  replenGuidanceOpen,
  setReplenGuidanceOpen,
  replenGuidanceData,
  setReplenGuidanceData,
  shortPickListIndex,
  setShortPickListIndex,
  reportReplenSourceEmptyMutation,
  shortPickOpen,
  setShortPickOpen,
  shortPickReason,
  setShortPickReason,
  shortPickQty,
  setShortPickQty,
  handleShortPick,
  selectedCompletedOrder,
  setSelectedCompletedOrder,
  binCountOpen,
  binCountContext,
  binCountQty,
  setBinCountQty,
  binCountMutation,
  allocationDialogOpen,
  setAllocationDialogOpen,
  allocationTargetIndex,
  allocationBinCode,
  setAllocationBinCode,
  resolveAllocationMutation,
  submitAllocationDialog,
}: PickingDialogsProps) {
  return (
    <>
      {/* Multi-Qty Confirm Dialog */}
      <Dialog open={multiQtyOpen} onOpenChange={setMultiQtyOpen}>
        <DialogContent className="w-[95vw] max-w-sm p-4">
          <DialogHeader>
            <DialogTitle className="text-center text-xl">Confirm Quantity</DialogTitle>
            <DialogDescription className="text-center">
              How many did you pick?
            </DialogDescription>
          </DialogHeader>

          <div className="py-6 space-y-4">
            <div className="flex items-center justify-center gap-4">
              <Button
                variant="outline"
                size="icon"
                className="h-16 w-16 min-h-[44px] min-w-[44px] text-2xl"
                onClick={() => setPickQty(Math.max(1, pickQty - 1))}
              >
                -
              </Button>
              <span className="text-5xl font-bold w-20 text-center">{pickQty}</span>
              <Button
                variant="outline"
                size="icon"
                className="h-16 w-16 min-h-[44px] min-w-[44px] text-2xl"
                onClick={() => setPickQty(Math.min(currentItem?.qty || 1, pickQty + 1))}
              >
                +
              </Button>
            </div>
            <p className="text-center text-muted-foreground">
              of {currentItem?.qty} needed
            </p>
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              className="w-full h-14 min-h-[44px] text-lg bg-emerald-600 hover:bg-emerald-700"
              onClick={() => confirmPick(pickQty, multiQtyMethod)}
            >
              Confirm {pickQty}
            </Button>
            <Button
              variant="ghost"
              className="w-full h-12 min-h-[44px]"
              onClick={() => {
                setMultiQtyOpen(false);
                setPickQty(1);
              }}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Quantity Dialog */}
      <Dialog open={editQtyOpen} onOpenChange={setEditQtyOpen}>
        <DialogContent className="w-[95vw] max-w-sm p-4">
          <DialogHeader>
            <DialogTitle className="text-center text-xl">Edit Picked Qty</DialogTitle>
            <DialogDescription className="text-center">
              Tap number to type directly or use +/- buttons
            </DialogDescription>
          </DialogHeader>

          <div className="py-6 space-y-4">
            <div className="flex items-center justify-center gap-3">
              <Button
                variant="outline"
                size="icon"
                className="h-16 w-16 min-h-[44px] min-w-[44px] text-2xl"
                onClick={() => setEditQtyValue(Math.max(0, editQtyValue - 1))}
              >
                -
              </Button>
              <Input
                type="number"
                inputMode="numeric"
                pattern="[0-9]*"
                value={editQtyValue}
                onChange={(e) => {
                  const val = parseInt(e.target.value) || 0;
                  const maxQty = editQtyIdx !== null && activeWork ? activeWork.items[editQtyIdx]?.qty || 0 : 0;
                  setEditQtyValue(Math.max(0, Math.min(maxQty, val)));
                }}
                className="w-full max-w-[100px] h-16 text-4xl font-bold text-center border-2 border-primary/50"
                data-testid="input-edit-qty"
              />
              <Button
                variant="outline"
                size="icon"
                className="h-16 w-16 min-h-[44px] min-w-[44px] text-2xl"
                onClick={() => {
                  const maxQty = editQtyIdx !== null && activeWork ? activeWork.items[editQtyIdx]?.qty || 0 : 0;
                  setEditQtyValue(Math.min(maxQty, editQtyValue + 1));
                }}
              >
                +
              </Button>
            </div>
            <p className="text-center text-muted-foreground">
              of {editQtyIdx !== null && activeWork ? activeWork.items[editQtyIdx]?.qty : 0} needed
            </p>
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              className="w-full h-14 min-h-[44px] text-lg bg-primary hover:bg-primary/90"
              onClick={handleEditQtyConfirm}
            >
              Set to {editQtyValue}
            </Button>
            <Button
              variant="ghost"
              className="w-full h-12 min-h-[44px]"
              onClick={() => {
                setEditQtyOpen(false);
                setEditQtyIdx(null);
              }}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Sound & Haptic Settings Dialog */}
      <Dialog open={soundSettingsOpen} onOpenChange={setSoundSettingsOpen}>
        <DialogContent className="w-[95vw] max-w-sm p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-center gap-2">
              <Volume2 className="h-5 w-5" />
              Sound & Haptic Settings
            </DialogTitle>
          </DialogHeader>

          <div className="py-4 space-y-6">
            <div className="space-y-3">
              <Label className="text-sm font-medium">Sound Theme</Label>
              <RadioGroup
                value={soundTheme}
                onValueChange={(value) => {
                  setSoundTheme(value as SoundTheme);
                  if (value !== "silent") {
                    setTimeout(() => previewTheme(value as SoundTheme), 100);
                  }
                }}
                className="space-y-2"
              >
                {(Object.keys(themeNames) as SoundTheme[]).map((theme) => (
                  <div
                    key={theme}
                    className={cn(
                      "flex items-center justify-between p-3 border rounded-lg cursor-pointer transition-colors",
                      soundTheme === theme && "border-primary bg-primary/5",
                    )}
                    onClick={() => {
                      setSoundTheme(theme);
                      if (theme !== "silent") {
                        setTimeout(() => previewTheme(theme), 100);
                      }
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <RadioGroupItem value={theme} id={`theme-${theme}`} />
                      <div>
                        <Label htmlFor={`theme-${theme}`} className="cursor-pointer font-medium">
                          {themeNames[theme]}
                        </Label>
                        <p className="text-xs text-muted-foreground">{themeDescriptions[theme]}</p>
                      </div>
                    </div>
                    {theme !== "silent" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          previewTheme(theme);
                        }}
                      >
                        <Volume2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </RadioGroup>
            </div>

            <div className="flex items-center justify-between p-3 border rounded-lg">
              <div>
                <Label className="font-medium">Haptic Feedback</Label>
                <p className="text-xs text-muted-foreground">Vibration on scan & pick</p>
              </div>
              <Switch
                checked={hapticEnabled}
                onCheckedChange={setHapticEnabled}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              className="w-full"
              onClick={() => setSoundSettingsOpen(false)}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Replen Guidance Dialog — shown BEFORE short pick when pickable source has stock */}
      <Dialog
        open={replenGuidanceOpen}
        onOpenChange={(open) => {
          if (!open) {
            setReplenGuidanceOpen(false);
            setReplenGuidanceData(null);
          }
        }}
      >
        <DialogContent className="w-[95vw] max-w-md p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-center gap-2 text-blue-600">
              <PackageCheck className="h-5 w-5" />
              Replen Source Available
            </DialogTitle>
            {replenGuidanceData?.source && (
              <DialogDescription className="text-center space-y-2">
                <div className="text-sm">
                  Before shorting <span className="font-mono font-semibold">{replenGuidanceData.targetItem?.sku}</span> at <span className="font-mono font-semibold">{replenGuidanceData.targetItem?.location}</span>:
                </div>
                <div className="p-3 bg-blue-50 border border-blue-200 rounded space-y-1">
                  <div className="text-xs font-medium text-blue-700">Go replen from:</div>
                  <div className="text-lg font-mono font-bold text-blue-700">{replenGuidanceData.source.locationCode}</div>
                  <div className="text-sm text-blue-600">
                    {replenGuidanceData.source.availableQty} x {replenGuidanceData.source.variantName}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground pt-1">
                  Replen this bin, then pick the item normally.
                </div>
              </DialogDescription>
            )}
          </DialogHeader>

          <div className="grid grid-cols-1 gap-3 pt-4">
            <Button
              size="lg"
              className="h-14 text-lg"
              onClick={() => {
                setReplenGuidanceOpen(false);
                setReplenGuidanceData(null);
              }}
            >
              OK, Going to Replen
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="h-12 text-base text-amber-600 border-amber-300"
              onClick={() => {
                const targetItem =
                  shortPickListIndex !== null
                    ? activeWork?.items[shortPickListIndex]
                    : currentItem;
                if (targetItem?.id) {
                  reportReplenSourceEmptyMutation.mutate({
                    itemId: targetItem.id,
                    sourceLocationCode: replenGuidanceData?.source?.locationCode ?? null,
                  });
                }
                setReplenGuidanceOpen(false);
                setReplenGuidanceData(null);
                setShortPickQty(String(targetItem?.picked || 0));
                setShortPickReason("");
                setShortPickOpen(true);
              }}
            >
              Source is also empty — Short Pick
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Short Pick Dialog */}
      <Dialog
        open={shortPickOpen}
        onOpenChange={(open) => {
          if (!open) {
            setShortPickOpen(false);
            setShortPickListIndex(null);
          }
        }}
      >
        <DialogContent className="w-[95vw] max-w-sm p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-center gap-2 text-amber-600">
              <AlertTriangle className="h-5 w-5" />
              Short Pick
            </DialogTitle>
            {(() => {
              const targetItem =
                shortPickListIndex !== null
                  ? activeWork?.items[shortPickListIndex]
                  : currentItem;
              return (
                targetItem && (
                  <DialogDescription className="text-center">
                    <span className="font-medium">{targetItem.sku}</span>
                    <br />
                    <span className="text-xs">Need {targetItem.qty}, picked {targetItem.picked || 0}</span>
                  </DialogDescription>
                )
              );
            })()}
          </DialogHeader>

          <div className="py-4 space-y-4">
            <RadioGroup value={shortPickReason} onValueChange={setShortPickReason} className="space-y-3">
              <div className="flex items-center space-x-3 p-3 border rounded-lg">
                <RadioGroupItem value="out_of_stock" id="out_of_stock" />
                <Label htmlFor="out_of_stock" className="flex-1 cursor-pointer">Out of Stock</Label>
              </div>
              <div className="flex items-center space-x-3 p-3 border rounded-lg">
                <RadioGroupItem value="not_found" id="not_found" />
                <Label htmlFor="not_found" className="flex-1 cursor-pointer">Not at location</Label>
              </div>
              <div className="flex items-center space-x-3 p-3 border rounded-lg">
                <RadioGroupItem value="damaged" id="damaged" />
                <Label htmlFor="damaged" className="flex-1 cursor-pointer">Damaged</Label>
              </div>
              <div className="flex items-center space-x-3 p-3 border rounded-lg">
                <RadioGroupItem value="wrong_item" id="wrong_item" />
                <Label htmlFor="wrong_item" className="flex-1 cursor-pointer">Wrong item in bin</Label>
              </div>
              <div className="flex items-center space-x-3 p-3 border rounded-lg">
                <RadioGroupItem value="partial" id="partial" />
                <Label htmlFor="partial" className="flex-1 cursor-pointer">Partial qty only</Label>
              </div>
            </RadioGroup>

            {shortPickReason === "partial" && (
              <div className="space-y-2">
                <Label>Available quantity:</Label>
                <Input
                  type="number"
                  inputMode="numeric"
                  value={shortPickQty}
                  onChange={(e) => setShortPickQty(e.target.value)}
                  max={(shortPickListIndex !== null ? activeWork?.items[shortPickListIndex]?.qty : currentItem?.qty) || 0}
                  min={0}
                  className="w-full h-14 text-xl text-center font-bold"
                />
              </div>
            )}
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              className="w-full h-14 min-h-[44px] text-lg bg-amber-600 hover:bg-amber-700"
              onClick={handleShortPick}
              disabled={!shortPickReason}
            >
              Report Short Pick
            </Button>
            <Button
              variant="ghost"
              className="w-full h-12 min-h-[44px]"
              onClick={() => setShortPickOpen(false)}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Completed Order Detail Dialog - Mobile Optimized */}
      <CompletedOrderDetailDialog
        selectedCompletedOrder={selectedCompletedOrder}
        setSelectedCompletedOrder={setSelectedCompletedOrder}
      />

      {/* Bin Count Dialog — only shown for inventory discrepancy (deduction failure) */}
      <Dialog open={binCountOpen} onOpenChange={() => { /* non-dismissable — must confirm count */ }}>
        <DialogContent
          className="w-[95vw] max-w-sm p-4 [&>button]:hidden"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center justify-center gap-2">
              {binCountContext?.replen.stockout ? (
                <>
                  <AlertTriangle className="h-5 w-5 text-red-600" />
                  Out of Stock
                </>
              ) : (
                <>
                  <AlertTriangle className="h-5 w-5 text-amber-600" />
                  Inventory Discrepancy
                </>
              )}
            </DialogTitle>
            {binCountContext && (
              <DialogDescription className="text-center space-y-1">
                <div>
                  <span className="font-mono font-medium">{binCountContext.sku}</span>
                  {binCountContext.locationCode && (
                    <span className="ml-2 text-muted-foreground">@ {binCountContext.locationCode}</span>
                  )}
                </div>
                <div className="text-xs text-amber-600 font-medium">
                  System inventory may be out of sync
                </div>
                {binCountContext.replen.stockout && (
                  <div className="text-xs text-red-600 font-medium">
                    No reserve stock available
                  </div>
                )}
              </DialogDescription>
            )}
          </DialogHeader>

          <div className="py-3 space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                How many units are in the bin now?
              </label>
              <Input
                type="number"
                inputMode="numeric"
                value={binCountQty}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val.length > 5) return;
                  setBinCountQty(val);
                }}
                max={10000}
                min={0}
                className="w-full h-14 text-xl text-center font-bold"
                onKeyDown={(e) => {
                  const qty = parseInt(binCountQty);
                  if (e.key === "Enter" && !isNaN(qty) && qty >= 0 && qty <= 10000 && binCountContext?.locationId) {
                    binCountMutation.mutate({
                      sku: binCountContext.sku,
                      locationId: binCountContext.locationId,
                      binCount: qty,
                      didReplen: false,
                    });
                  }
                }}
              />
              {binCountQty !== "" && parseInt(binCountQty) > 10000 && (
                <p className="text-xs text-destructive font-medium">Count cannot exceed 10,000</p>
              )}
            </div>
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              className="w-full h-14 min-h-[44px] text-lg"
              onClick={() => {
                const qty = parseInt(binCountQty);
                if (binCountContext?.locationId && !isNaN(qty) && qty >= 0 && qty <= 10000) {
                  binCountMutation.mutate({
                    sku: binCountContext.sku,
                    locationId: binCountContext.locationId,
                    binCount: qty,
                    didReplen: false,
                  });
                }
              }}
              disabled={binCountQty === "" || parseInt(binCountQty) > 10000 || !binCountContext?.locationId || binCountMutation.isPending}
            >
              {binCountMutation.isPending ? "Saving..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={allocationDialogOpen} onOpenChange={setAllocationDialogOpen}>
        <DialogContent className="w-[95vw] max-w-sm p-4">
          <DialogHeader>
            <DialogTitle className="text-center text-xl">Set Pick Bin</DialogTitle>
            <DialogDescription className="text-center">
              {(() => {
                const item = allocationTargetIndex === null ? currentItem : activeWork?.items[allocationTargetIndex];
                return item ? `${item.sku} needs ${item.qty - item.picked}` : "Enter the bin for this item";
              })()}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4 space-y-3">
            <Label htmlFor="allocation-bin-code">Bin</Label>
            <Input
              id="allocation-bin-code"
              value={allocationBinCode}
              onChange={(e) => setAllocationBinCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter" && allocationBinCode.trim() && !resolveAllocationMutation.isPending) {
                  submitAllocationDialog();
                }
              }}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="h-14 text-xl text-center font-mono font-bold uppercase"
              placeholder="A-01"
              data-testid="input-allocation-bin"
            />
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              className="w-full h-12"
              onClick={submitAllocationDialog}
              disabled={!allocationBinCode.trim() || resolveAllocationMutation.isPending}
              data-testid="button-submit-allocation-bin"
            >
              {resolveAllocationMutation.isPending ? "Assigning..." : "Assign Bin"}
            </Button>
            <Button
              variant="outline"
              className="w-full h-12"
              onClick={() => setAllocationDialogOpen(false)}
              disabled={resolveAllocationMutation.isPending}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Found on Shelf 1-Tap Confirmation Dialog (1=A) */}
      <Dialog
        open={Boolean(foundOnShelfPrompt)}
        onOpenChange={(open) => {
          if (!open && setFoundOnShelfPrompt) setFoundOnShelfPrompt(null);
        }}
      >
        <DialogContent className="w-[95vw] max-w-sm p-4" data-testid="dialog-found-on-shelf">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-center gap-2 text-amber-600">
              <AlertTriangle className="h-5 w-5" />
              Confirm Found on Shelf
            </DialogTitle>
            {foundOnShelfPrompt && (
              <DialogDescription className="text-center space-y-2 pt-1">
                <div>
                  System shows <span className="font-bold text-foreground">{foundOnShelfPrompt.systemQty}</span> on hand in{" "}
                  <span className="font-mono font-bold text-foreground">{foundOnShelfPrompt.locationCode}</span> for{" "}
                  <span className="font-mono font-semibold text-foreground">{foundOnShelfPrompt.sku}</span> (and 0 in Reserve).
                </div>
                <div className="text-xs text-muted-foreground">
                  Confirm physical stock was found in {foundOnShelfPrompt.locationCode} to log a positive adjustment for review and complete this pick without freezing the bin.
                </div>
              </DialogDescription>
            )}
          </DialogHeader>

          <DialogFooter className="flex-col gap-2 sm:flex-col pt-2">
            <Button
              className="w-full h-14 min-h-[44px] text-base bg-emerald-600 hover:bg-emerald-700"
              onClick={() => onConfirmFoundOnShelf && onConfirmFoundOnShelf()}
              data-testid="button-confirm-found-on-shelf"
            >
              Confirm Found in {foundOnShelfPrompt?.locationCode || "Bin"} & Pick
            </Button>
            {onShortFromFoundOnShelf && (
              <Button
                variant="outline"
                className="w-full h-12 min-h-[44px] text-amber-700 border-amber-300"
                onClick={onShortFromFoundOnShelf}
                data-testid="button-short-from-found-on-shelf"
              >
                Bin is Empty — Short Pick
              </Button>
            )}
            <Button
              variant="ghost"
              className="w-full h-11 min-h-[44px]"
              onClick={() => setFoundOnShelfPrompt && setFoundOnShelfPrompt(null)}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
