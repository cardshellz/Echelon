import { useEffect, useRef, useState, type PointerEvent } from "react";
import { ArrowLeft, ArrowRight, Download, GripVertical, Loader2, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { sortCatalogAssets, type CatalogGalleryAsset, type ReorderProductAssets } from "@shared/catalog/product-assets";

interface Props {
  assets: readonly CatalogGalleryAsset[];
  busy: boolean;
  onReorder: (command: ReorderProductAssets) => Promise<void>;
  onSetPrimary: (assetId: number) => void;
  onRemove: (assetId: number) => void;
}
interface DragState {
  id: number; x: number; y: number; startX: number; startY: number;
  overId: number | null; moved: boolean; order: number[];
}

function imageSource(asset: CatalogGalleryAsset): string {
  return asset.storageType === "file" || asset.storageType === "both"
    ? `/api/product-assets/${asset.id}/file` : asset.url ?? "";
}

export function ProductImageGallery({ assets, busy, onReorder, onSetPrimary, onRemove }: Props) {
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("inventory", "edit");
  const [pendingOrder, setPendingOrder] = useState<number[] | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const savingRef = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState<Set<number>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  const sorted = sortCatalogAssets(assets);
  const ordered = pendingOrder
    ? pendingOrder.map(id => sorted.find(asset => asset.id === id)).filter((asset): asset is CatalogGalleryAsset => !!asset)
    : sorted;
  const locked = !canEdit || busy || pendingOrder !== null;

  function cancelDrag() { dragRef.current = null; setDrag(null); }
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") cancelDrag(); };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);

  async function moveImage(id: number, targetId: number, expectedOrder = sorted.map(asset => asset.id)) {
    if (locked || savingRef.current || id === targetId) return;
    const from = expectedOrder.indexOf(id), to = expectedOrder.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...expectedOrder];
    next.splice(from, 1); next.splice(to, 0, id);
    savingRef.current = true;
    setPendingOrder(next);
    setAnnouncement(`Saving image ${from + 1} in position ${to + 1}.`);
    try {
      await onReorder({ orderedIds: next, expectedOrderedIds: expectedOrder });
      setAnnouncement(`Image moved to position ${to + 1}. Order saved.`);
    } catch (error) {
      setAnnouncement("Image order could not be saved.");
      toast({ title: "Could not save image order", description: error instanceof Error ? error.message : "Refresh and try again.", variant: "destructive" });
    } finally {
      savingRef.current = false;
      setPendingOrder(null);
    }
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, id: number) {
    if (locked || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY,
      moved: false, overId: null, order: sorted.map(asset => asset.id) };
  }

  function updateDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = dragRef.current;
    if (!current) return;
    const moved = current.moved || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 5;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-catalog-image]");
    const overId = target && gridRef.current?.contains(target) ? Number(target.dataset.catalogImage) : null;
    const next = { ...current, moved, overId, x: event.clientX, y: event.clientY };
    dragRef.current = next;
    if (moved) {
      setDrag(next);
      if (event.clientY < 70) window.scrollBy(0, -18);
      else if (event.clientY > window.innerHeight - 70) window.scrollBy(0, 18);
    }
  }

  function finishDrag() {
    const current = dragRef.current;
    cancelDrag();
    if (current?.moved && current.overId !== null) void moveImage(current.id, current.overId, current.order);
  }

  async function downloadImage(assetId: number) {
    setDownloading(current => new Set(current).add(assetId));
    try {
      const response = await fetch(`/api/product-assets/${assetId}/download`, { credentials: "include" });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(typeof body?.error === "string" ? body.error : "The photo could not be downloaded. Try again.");
      }
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("The server did not return a photo. Refresh and try again.");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `product-image-${assetId}`;
      document.body.append(link); link.click(); link.remove();
      // Leave the object URL alive until the browser has begun consuming the download.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast({ title: "Download failed", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    } finally {
      setDownloading(current => { const next = new Set(current); next.delete(assetId); return next; });
    }
  }

  const draggedAsset = drag ? assets.find(asset => asset.id === drag.id) : undefined;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <p id="catalog-image-order-help">{canEdit ? "Drag the grip to reorder photos. Primary is your cover image." : "Download photos below. Editing requires catalog edit access."}</p>
        {pendingOrder && <span className="inline-flex items-center gap-1.5"><Loader2 className="h-4 w-4 animate-spin" />Saving order…</span>}
      </div>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <div ref={gridRef} className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4" aria-label="Product images" aria-busy={pendingOrder !== null}>
        {ordered.map((asset, index) => (
          <article key={asset.id} data-catalog-image={asset.id} aria-label={`Image ${index + 1}${asset.isPrimary === 1 ? ", primary" : ""}`}
            className={cn("relative min-w-0 overflow-hidden rounded-lg border bg-card transition-shadow",
              drag?.id === asset.id && "opacity-50", drag?.overId === asset.id && drag.id !== asset.id && "ring-2 ring-primary ring-offset-2")}>
            <div className="flex h-11 items-center justify-between gap-1 border-b bg-muted/40 px-2">
              <Button type="button" variant="ghost" size="icon" disabled={locked} className="h-9 w-9 touch-none cursor-grab active:cursor-grabbing"
                aria-label={`Drag image ${index + 1} to reorder`} aria-describedby="catalog-image-order-help"
                title="Drag to reorder. You can also use the move buttons below."
                onPointerDown={event => startDrag(event, asset.id)} onPointerMove={updateDrag}
                onPointerUp={finishDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
                onKeyDown={event => {
                  const offset = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0;
                  if (offset && ordered[index + offset]) { event.preventDefault(); void moveImage(asset.id, ordered[index + offset].id); }
                }}>
                <GripVertical className="h-5 w-5" />
              </Button>
              {asset.isPrimary === 1 ? <Badge className="text-xs">Primary</Badge> : <span className="text-xs text-muted-foreground">{index + 1}</span>}
            </div>
            <div className="aspect-square bg-muted/20">
              <img src={imageSource(asset)} alt={asset.altText || `Product photo ${index + 1}`} draggable={false} className="h-full w-full object-contain" />
            </div>
            <div className="space-y-2 border-t p-2">
              <Button type="button" variant="outline" size="sm" className="min-h-10 w-full" disabled={downloading.has(asset.id)}
                aria-label={`Download image ${index + 1}`} onClick={() => void downloadImage(asset.id)}>
                {downloading.has(asset.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {downloading.has(asset.id) ? "Downloading…" : "Download"}
              </Button>
              <div className="flex flex-wrap items-center justify-between gap-1">
                <div className="flex gap-1">
                  <Button type="button" variant="ghost" size="icon" disabled={locked || index === 0} aria-label={`Move image ${index + 1} earlier`}
                    title="Move earlier" onClick={() => void moveImage(asset.id, ordered[index - 1].id)}><ArrowLeft /></Button>
                  <Button type="button" variant="ghost" size="icon" disabled={locked || index === ordered.length - 1} aria-label={`Move image ${index + 1} later`}
                    title="Move later" onClick={() => void moveImage(asset.id, ordered[index + 1].id)}><ArrowRight /></Button>
                </div>
                <div className="flex gap-1">
                  <Button type="button" variant="ghost" size="icon" disabled={locked || asset.isPrimary === 1}
                    className={asset.isPrimary === 1 ? "text-primary" : ""} aria-label={`Set image ${index + 1} as primary`} title="Set as primary"
                    onClick={() => onSetPrimary(asset.id)}><Star className={asset.isPrimary === 1 ? "fill-current" : ""} /></Button>
                  <Button type="button" variant="ghost" size="icon" disabled={locked} className="text-destructive hover:bg-destructive/10"
                    aria-label={`Remove image ${index + 1}`} title="Remove photo" onClick={() => { if (window.confirm("Remove this image?")) onRemove(asset.id); }}><Trash2 /></Button>
                </div>
              </div>
            </div>
          </article>
        ))}
      </div>
      {draggedAsset && drag && <div aria-hidden="true" className="pointer-events-none fixed z-50 h-24 w-24 overflow-hidden rounded-lg border-2 border-primary bg-background shadow-xl"
        style={{ left: drag.x + 14, top: drag.y + 14 }}><img src={imageSource(draggedAsset)} alt="" className="h-full w-full object-contain" /></div>}
    </div>
  );
}
