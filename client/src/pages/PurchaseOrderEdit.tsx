// PurchaseOrderEdit.tsx
//
// Full-page PO editor for Spec A. Mounts at /purchase-orders/new and
// /purchase-orders/:id/edit (the :id path is the drafts-only editor). Reuses
// existing Echelon primitives — do NOT introduce new button/input components.
//
// Layout (per spec §4):
//   Header: title + Save draft + Save & Send PDF + Cancel
//   Vendor section: combobox typeahead + terms strip
//   Lines editor: inline rows with product typeahead, qty, unit cost, total
//   Totals: subtotal computed
//   Advanced collapsible: PO type, priority, expected delivery, incoterms
//       (incoterms only rendered when vendor.country !== 'US' AND
//       hide_incoterms_domestic === false), vendor notes, internal notes.
//
// Keyboard (per spec §14):
//   Cmd+S   — Save draft
//   Cmd+Enter — Save & Send PDF
//   Esc     — Cancel (with confirm if dirty)
//
// Money stays in integer cents. Floats are never used for currency.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import {
  ChevronDown,
  ChevronsUpDown,
  Check,
  Trash2,
  Plus,
  ShoppingCart,
  AlertCircle,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────

type Vendor = {
  id: number;
  name: string;
  code: string;
  country?: string | null;
  defaultIncoterms?: string | null;
  paymentTermsDays?: number | null;
  paymentTermsType?: string | null;
  leadTimeDays?: number | null;
};

type ProductVariantLite = {
  id: number;
  productId: number;
  sku: string | null;
  name: string | null;
};

type ProductLite = {
  id: number;
  name: string;
  sku?: string | null;
  variants?: ProductVariantLite[];
};

type LineDraft = {
  // Client-local id for React key. NOT sent to the server.
  clientId: string;
  productVariantId: number | null;
  productId: number | null;
  productName: string;
  sku: string | null;
  orderQty: number;
  unitCostCents: number; // integer cents, always
  vendorProductId?: number | null;
};

type PreloadResponse = {
  vendor: Vendor | null;
  lines: Array<{
    productVariantId: number;
    productName: string;
    sku: string | null;
    variantDescription: string | null;
    uomLabel: string | null;
    suggestedQty: number;
    unitCostCents: number;
    catalogSource: string;
  }>;
  sourcePo: { poNumber: string; note: string } | null;
};

type ProcurementSettings = {
  requireApproval: boolean;
  autoSendOnApprove: boolean;
  requireAcknowledgeBeforeReceive: boolean;
  hideIncotermsDomestic: boolean;
  enableShipmentTracking: boolean;
  autoPutawayLocation: boolean;
  autoCloseOnReconcile: boolean;
  oneClickReceiveStart: boolean;
  useNewPoEditor: boolean;
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function dollarsToCents(dollars: string): number {
  // Accepts "12.34", "12", ".34", "-5.00". Returns integer cents.
  // Handles negatives defensively (we clamp to >=0 later).
  const trimmed = (dollars || "").trim();
  if (!trimmed) return 0;
  const sign = trimmed.startsWith("-") ? -1 : 1;
  const abs = trimmed.replace(/^-/, "");
  const parts = abs.split(".");
  const whole = parseInt(parts[0] || "0", 10);
  const fracRaw = parts[1] ?? "";
  const frac = fracRaw.padEnd(2, "0").slice(0, 2);
  const fracNum = parseInt(frac || "0", 10);
  if (!Number.isFinite(whole) || !Number.isFinite(fracNum)) return 0;
  return sign * (whole * 100 + fracNum);
}

function centsToInputString(cents: number): string {
  const n = Math.abs(cents || 0);
  const d = Math.floor(n / 100);
  const f = n % 100;
  return `${cents < 0 ? "-" : ""}${d}.${String(f).padStart(2, "0")}`;
}

function formatCents(cents: number | null | undefined): string {
  const n = Number(cents) || 0;
  return `$${(n / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function newClientId(): string {
  return `ln-${Math.random().toString(36).slice(2, 10)}`;
}

function emptyLine(): LineDraft {
  return {
    clientId: newClientId(),
    productVariantId: null,
    productId: null,
    productName: "",
    sku: null,
    orderQty: 1,
    unitCostCents: 0,
  };
}

// Idempotency-Key header value. Fresh per mutation attempt.
function genIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as any).randomUUID();
  }
  return `po-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function PurchaseOrderEdit() {
  const { toast } = useToast();
  const [location, navigate] = useLocation();
  const params = useParams<{ id?: string }>();
  const isEditMode = Boolean(params?.id);
  const editId = params?.id ? Number(params.id) : null;

  // ── Query params (preload) ────────────────────────────────────────────
  const queryString = typeof window !== "undefined" ? window.location.search : "";
  const urlParams = useMemo(() => new URLSearchParams(queryString), [queryString]);
  const preloadVendorId = urlParams.get("vendor_id")
    ? Number(urlParams.get("vendor_id"))
    : undefined;
  const preloadVariantIdsCsv = urlParams.get("variant_ids") || "";
  const preloadDuplicateFrom = urlParams.get("duplicate_from")
    ? Number(urlParams.get("duplicate_from"))
    : undefined;

  const hasPreloadParams =
    Boolean(preloadVendorId) ||
    Boolean(preloadVariantIdsCsv) ||
    Boolean(preloadDuplicateFrom);

  // ── State ─────────────────────────────────────────────────────────────
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null);
  const [vendorOpen, setVendorOpen] = useState(false);
  const [vendorSearch, setVendorSearch] = useState("");

  const [lines, setLines] = useState<LineDraft[]>([]);
  const [poType, setPoType] = useState("standard");
  const [priority, setPriority] = useState("normal");
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState<string>("");
  const [incoterms, setIncoterms] = useState("");
  const [vendorNotes, setVendorNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Remember the initial snapshot so we only flip dirty on real changes.
  const snapshotRef = useRef<string>("");
  useEffect(() => {
    // Capture baseline after the first render completes.
    snapshotRef.current = JSON.stringify({
      vendorId: selectedVendor?.id ?? null,
      lines,
      poType,
      priority,
      expectedDeliveryDate,
      incoterms,
      vendorNotes,
      internalNotes,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const current = JSON.stringify({
      vendorId: selectedVendor?.id ?? null,
      lines,
      poType,
      priority,
      expectedDeliveryDate,
      incoterms,
      vendorNotes,
      internalNotes,
    });
    setDirty(current !== snapshotRef.current);
  }, [
    selectedVendor,
    lines,
    poType,
    priority,
    expectedDeliveryDate,
    incoterms,
    vendorNotes,
    internalNotes,
  ]);

  // ── Settings (for incoterms display rule) ─────────────────────────────
  const { data: settings } = useQuery<ProcurementSettings>({
    queryKey: ["/api/settings/procurement"],
    queryFn: async () => {
      const res = await fetch("/api/settings/procurement");
      if (!res.ok) throw new Error("Failed to load settings");
      return res.json();
    },
  });

  const showIncotermsField = useMemo(() => {
    // Per spec §6.4: only show for non-US vendors, AND only when
    // hide_incoterms_domestic is false. If vendor unknown, show by default.
    if (!settings) return false;
    const hideDomestic = settings.hideIncotermsDomestic;
    const country = selectedVendor?.country;
    if (!country) return !hideDomestic; // no vendor/country: respect setting
    if (country.toUpperCase() === "US") return false;
    return true;
  }, [settings, selectedVendor]);

  // ── Vendors typeahead ─────────────────────────────────────────────────
  const { data: allVendors = [] } = useQuery<Vendor[]>({
    queryKey: ["/api/vendors"],
    queryFn: async () => {
      const res = await fetch("/api/vendors");
      if (!res.ok) throw new Error("Failed to load vendors");
      return res.json();
    },
  });

  const filteredVendors = useMemo(() => {
    const q = vendorSearch.trim().toLowerCase();
    if (!q) return allVendors.slice(0, 30);
    return allVendors
      .filter(
        (v) =>
          v.name?.toLowerCase().includes(q) || v.code?.toLowerCase().includes(q),
      )
      .slice(0, 30);
  }, [allVendors, vendorSearch]);

  // ── Products typeahead (per-row) ──────────────────────────────────────
  const [productSearch, setProductSearch] = useState<Record<string, string>>({});
  const [productPopoverOpen, setProductPopoverOpen] = useState<Record<string, boolean>>({});

  // Shared product list fetch (by search query). Small query cache.
  function useProductSearch(q: string) {
    return useQuery<ProductLite[]>({
      queryKey: ["/api/products", { q }],
      queryFn: async () => {
        const url = q ? `/api/products?q=${encodeURIComponent(q)}` : "/api/products";
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load products");
        const data = await res.json();
        return Array.isArray(data) ? data : (data.products ?? []);
      },
      staleTime: 30_000,
    });
  }

  // ── Preload (vendor + lines) ──────────────────────────────────────────
  const { data: preload } = useQuery<PreloadResponse>({
    queryKey: [
      "/api/purchase-orders/new-preload",
      { preloadVendorId, preloadVariantIdsCsv, preloadDuplicateFrom },
    ],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (preloadVendorId) qs.set("vendor_id", String(preloadVendorId));
      if (preloadVariantIdsCsv) qs.set("variant_ids", preloadVariantIdsCsv);
      if (preloadDuplicateFrom) qs.set("duplicate_from", String(preloadDuplicateFrom));
      const res = await fetch(`/api/purchase-orders/new-preload?${qs.toString()}`);
      if (!res.ok) throw new Error("Failed to preload");
      return res.json();
    },
    enabled: !isEditMode && hasPreloadParams,
  });

  useEffect(() => {
    if (!preload) return;
    if (preload.vendor && !selectedVendor) {
      setSelectedVendor(preload.vendor);
      if (preload.vendor.defaultIncoterms) setIncoterms(preload.vendor.defaultIncoterms);
    }
    if (preload.lines?.length > 0 && lines.length === 0) {
      setLines(
        preload.lines.map((l) => ({
          clientId: newClientId(),
          productVariantId: l.productVariantId,
          productId: null, // filled if user re-selects; not strictly needed for submit
          productName: l.productName,
          sku: l.sku,
          orderQty: l.suggestedQty > 0 ? l.suggestedQty : 1,
          unitCostCents: l.unitCostCents,
        })),
      );
    }
    if (preload.sourcePo) {
      toast({
        title: preload.sourcePo.note,
        description: "Line costs refreshed from current vendor catalog where available.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preload]);

  // ── Load existing draft (edit mode) ───────────────────────────────────
  const { data: existingPo } = useQuery<any>({
    queryKey: ["/api/purchase-orders", editId, "full"],
    queryFn: async () => {
      const res = await fetch(`/api/purchase-orders/${editId}`);
      if (!res.ok) throw new Error("Failed to load PO");
      return res.json();
    },
    enabled: isEditMode && Boolean(editId),
  });

  useEffect(() => {
    if (!existingPo) return;
    if (existingPo.status !== "draft") {
      // Editor only supports drafts for now. Redirect to detail.
      navigate(`/purchase-orders/${existingPo.id}`);
      return;
    }
    if (existingPo.vendor) setSelectedVendor(existingPo.vendor);
    if (existingPo.poType) setPoType(existingPo.poType);
    if (existingPo.priority) setPriority(existingPo.priority);
    if (existingPo.expectedDeliveryDate)
      setExpectedDeliveryDate(String(existingPo.expectedDeliveryDate).slice(0, 10));
    if (existingPo.incoterms) setIncoterms(existingPo.incoterms);
    if (existingPo.vendorNotes) setVendorNotes(existingPo.vendorNotes);
    if (existingPo.internalNotes) setInternalNotes(existingPo.internalNotes);
    if (Array.isArray(existingPo.lines)) {
      setLines(
        existingPo.lines.map((l: any) => ({
          clientId: newClientId(),
          productVariantId: l.productVariantId,
          productId: l.productId,
          productName: l.productName ?? "",
          sku: l.sku ?? null,
          orderQty: l.orderQty,
          unitCostCents: Number(l.unitCostCents) || 0,
        })),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingPo]);

  // ── Totals ────────────────────────────────────────────────────────────
  const subtotalCents = useMemo(
    () =>
      lines.reduce(
        (acc, l) => acc + (Number(l.orderQty) || 0) * (Number(l.unitCostCents) || 0),
        0,
      ),
    [lines],
  );

  // ── Dirty nav prompt ──────────────────────────────────────────────────
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // ── Validation ────────────────────────────────────────────────────────
  function validateForSubmit(): string | null {
    if (!selectedVendor) return "Select a vendor before saving.";
    if (lines.length === 0) return "Add at least one line.";
    for (const [idx, l] of lines.entries()) {
      if (!l.productVariantId) return `Line ${idx + 1}: pick a product.`;
      if (!Number.isInteger(l.orderQty) || l.orderQty <= 0)
        return `Line ${idx + 1}: quantity must be a positive integer.`;
      if (!Number.isInteger(l.unitCostCents) || l.unitCostCents < 0)
        return `Line ${idx + 1}: unit cost must be zero or more.`;
    }
    return null;
  }

  // ── Save ──────────────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: async (advanceToSent: boolean) => {
      if (!selectedVendor) throw new Error("Vendor required");
      const body = {
        vendor_id: selectedVendor.id,
        po_type: poType,
        priority,
        expected_delivery_date: expectedDeliveryDate || null,
        incoterms: showIncotermsField ? incoterms || null : null,
        vendor_notes: vendorNotes || null,
        internal_notes: internalNotes || null,
        lines: lines.map((l) => ({
          product_variant_id: l.productVariantId,
          quantity_ordered: l.orderQty,
          unit_cost_cents: l.unitCostCents,
          vendor_product_id: l.vendorProductId ?? null,
        })),
        advance_to_sent: advanceToSent,
      };
      const res = await fetch("/api/purchase-orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": genIdempotencyKey(),
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to save PO");
      return data;
    },
  });

  async function handleSaveDraft() {
    const err = validateForSubmit();
    if (err) {
      toast({ title: "Cannot save", description: err, variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const result = await saveMutation.mutateAsync(false);
      const po = result?.po ?? result;
      toast({ title: "Saved as draft", description: po?.poNumber ?? "" });
      snapshotRef.current = JSON.stringify({
        vendorId: selectedVendor?.id ?? null,
        lines,
        poType,
        priority,
        expectedDeliveryDate,
        incoterms,
        vendorNotes,
        internalNotes,
      });
      setDirty(false);
      if (po?.id) navigate(`/purchase-orders/${po.id}/edit`);
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveAndSend() {
    const err = validateForSubmit();
    if (err) {
      toast({ title: "Cannot send", description: err, variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const result = await saveMutation.mutateAsync(true);
      const po = result?.po ?? result;
      if (result?.pending_approval) {
        toast({
          title: "Submitted for approval",
          description: `${po?.poNumber ?? ""} is awaiting approval.`,
        });
      } else {
        toast({
          title: "PDF placeholder — real PDF coming soon",
          description: `${po?.poNumber ?? ""} sent to vendor.`,
        });
      }
      setDirty(false);
      if (po?.id) navigate(`/purchase-orders/${po.id}`);
    } catch (e: any) {
      toast({ title: "Send failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    if (dirty) {
      const ok = window.confirm("Discard this PO? Unsaved changes will be lost.");
      if (!ok) return;
    }
    navigate("/purchase-orders");
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSaveDraft();
      } else if (isMod && e.key === "Enter") {
        e.preventDefault();
        handleSaveAndSend();
      } else if (e.key === "Escape") {
        // Don't swallow Esc while the user is inside a Popover/Command; those
        // close themselves first.
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        handleCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, selectedVendor, lines, poType, priority, expectedDeliveryDate, incoterms, vendorNotes, internalNotes]);

  // ── Lines helpers ─────────────────────────────────────────────────────
  function updateLine(clientId: string, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.clientId === clientId ? { ...l, ...patch } : l)));
  }
  function removeLine(clientId: string) {
    setLines((prev) => prev.filter((l) => l.clientId !== clientId));
  }
  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
        <div>
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <ShoppingCart className="h-5 w-5 md:h-6 md:w-6" />
            {isEditMode ? `Edit ${existingPo?.poNumber ?? "PO"}` : "New Purchase Order"}
          </h1>
          <div className="text-sm text-muted-foreground">
            Draft {dirty ? "· unsaved changes" : "· saved"}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={handleCancel} disabled={saving}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={handleSaveDraft} disabled={saving}>
            Save draft
          </Button>
          <Button onClick={handleSaveAndSend} disabled={saving}>
            Save &amp; Send PDF
          </Button>
        </div>
      </div>

      {/* Vendor card */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <Label>Vendor *</Label>
          <Popover open={vendorOpen} onOpenChange={setVendorOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                className="w-full justify-between h-11 font-normal"
              >
                <span className="truncate">
                  {selectedVendor
                    ? `${selectedVendor.code} — ${selectedVendor.name}`
                    : "Select vendor..."}
                </span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
              <Command shouldFilter={false}>
                <CommandInput
                  placeholder="Search vendors..."
                  value={vendorSearch}
                  onValueChange={setVendorSearch}
                />
                <CommandList>
                  <CommandEmpty>No vendors found.</CommandEmpty>
                  <CommandGroup>
                    {filteredVendors.map((v) => (
                      <CommandItem
                        key={v.id}
                        value={String(v.id)}
                        onSelect={() => {
                          setSelectedVendor(v);
                          setVendorOpen(false);
                          setVendorSearch("");
                          if (v.defaultIncoterms && !incoterms)
                            setIncoterms(v.defaultIncoterms);
                        }}
                      >
                        <Check
                          className={`mr-2 h-4 w-4 ${
                            selectedVendor?.id === v.id ? "opacity-100" : "opacity-0"
                          }`}
                        />
                        <span className="font-mono text-xs mr-2">{v.code}</span>
                        {v.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          {selectedVendor && (
            <div className="text-xs text-muted-foreground flex flex-wrap gap-3 pt-1">
              {selectedVendor.paymentTermsDays != null && (
                <span>
                  Terms: {selectedVendor.paymentTermsType || "net"}{" "}
                  {selectedVendor.paymentTermsDays}
                </span>
              )}
              {selectedVendor.leadTimeDays != null && (
                <span>Lead: {selectedVendor.leadTimeDays}d</span>
              )}
              {selectedVendor.country && <span>Country: {selectedVendor.country}</span>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lines editor */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-base">Lines</Label>
            <Button
              size="sm"
              variant="outline"
              onClick={addLine}
              disabled={!selectedVendor}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add line
            </Button>
          </div>
          {lines.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              {selectedVendor
                ? "Add a line to get started."
                : "Select a vendor first."}
            </div>
          ) : (
            <div className="space-y-2">
              {lines.map((line, idx) => (
                <LineRow
                  key={line.clientId}
                  line={line}
                  idx={idx}
                  onChange={(patch) => updateLine(line.clientId, patch)}
                  onRemove={() => removeLine(line.clientId)}
                  productSearch={productSearch[line.clientId] || ""}
                  setProductSearch={(q) =>
                    setProductSearch((prev) => ({ ...prev, [line.clientId]: q }))
                  }
                  popoverOpen={!!productPopoverOpen[line.clientId]}
                  setPopoverOpen={(b) =>
                    setProductPopoverOpen((prev) => ({ ...prev, [line.clientId]: b }))
                  }
                  useProductSearch={useProductSearch}
                  vendorId={selectedVendor?.id ?? null}
                />
              ))}
            </div>
          )}

          <div className="pt-2 border-t text-right space-y-1">
            <div className="text-sm">
              <span className="text-muted-foreground mr-2">Subtotal</span>
              <span className="font-semibold">{formatCents(subtotalCents)}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              Shipping &amp; tax are added at receive time.
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Advanced */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <Card>
          <CardContent className="p-4">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="w-full justify-between">
                <span>Advanced options</span>
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <Label>PO type</Label>
                  <Select value={poType} onValueChange={setPoType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="standard">Standard</SelectItem>
                      <SelectItem value="blanket">Blanket</SelectItem>
                      <SelectItem value="dropship">Dropship</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Priority</Label>
                  <Select value={priority} onValueChange={setPriority}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="rush">Rush</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Expected delivery</Label>
                  <Input
                    type="date"
                    value={expectedDeliveryDate}
                    onChange={(e) => setExpectedDeliveryDate(e.target.value)}
                  />
                </div>
              </div>
              {showIncotermsField && (
                <div>
                  <Label>Incoterms</Label>
                  <Select value={incoterms} onValueChange={setIncoterms}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      {["EXW", "FCA", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"].map(
                        (t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div>
                <Label>Vendor notes</Label>
                <Textarea
                  rows={2}
                  value={vendorNotes}
                  onChange={(e) => setVendorNotes(e.target.value)}
                  placeholder="Printed on the PO (visible to vendor)"
                />
              </div>
              <div>
                <Label>Internal notes</Label>
                <Textarea
                  rows={2}
                  value={internalNotes}
                  onChange={(e) => setInternalNotes(e.target.value)}
                  placeholder="For internal reference (not printed)"
                />
              </div>
            </CollapsibleContent>
          </CardContent>
        </Card>
      </Collapsible>

      {/* Sticky action bar on mobile */}
      <div className="md:hidden sticky bottom-0 bg-background border-t pt-2 flex gap-2">
        <Button variant="ghost" onClick={handleCancel} disabled={saving} className="flex-1">
          Cancel
        </Button>
        <Button variant="secondary" onClick={handleSaveDraft} disabled={saving} className="flex-1">
          Save draft
        </Button>
        <Button onClick={handleSaveAndSend} disabled={saving} className="flex-1">
          Send PDF
        </Button>
      </div>
    </div>
  );
}

// ─── LineRow ───────────────────────────────────────────────────────────────

type LineRowProps = {
  line: LineDraft;
  idx: number;
  onChange: (patch: Partial<LineDraft>) => void;
  onRemove: () => void;
  productSearch: string;
  setProductSearch: (q: string) => void;
  popoverOpen: boolean;
  setPopoverOpen: (b: boolean) => void;
  useProductSearch: (q: string) => ReturnType<typeof useQuery<ProductLite[]>>;
  vendorId: number | null;
};

function LineRow(props: LineRowProps) {
  const {
    line,
    idx,
    onChange,
    onRemove,
    productSearch,
    setProductSearch,
    popoverOpen,
    setPopoverOpen,
    useProductSearch,
    vendorId,
  } = props;

  const productsQuery = useProductSearch(productSearch);
  const products = productsQuery.data || [];

  const lineTotalCents = (Number(line.orderQty) || 0) * (Number(line.unitCostCents) || 0);

  async function prefillFromVendorCatalog(variantId: number, productId: number | null) {
    if (!vendorId) return;
    try {
      const res = await fetch(`/api/vendors/${vendorId}/products`);
      if (!res.ok) return;
      const list = (await res.json()) as Array<any>;
      const match = list.find(
        (vp) =>
          vp.productVariantId === variantId ||
          (vp.productId === productId && !vp.productVariantId),
      );
      if (match && typeof match.unitCostCents === "number") {
        onChange({ unitCostCents: match.unitCostCents, vendorProductId: match.id });
      }
    } catch {
      // Non-fatal
    }
  }

  return (
    <div className="grid grid-cols-12 gap-2 items-start">
      {/* Product typeahead */}
      <div className="col-span-12 md:col-span-6">
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className="w-full justify-between h-10 font-normal"
            >
              <span className="truncate text-left">
                {line.productVariantId
                  ? `${line.sku ? `${line.sku} · ` : ""}${line.productName || "(unnamed)"}`
                  : "Search product..."}
              </span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder="Search name or SKU..."
                value={productSearch}
                onValueChange={setProductSearch}
              />
              <CommandList>
                <CommandEmpty>No products found.</CommandEmpty>
                <CommandGroup>
                  {products.slice(0, 30).flatMap((p) => {
                    const variants = p.variants ?? [];
                    if (variants.length === 0) return [];
                    return variants.map((v) => (
                      <CommandItem
                        key={`${p.id}-${v.id}`}
                        value={`${p.id}-${v.id}`}
                        onSelect={() => {
                          onChange({
                            productId: p.id,
                            productVariantId: v.id,
                            productName: p.name,
                            sku: v.sku,
                          });
                          setPopoverOpen(false);
                          setProductSearch("");
                          prefillFromVendorCatalog(v.id, p.id);
                        }}
                      >
                        <span className="font-mono text-xs mr-2 text-muted-foreground">
                          {v.sku}
                        </span>
                        <span className="truncate">{p.name}</span>
                      </CommandItem>
                    ));
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {/* Qty */}
      <div className="col-span-4 md:col-span-2">
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={line.orderQty}
          onChange={(e) => {
            const n = parseInt(e.target.value || "0", 10);
            onChange({ orderQty: Number.isFinite(n) ? Math.max(0, n) : 0 });
          }}
          aria-label={`Line ${idx + 1} quantity`}
        />
      </div>

      {/* Unit cost */}
      <div className="col-span-4 md:col-span-2">
        <Input
          inputMode="decimal"
          value={centsToInputString(line.unitCostCents)}
          onChange={(e) => {
            onChange({ unitCostCents: Math.max(0, dollarsToCents(e.target.value)) });
          }}
          aria-label={`Line ${idx + 1} unit cost`}
        />
      </div>

      {/* Line total */}
      <div className="col-span-3 md:col-span-1 text-right text-sm pt-2 font-mono">
        {formatCents(lineTotalCents)}
      </div>

      {/* Remove */}
      <div className="col-span-1 text-right">
        <Button
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label={`Remove line ${idx + 1}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
