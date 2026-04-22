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
import {
  AddToCatalogDialog,
  type AddToCatalogDecision,
  type CatalogCandidate,
} from "@/features/po-edit/AddToCatalogDialog";

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
  // Spec A follow-up: tracks whether the selected product was NOT in the
  // vendor's catalog at the time of selection. Drives the "Add to catalog?"
  // modal on PO save. `null` for lines whose origin we don't know (e.g.
  // preloaded draft rows, legacy edit-mode rows).
  catalogOriginallyAbsent?: boolean | null;
};

// Spec A follow-up: vendor-scoped catalog-search response.
type CatalogSearchResponse = {
  inCatalog: Array<{
    vendorProductId: number;
    productId: number;
    productVariantId: number | null;
    sku: string | null;
    productName: string;
    variantName: string | null;
    vendorSku: string | null;
    vendorProductName: string | null;
    unitCostCents: number;
    packSize: number | null;
    moq: number | null;
    leadTimeDays: number | null;
    isPreferred: boolean;
  }>;
  outOfCatalog: Array<{
    productId: number;
    productVariantId: number | null;
    sku: string | null;
    productName: string;
    variantName: string | null;
  }>;
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

// Uncontrolled-ish quantity input. Same pattern as UnitCostInput below —
// keeps the raw typing buffer so backspace/delete don't bounce the caret and
// empty intermediate states ("") don't get coerced to 0 mid-type.
function QuantityInput({
  qty,
  onChangeQty,
  ariaLabel,
}: {
  qty: number;
  onChangeQty: (q: number) => void;
  ariaLabel: string;
}) {
  const [buffer, setBuffer] = useState<string>(() => (qty > 0 ? String(qty) : ""));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      setBuffer(qty > 0 ? String(qty) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qty, focused]);

  return (
    <Input
      type="text"
      inputMode="numeric"
      value={buffer}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        const raw = e.target.value;
        // Allow empty or digits only — no decimals, no negatives.
        if (raw === "" || /^\d+$/.test(raw)) {
          setBuffer(raw);
        }
      }}
      onBlur={() => {
        setFocused(false);
        const n = parseInt(buffer || "0", 10);
        const next = Number.isFinite(n) && n > 0 ? n : 0;
        setBuffer(next > 0 ? String(next) : "");
        if (next !== qty) onChangeQty(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          (e.target as HTMLInputElement).blur();
        }
      }}
      aria-label={ariaLabel}
    />
  );
}

// Uncontrolled-ish unit cost input.
//
// Problem this solves: if we render `value={centsToInputString(cents)}` and
// normalize on every keystroke, the input string gets rewritten while the user
// is mid-edit (e.g. backspacing `50000.00` → `5000.00` → `5000.0` but the
// normalizer rewrites it back to `5000.00` each time and the caret jumps to
// the end). We keep the raw typing buffer locally and only coerce to integer
// cents on blur. The parent stays the source of truth for the cents value;
// when it changes (from preload, paste, etc.) and we're not focused, we
// re-sync the buffer from the new cents.
function UnitCostInput({
  cents,
  onChangeCents,
  ariaLabel,
}: {
  cents: number;
  onChangeCents: (cents: number) => void;
  ariaLabel: string;
}) {
  const [buffer, setBuffer] = useState<string>(() => centsToInputString(cents));
  const [focused, setFocused] = useState(false);

  // When the parent's value changes from outside (preload, programmatic edit)
  // and we're not currently focused, pull the new value into the buffer.
  useEffect(() => {
    if (!focused) {
      setBuffer(centsToInputString(cents));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cents, focused]);

  return (
    <Input
      inputMode="decimal"
      value={buffer}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        // Allow any in-progress typing: digits, single dot, leading minus,
        // empty string. We do NOT normalize here — that would cause the caret
        // to jump on every keystroke. Just store the raw string.
        const raw = e.target.value;
        // Light whitelist so pasted garbage doesn't stick; still permissive
        // enough to allow intermediate states like "", ".", "5.", "5.0".
        if (raw === "" || /^-?\d*\.?\d*$/.test(raw)) {
          setBuffer(raw);
        }
      }}
      onBlur={() => {
        setFocused(false);
        // Coerce on blur. Clamp to >= 0; empty/invalid becomes 0.
        const nextCents = Math.max(0, dollarsToCents(buffer));
        setBuffer(centsToInputString(nextCents));
        if (nextCents !== cents) onChangeCents(nextCents);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          (e.target as HTMLInputElement).blur();
        }
      }}
      aria-label={ariaLabel}
    />
  );
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

  // Spec A follow-up: "Add to catalog?" modal state.
  // Populated right before a save when any line was selected from the
  // non-catalog bucket. The resolver inside the dialog flow hands control
  // back to the originating save handler via a ref-held Promise.
  const [catalogDialogOpen, setCatalogDialogOpen] = useState(false);
  const [catalogCandidates, setCatalogCandidates] = useState<CatalogCandidate[]>([]);
  const [catalogSubmitting, setCatalogSubmitting] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const catalogResolverRef = useRef<((ok: boolean) => void) | null>(null);

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

  // ── Products typeahead (per-row) ──────────────────────
  const [productSearch, setProductSearch] = useState<Record<string, string>>({});
  const [productPopoverOpen, setProductPopoverOpen] = useState<Record<string, boolean>>({});

  // Spec A follow-up: vendor-scoped typeahead. When a vendor is selected we
  // hit /api/vendors/:id/catalog-search to get a two-bucket response. When
  // no vendor is selected yet (rare, Add-line is disabled) we fall back to
  // /api/products?q= so the user can still search the global catalog.
  function useVendorCatalogSearch(vendorId: number | null, q: string) {
    return useQuery<CatalogSearchResponse>({
      queryKey: ["/api/vendors/catalog-search", { vendorId, q }],
      queryFn: async () => {
        if (vendorId) {
          const url = `/api/vendors/${vendorId}/catalog-search${
            q ? `?q=${encodeURIComponent(q)}` : ""
          }`;
          const res = await fetch(url);
          if (!res.ok) throw new Error("Failed to load vendor catalog");
          return res.json();
        }
        // Fallback: global product search, coerced into the two-bucket shape
        // with an empty inCatalog section. Lets the user start typing before
        // a vendor is picked.
        const url = q ? `/api/products?q=${encodeURIComponent(q)}` : "/api/products?limit=50";
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load products");
        const data = (await res.json()) as ProductLite[];
        const products: ProductLite[] = Array.isArray(data) ? data : (data as any).products ?? [];
        const outOfCatalog: CatalogSearchResponse["outOfCatalog"] = [];
        for (const p of products) {
          const variants = p.variants ?? [];
          if (variants.length === 0) continue;
          for (const v of variants) {
            outOfCatalog.push({
              productId: p.id,
              productVariantId: v.id,
              sku: v.sku ?? p.sku ?? null,
              productName: p.name,
              variantName: v.name,
            });
          }
        }
        return { inCatalog: [], outOfCatalog };
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

  // ── Add-to-catalog gate (Spec A follow-up) ────────────────────
  //
  // Computes the candidate list (lines selected from the "not in catalog"
  // bucket that have a valid productVariantId and a non-negative cost). If
  // none: resolves true immediately so the caller proceeds to save. If any:
  // opens the dialog and waits for the user's decision. On "Add all" or
  // "Add N selected" we POST to the bulk-upsert endpoint BEFORE returning;
  // a failure there leaves the dialog open with an error and returns false,
  // so the caller does NOT attempt the PO save.
  function computeCatalogCandidates(): CatalogCandidate[] {
    if (!selectedVendor) return [];
    const out: CatalogCandidate[] = [];
    for (const l of lines) {
      if (l.catalogOriginallyAbsent !== true) continue;
      if (!l.productVariantId || !l.productId) continue;
      if (!Number.isInteger(l.unitCostCents) || l.unitCostCents < 0) continue;
      out.push({
        clientId: l.clientId,
        productId: l.productId,
        productVariantId: l.productVariantId,
        productName: l.productName || "(unnamed)",
        sku: l.sku,
        unitCostCents: l.unitCostCents,
      });
    }
    return out;
  }

  async function maybePromptAddToCatalog(): Promise<boolean> {
    if (!selectedVendor) return true;
    const candidates = computeCatalogCandidates();
    if (candidates.length === 0) return true;
    setCatalogCandidates(candidates);
    setCatalogError(null);
    setCatalogSubmitting(false);
    setCatalogDialogOpen(true);
    return new Promise<boolean>((resolve) => {
      catalogResolverRef.current = resolve;
    });
  }

  async function handleCatalogDecision(decision: AddToCatalogDecision) {
    if (!selectedVendor) return;
    const resolver = catalogResolverRef.current;
    if (decision.action === "add-none") {
      setCatalogDialogOpen(false);
      catalogResolverRef.current = null;
      resolver?.(true);
      setLines((prev) =>
        prev.map((l) =>
          catalogCandidates.some((c) => c.clientId === l.clientId)
            ? { ...l, catalogOriginallyAbsent: false }
            : l,
        ),
      );
      return;
    }
    const toSend: CatalogCandidate[] =
      decision.action === "add-all"
        ? catalogCandidates
        : catalogCandidates.filter((c) =>
            decision.selectedClientIds.includes(c.clientId),
          );
    if (toSend.length === 0) {
      setCatalogDialogOpen(false);
      catalogResolverRef.current = null;
      resolver?.(true);
      setLines((prev) =>
        prev.map((l) =>
          catalogCandidates.some((c) => c.clientId === l.clientId)
            ? { ...l, catalogOriginallyAbsent: false }
            : l,
        ),
      );
      return;
    }
    setCatalogSubmitting(true);
    setCatalogError(null);
    try {
      const body = {
        entries: toSend.map((c) => ({
          productId: c.productId,
          productVariantId: c.productVariantId,
          unitCostCents: c.unitCostCents, // integer cents, always
        })),
      };
      const res = await fetch(
        `/api/vendors/${selectedVendor.id}/catalog/bulk-upsert`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": genIdempotencyKey(),
          },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Catalog upsert failed");
      }
      const upsertedClientIds = new Set(toSend.map((c) => c.clientId));
      setLines((prev) =>
        prev.map((l) => {
          if (!upsertedClientIds.has(l.clientId)) return l;
          const match = [
            ...(data?.created ?? []),
            ...(data?.updated ?? []),
          ].find(
            (row: any) =>
              row.productId === l.productId &&
              (row.productVariantId ?? null) === (l.productVariantId ?? null),
          );
          return {
            ...l,
            catalogOriginallyAbsent: false,
            vendorProductId: match?.vendorProductId ?? l.vendorProductId ?? null,
          };
        }),
      );
      setCatalogDialogOpen(false);
      setCatalogSubmitting(false);
      catalogResolverRef.current = null;
      resolver?.(true);
    } catch (e: any) {
      setCatalogError(e?.message || "Catalog upsert failed");
      setCatalogSubmitting(false);
      // Leave the dialog open. The user can retry, pick "Add none", or cancel.
      // Do NOT resolve the pending save promise yet — the caller is still awaiting.
    }
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
      const proceed = await maybePromptAddToCatalog();
      if (!proceed) {
        // User cancelled the catalog upsert or the upsert failed.
        // Do NOT save the PO in that case.
        return;
      }
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
      const proceed = await maybePromptAddToCatalog();
      if (!proceed) {
        return;
      }
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
                  useVendorCatalogSearch={useVendorCatalogSearch}
                  vendorId={selectedVendor?.id ?? null}
                  vendorName={selectedVendor?.name ?? null}
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

      {/* Spec A follow-up: "Add to catalog?" modal. Mounted at the page root
          so it overlays on every save path. The dialog itself blocks Esc /
          backdrop dismissal (see AddToCatalogDialog). */}
      <AddToCatalogDialog
        open={catalogDialogOpen}
        vendorName={selectedVendor?.name ?? ""}
        candidates={catalogCandidates}
        submitting={catalogSubmitting}
        error={catalogError}
        onDecide={handleCatalogDecision}
      />
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
  useVendorCatalogSearch: (
    vendorId: number | null,
    q: string,
  ) => ReturnType<typeof useQuery<CatalogSearchResponse>>;
  vendorId: number | null;
  vendorName: string | null;
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
    useVendorCatalogSearch,
    vendorId,
    vendorName,
  } = props;

  const catalogQuery = useVendorCatalogSearch(vendorId, productSearch);
  const inCatalog = catalogQuery.data?.inCatalog ?? [];
  const outOfCatalog = catalogQuery.data?.outOfCatalog ?? [];

  const lineTotalCents = (Number(line.orderQty) || 0) * (Number(line.unitCostCents) || 0);

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
                {vendorId && inCatalog.length > 0 && (
                  <CommandGroup heading={`In ${vendorName ?? "vendor"}'s catalog`}>
                    {inCatalog.slice(0, 30).map((row) => {
                      const key = `cat-${row.vendorProductId}`;
                      const hints: string[] = [];
                      if (row.packSize && row.packSize > 1) hints.push(`pack ${row.packSize}`);
                      if (row.moq && row.moq > 1) hints.push(`MOQ ${row.moq}`);
                      return (
                        <CommandItem
                          key={key}
                          value={key}
                          onSelect={() => {
                            onChange({
                              productId: row.productId,
                              productVariantId: row.productVariantId ?? null,
                              productName: row.productName,
                              sku: row.sku ?? null,
                              // From catalog: authoritative cost.
                              unitCostCents: row.unitCostCents,
                              vendorProductId: row.vendorProductId,
                              catalogOriginallyAbsent: false,
                            });
                            setPopoverOpen(false);
                            setProductSearch("");
                          }}
                        >
                          <span
                            className="mr-2 text-amber-500"
                            aria-label="In vendor catalog"
                            title="In vendor catalog"
                          >
                            ★
                          </span>
                          <span className="font-mono text-xs mr-2 text-muted-foreground">
                            {row.sku ?? "—"}
                          </span>
                          <span className="truncate flex-1">
                            {row.productName}
                            {row.variantName ? ` · ${row.variantName}` : ""}
                          </span>
                          <span className="ml-2 text-xs tabular-nums">
                            {formatCents(row.unitCostCents)}
                            {hints.length > 0 && (
                              <span className="text-muted-foreground"> · {hints.join(", ")}</span>
                            )}
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}
                {outOfCatalog.length > 0 && (
                  <CommandGroup
                    heading={
                      vendorId
                        ? "All products (not in catalog)"
                        : "All products"
                    }
                  >
                    {outOfCatalog.slice(0, 30).map((row) => {
                      const key = `pv-${row.productId}-${row.productVariantId ?? "null"}`;
                      return (
                        <CommandItem
                          key={key}
                          value={key}
                          onSelect={() => {
                            onChange({
                              productId: row.productId,
                              productVariantId: row.productVariantId ?? null,
                              productName: row.productName,
                              sku: row.sku ?? null,
                              // Not in catalog. Leave the existing unit cost
                              // (blank/zero) — the user will type it, and it
                              // becomes the "suggest-at-save" candidate cost.
                              vendorProductId: null,
                              catalogOriginallyAbsent: vendorId ? true : null,
                            });
                            setPopoverOpen(false);
                            setProductSearch("");
                          }}
                        >
                          <span className="font-mono text-xs mr-2 text-muted-foreground">
                            {row.sku ?? "—"}
                          </span>
                          <span className="truncate flex-1">
                            {row.productName}
                            {row.variantName ? ` · ${row.variantName}` : ""}
                          </span>
                          {vendorId && (
                            <span className="ml-2 text-[10px] text-muted-foreground italic">
                              not in catalog
                            </span>
                          )}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {/* Qty */}
      <div className="col-span-4 md:col-span-2">
        <QuantityInput
          qty={line.orderQty}
          onChangeQty={(q) => onChange({ orderQty: q })}
          ariaLabel={`Line ${idx + 1} quantity`}
        />
      </div>

      {/* Unit cost */}
      <div className="col-span-4 md:col-span-2">
        <UnitCostInput
          cents={line.unitCostCents}
          onChangeCents={(cents) => onChange({ unitCostCents: Math.max(0, cents) })}
          ariaLabel={`Line ${idx + 1} unit cost`}
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
