import React, { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
import { Switch } from "@/components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  Search,
  Plus,
  ChevronRight,
  ChevronsUpDown,
  Check,
  Star,
  Pencil,
  Trash2,
  Building2,
  Package,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Vendor = {
  id: number;
  code: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  active: number;
  paymentTermsDays: number | null;
  paymentTermsType: string | null;
  currency: string | null;
  taxId: string | null;
  accountNumber: string | null;
  website: string | null;
  defaultLeadTimeDays: number | null;
  minimumOrderCents: number | null;
  freeFreightThresholdCents: number | null;
  vendorType: string | null;
  shipFromAddress: string | null;
  country: string | null;
  rating: number | null;
  createdAt: string;
  updatedAt: string;
};

type VendorProduct = {
  id: number;
  vendorId: number;
  productId: number;
  productVariantId: number | null;
  vendorSku: string | null;
  vendorProductName: string | null;
  unitCostCents: number | null;
  packSize: number | null;
  moq: number | null;
  leadTimeDays: number | null;
  isPreferred: number | null;
  isActive: number | null;
  lastPurchasedAt: string | null;
  lastCostCents: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  // Joined fields from API (if present)
  productSku?: string;
  productName?: string;
  variantSku?: string;
  variantName?: string;
};

type Product = {
  id: number;
  baseSku: string;
  name: string;
};

type ProductVariant = {
  id: number;
  productId: number;
  sku: string;
  name: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCents(cents: number | null | undefined): string {
  if (cents == null || cents === 0) return "$0.00";
  return `$${(Number(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function parseDollarsInput(val: string): number | null {
  const n = parseFloat(val);
  if (isNaN(n) || n < 0) return null;
  return n * 100;
}

function centsToInputStr(cents: number | null | undefined): string {
  if (cents == null) return "";
  const dollars = cents / 100;
  // Show up to 4 decimal places, trimming trailing zeros
  return dollars % 1 === 0 ? dollars.toFixed(2) : parseFloat(dollars.toFixed(4)).toString();
}

const VENDOR_TYPE_BADGES: Record<
  string,
  { label: string; className: string }
> = {
  manufacturer: {
    label: "Manufacturer",
    className: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  },
  distributor: {
    label: "Distributor",
    className: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  },
  broker: {
    label: "Broker",
    className: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  },
};

function RatingDots({ rating }: { rating: number | null }) {
  if (!rating) return <span className="text-muted-foreground">-</span>;
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={cn(
            "h-3 w-3",
            i <= rating
              ? "fill-amber-400 text-amber-400"
              : "text-muted-foreground/30"
          )}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Empty vendor/product form defaults
// ---------------------------------------------------------------------------

const EMPTY_VENDOR_FORM = {
  code: "",
  name: "",
  vendorType: "distributor",
  contactName: "",
  email: "",
  phone: "",
  address: "",
  website: "",
  paymentTermsDays: "",
  paymentTermsType: "net",
  defaultLeadTimeDays: "",
  minimumOrderDollars: "",
  freeFreightThresholdDollars: "",
  country: "",
  taxId: "",
  accountNumber: "",
  notes: "",
  rating: "0",
  active: true,
};

const EMPTY_VP_FORM = {
  productId: 0,
  productVariantId: null as number | null,
  vendorSku: "",
  vendorProductName: "",
  unitCostDollars: "",
  packSize: "",
  moq: "",
  leadTimeDays: "",
  isPreferred: false,
  notes: "",
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function Suppliers() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Search
  const [search, setSearch] = useState("");

  // Expanded vendor row
  const [expandedVendorId, setExpandedVendorId] = useState<number | null>(null);

  // Vendor dialog
  const [vendorDialogOpen, setVendorDialogOpen] = useState(false);
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);
  const [vendorForm, setVendorForm] = useState({ ...EMPTY_VENDOR_FORM });

  // Vendor product dialog
  const [vpDialogOpen, setVpDialogOpen] = useState(false);
  const [editingVP, setEditingVP] = useState<VendorProduct | null>(null);
  const [vpForm, setVpForm] = useState({ ...EMPTY_VP_FORM });
  const [productSearch, setProductSearch] = useState("");
  const [productPopoverOpen, setProductPopoverOpen] = useState(false);

  // Delete confirmation
  const [deleteVendorId, setDeleteVendorId] = useState<number | null>(null);
  const [deleteVPId, setDeleteVPId] = useState<number | null>(null);

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  const { data: vendors = [], isLoading: vendorsLoading } = useQuery<Vendor[]>({
    queryKey: ["/api/vendors"],
  });

  const { data: products = [] } = useQuery<Product[]>({
    queryKey: ["/api/products"],
  });

  const { data: allVariants = [] } = useQuery<ProductVariant[]>({
    queryKey: ["/api/product-variants"],
  });

  // Vendor products for the currently expanded vendor
  const { data: vendorProducts = [], isLoading: vpLoading } = useQuery<
    VendorProduct[]
  >({
    queryKey: ["/api/vendors", expandedVendorId, "products"],
    queryFn: async () => {
      if (!expandedVendorId) return [];
      const res = await fetch(`/api/vendors/${expandedVendorId}/products`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch vendor products");
      const data = await res.json();
      return Array.isArray(data) ? data : (data.vendorProducts ?? []);
    },
    enabled: !!expandedVendorId,
  });

  // -----------------------------------------------------------------------
  // Computed / filtered data
  // -----------------------------------------------------------------------

  const filteredVendors = useMemo(() => {
    if (!search) return vendors;
    const q = search.toLowerCase();
    return vendors.filter(
      (v) =>
        v.code.toLowerCase().includes(q) ||
        v.name.toLowerCase().includes(q) ||
        (v.contactName || "").toLowerCase().includes(q) ||
        (v.email || "").toLowerCase().includes(q)
    );
  }, [vendors, search]);

  // Count products per vendor from expanded data is not efficient for summary.
  // The summary bar uses aggregate counts computed from vendorProducts if we
  // stored them globally. For now compute from the vendors list directly.

  const stats = useMemo(() => {
    const total = vendors.length;
    const active = vendors.filter((v) => v.active === 1).length;
    // Product count and preferred count require vendor_products data per vendor.
    // Since we only fetch for expanded vendor, we show "..." placeholder or
    // use a quick heuristic. For production, the API should return counts.
    return { total, active };
  }, [vendors]);

  // For the product typeahead in the vendor product dialog
  const filteredProducts = useMemo(() => {
    if (!productSearch) return products.slice(0, 50);
    const q = productSearch.toLowerCase();
    return products
      .filter(
        (p) =>
          p.baseSku.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q)
      )
      .slice(0, 50);
  }, [products, productSearch]);

  // Variants for the selected product in vendor product dialog
  const variantsForProduct = useMemo(() => {
    if (!vpForm.productId) return [];
    return allVariants.filter((v) => v.productId === vpForm.productId);
  }, [allVariants, vpForm.productId]);

  // -----------------------------------------------------------------------
  // Vendor CRUD mutations
  // -----------------------------------------------------------------------

  const createVendorMutation = useMutation({
    mutationFn: async (form: typeof vendorForm) => {
      const res = await apiRequest("POST", "/api/vendors", {
        code: form.code,
        name: form.name,
        vendorType: form.vendorType || null,
        contactName: form.contactName || null,
        email: form.email || null,
        phone: form.phone || null,
        address: form.address || null,
        website: form.website || null,
        paymentTermsDays: form.paymentTermsDays
          ? parseInt(form.paymentTermsDays)
          : null,
        paymentTermsType: form.paymentTermsType || null,
        defaultLeadTimeDays: form.defaultLeadTimeDays
          ? parseInt(form.defaultLeadTimeDays)
          : null,
        minimumOrderCents: parseDollarsInput(form.minimumOrderDollars),
        freeFreightThresholdCents: parseDollarsInput(
          form.freeFreightThresholdDollars
        ),
        country: form.country || null,
        taxId: form.taxId || null,
        accountNumber: form.accountNumber || null,
        notes: form.notes || null,
        rating: form.rating && form.rating !== "0" ? parseInt(form.rating) : null,
        active: form.active ? 1 : 0,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendors"] });
      setVendorDialogOpen(false);
      toast({ title: "Supplier created" });
    },
    onError: (err: Error) => {
      toast({
        title: "Error creating supplier",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const updateVendorMutation = useMutation({
    mutationFn: async ({
      id,
      form,
    }: {
      id: number;
      form: typeof vendorForm;
    }) => {
      const res = await apiRequest("PATCH", `/api/vendors/${id}`, {
        code: form.code,
        name: form.name,
        vendorType: form.vendorType || null,
        contactName: form.contactName || null,
        email: form.email || null,
        phone: form.phone || null,
        address: form.address || null,
        website: form.website || null,
        paymentTermsDays: form.paymentTermsDays
          ? parseInt(form.paymentTermsDays)
          : null,
        paymentTermsType: form.paymentTermsType || null,
        defaultLeadTimeDays: form.defaultLeadTimeDays
          ? parseInt(form.defaultLeadTimeDays)
          : null,
        minimumOrderCents: parseDollarsInput(form.minimumOrderDollars),
        freeFreightThresholdCents: parseDollarsInput(
          form.freeFreightThresholdDollars
        ),
        country: form.country || null,
        taxId: form.taxId || null,
        accountNumber: form.accountNumber || null,
        notes: form.notes || null,
        rating: form.rating && form.rating !== "0" ? parseInt(form.rating) : null,
        active: form.active ? 1 : 0,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendors"] });
      setVendorDialogOpen(false);
      setEditingVendor(null);
      toast({ title: "Supplier updated" });
    },
    onError: (err: Error) => {
      toast({
        title: "Error updating supplier",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const deleteVendorMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/vendors/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendors"] });
      setDeleteVendorId(null);
      if (expandedVendorId === deleteVendorId) setExpandedVendorId(null);
      toast({ title: "Supplier deleted" });
    },
    onError: (err: Error) => {
      toast({
        title: "Error deleting supplier",
        description: err.message,
        variant: "destructive",
      });
      setDeleteVendorId(null);
    },
  });

  // -----------------------------------------------------------------------
  // Vendor Product CRUD mutations
  // -----------------------------------------------------------------------

  const createVPMutation = useMutation({
    mutationFn: async (form: typeof vpForm & { vendorId: number }) => {
      const res = await apiRequest("POST", "/api/vendor-products", {
        vendorId: form.vendorId,
        productId: form.productId,
        productVariantId: form.productVariantId || null,
        vendorSku: form.vendorSku || null,
        vendorProductName: form.vendorProductName || null,
        unitCostCents: parseDollarsInput(form.unitCostDollars),
        packSize: form.packSize ? parseInt(form.packSize) : null,
        moq: form.moq ? parseInt(form.moq) : null,
        leadTimeDays: form.leadTimeDays ? parseInt(form.leadTimeDays) : null,
        isPreferred: form.isPreferred ? 1 : 0,
        notes: form.notes || null,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/vendors", expandedVendorId, "products"],
      });
      setVpDialogOpen(false);
      setEditingVP(null);
      toast({ title: "Product mapping created" });
    },
    onError: (err: Error) => {
      toast({
        title: "Error creating product mapping",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const updateVPMutation = useMutation({
    mutationFn: async ({
      id,
      form,
    }: {
      id: number;
      form: typeof vpForm;
    }) => {
      const res = await apiRequest("PATCH", `/api/vendor-products/${id}`, {
        productId: form.productId,
        productVariantId: form.productVariantId || null,
        vendorSku: form.vendorSku || null,
        vendorProductName: form.vendorProductName || null,
        unitCostCents: parseDollarsInput(form.unitCostDollars),
        packSize: form.packSize ? parseInt(form.packSize) : null,
        moq: form.moq ? parseInt(form.moq) : null,
        leadTimeDays: form.leadTimeDays ? parseInt(form.leadTimeDays) : null,
        isPreferred: form.isPreferred ? 1 : 0,
        notes: form.notes || null,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/vendors", expandedVendorId, "products"],
      });
      setVpDialogOpen(false);
      setEditingVP(null);
      toast({ title: "Product mapping updated" });
    },
    onError: (err: Error) => {
      toast({
        title: "Error updating product mapping",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const deleteVPMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/vendor-products/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/vendors", expandedVendorId, "products"],
      });
      setDeleteVPId(null);
      toast({ title: "Product mapping deleted" });
    },
    onError: (err: Error) => {
      toast({
        title: "Error deleting mapping",
        description: err.message,
        variant: "destructive",
      });
      setDeleteVPId(null);
    },
  });

  // -----------------------------------------------------------------------
  // Dialog open helpers
  // -----------------------------------------------------------------------

  function openCreateVendor() {
    setEditingVendor(null);
    setVendorForm({ ...EMPTY_VENDOR_FORM });
    setVendorDialogOpen(true);
  }

  function openEditVendor(v: Vendor) {
    setEditingVendor(v);
    setVendorForm({
      code: v.code,
      name: v.name,
      vendorType: v.vendorType || "distributor",
      contactName: v.contactName || "",
      email: v.email || "",
      phone: v.phone || "",
      address: v.address || "",
      website: v.website || "",
      paymentTermsDays: v.paymentTermsDays != null ? String(v.paymentTermsDays) : "",
      paymentTermsType: v.paymentTermsType || "net",
      defaultLeadTimeDays:
        v.defaultLeadTimeDays != null ? String(v.defaultLeadTimeDays) : "",
      minimumOrderDollars: centsToInputStr(v.minimumOrderCents),
      freeFreightThresholdDollars: centsToInputStr(v.freeFreightThresholdCents),
      country: v.country || "",
      taxId: v.taxId || "",
      accountNumber: v.accountNumber || "",
      notes: v.notes || "",
      rating: v.rating != null ? String(v.rating) : "0",
      active: v.active === 1,
    });
    setVendorDialogOpen(true);
  }

  function openCreateVP(vendorId: number) {
    setEditingVP(null);
    setVpForm({ ...EMPTY_VP_FORM });
    setProductSearch("");
    setVpDialogOpen(true);
  }

  function openEditVP(vp: VendorProduct) {
    setEditingVP(vp);
    setVpForm({
      productId: vp.productId,
      productVariantId: vp.productVariantId,
      vendorSku: vp.vendorSku || "",
      vendorProductName: vp.vendorProductName || "",
      unitCostDollars: centsToInputStr(vp.unitCostCents),
      packSize: vp.packSize != null ? String(vp.packSize) : "",
      moq: vp.moq != null ? String(vp.moq) : "",
      leadTimeDays: vp.leadTimeDays != null ? String(vp.leadTimeDays) : "",
      isPreferred: vp.isPreferred === 1,
      notes: vp.notes || "",
    });
    setProductSearch("");
    setVpDialogOpen(true);
  }

  function handleVendorSubmit() {
    if (!vendorForm.code || !vendorForm.name) {
      toast({
        title: "Code and Name are required",
        variant: "destructive",
      });
      return;
    }
    if (editingVendor) {
      updateVendorMutation.mutate({
        id: editingVendor.id,
        form: vendorForm,
      });
    } else {
      createVendorMutation.mutate(vendorForm);
    }
  }

  function handleVPSubmit() {
    if (!vpForm.productId) {
      toast({
        title: "Product is required",
        variant: "destructive",
      });
      return;
    }
    if (editingVP) {
      updateVPMutation.mutate({ id: editingVP.id, form: vpForm });
    } else if (expandedVendorId) {
      createVPMutation.mutate({ ...vpForm, vendorId: expandedVendorId });
    }
  }

  // -----------------------------------------------------------------------
  // Helper: resolve product/variant names for vendor products
  // -----------------------------------------------------------------------

  function resolveProductName(vp: VendorProduct): string {
    if (vp.productName) return vp.productName;
    const p = products.find((x) => x.id === vp.productId);
    return p?.name || `Product #${vp.productId}`;
  }

  function resolveProductSku(vp: VendorProduct): string {
    // If the VP has a variant, show variant SKU. Otherwise show product base SKU.
    if (vp.variantSku) return vp.variantSku;
    if (vp.productVariantId) {
      const pv = allVariants.find((x) => x.id === vp.productVariantId);
      if (pv) return pv.sku;
    }
    if (vp.productSku) return vp.productSku;
    const p = products.find((x) => x.id === vp.productId);
    return p?.baseSku || "-";
  }

  // -----------------------------------------------------------------------
  // Summary bar values (products mapped / preferred)
  // We track these from the expanded vendor's products for now, or show "-" if
  // no vendor is expanded. For a richer summary the API could return aggregates.
  // -----------------------------------------------------------------------

  const productsMapped = expandedVendorId ? vendorProducts.length : null;
  const preferredCount = expandedVendorId
    ? vendorProducts.filter((vp) => vp.isPreferred === 1).length
    : null;

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const vendorMutating =
    createVendorMutation.isPending || updateVendorMutation.isPending;
  const vpMutating = createVPMutation.isPending || updateVPMutation.isPending;

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <Building2 className="h-5 w-5 md:h-6 md:w-6" />
            Suppliers
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage vendors and their product catalogs
          </p>
        </div>
        <Button
          onClick={openCreateVendor}
          className="min-h-[44px] w-full sm:w-auto"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Supplier
        </Button>
      </div>

      {/* Summary Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold">{stats.total}</div>
            <div className="text-xs md:text-sm text-muted-foreground">
              Total Suppliers
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-green-600">
              {stats.active}
            </div>
            <div className="text-xs md:text-sm text-muted-foreground">
              Active
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-blue-600">
              {productsMapped != null ? productsMapped : "-"}
            </div>
            <div className="text-xs md:text-sm text-muted-foreground">
              Products Mapped
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-amber-500">
              {preferredCount != null ? preferredCount : "-"}
            </div>
            <div className="text-xs md:text-sm text-muted-foreground">
              Preferred Mappings
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search / Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search code, name, contact..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-10"
          />
        </div>
      </div>

      {/* Mobile Card View */}
      <div className="md:hidden space-y-3">
        {vendorsLoading ? (
          <Card>
            <CardContent className="p-4 text-center text-muted-foreground">
              Loading suppliers...
            </CardContent>
          </Card>
        ) : filteredVendors.length === 0 ? (
          <Card>
            <CardContent className="p-4 text-center text-muted-foreground">
              No suppliers found.
            </CardContent>
          </Card>
        ) : (
          filteredVendors.map((v) => (
            <Collapsible
              key={v.id}
              open={expandedVendorId === v.id}
              onOpenChange={(open) =>
                setExpandedVendorId(open ? v.id : null)
              }
            >
              <Card>
                <CardContent className="p-3">
                  <CollapsibleTrigger asChild>
                    <button className="w-full text-left">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-medium text-sm">
                              {v.code}
                            </span>
                            <span className="font-medium text-sm">
                              {v.name}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            {v.vendorType && (
                              <Badge
                                variant="outline"
                                className={cn(
                                  "text-xs",
                                  VENDOR_TYPE_BADGES[v.vendorType]?.className
                                )}
                              >
                                {VENDOR_TYPE_BADGES[v.vendorType]?.label ||
                                  v.vendorType}
                              </Badge>
                            )}
                            <Badge
                              variant={
                                v.active === 1 ? "default" : "secondary"
                              }
                              className={cn(
                                "text-xs",
                                v.active === 1
                                  ? "bg-green-600/20 text-green-400 border-green-600/30"
                                  : ""
                              )}
                            >
                              {v.active === 1 ? "Active" : "Inactive"}
                            </Badge>
                          </div>
                          {v.contactName && (
                            <div className="text-xs text-muted-foreground mt-1">
                              {v.contactName}
                              {v.email && ` - ${v.email}`}
                            </div>
                          )}
                          <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                            {v.defaultLeadTimeDays != null && (
                              <span>{v.defaultLeadTimeDays}d lead</span>
                            )}
                            {v.minimumOrderCents != null && (
                              <span>
                                {formatCents(v.minimumOrderCents)} min
                              </span>
                            )}
                            <RatingDots rating={v.rating} />
                          </div>
                        </div>
                        <ChevronRight
                          className={cn(
                            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                            expandedVendorId === v.id && "rotate-90"
                          )}
                        />
                      </div>
                    </button>
                  </CollapsibleTrigger>

                  <CollapsibleContent>
                    <div className="mt-3 pt-3 border-t space-y-2">
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditVendor(v);
                          }}
                        >
                          <Pencil className="h-3 w-3 mr-1" />
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            openCreateVP(v.id);
                          }}
                        >
                          <Plus className="h-3 w-3 mr-1" />
                          Add Product
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteVendorId(v.id);
                          }}
                        >
                          <Trash2 className="h-3 w-3 mr-1" />
                          Delete
                        </Button>
                      </div>

                      {vpLoading ? (
                        <p className="text-sm text-muted-foreground py-2">
                          Loading products...
                        </p>
                      ) : vendorProducts.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-2">
                          No product mappings yet.
                        </p>
                      ) : (
                        vendorProducts.map((vp) => (
                          <Card key={vp.id} className="bg-muted/30">
                            <CardContent className="p-2">
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                  <div className="font-mono text-xs">
                                    {resolveProductSku(vp)}
                                  </div>
                                  <div className="text-sm truncate">
                                    {resolveProductName(vp)}
                                  </div>
                                  <div className="flex gap-3 mt-0.5 text-xs text-muted-foreground">
                                    {vp.vendorSku && (
                                      <span>Vendor: {vp.vendorSku}</span>
                                    )}
                                    {vp.unitCostCents != null && (
                                      <span>
                                        {formatCents(vp.unitCostCents)}
                                      </span>
                                    )}
                                    {vp.moq != null && (
                                      <span>MOQ {vp.moq}</span>
                                    )}
                                    {vp.isPreferred === 1 && (
                                      <Star className="h-3 w-3 fill-amber-400 text-amber-400 inline" />
                                    )}
                                  </div>
                                </div>
                                <div className="flex gap-1 shrink-0">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    onClick={() => openEditVP(vp)}
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    onClick={() => setDeleteVPId(vp.id)}
                                  >
                                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                                  </Button>
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        ))
                      )}
                    </div>
                  </CollapsibleContent>
                </CardContent>
              </Card>
            </Collapsible>
          ))
        )}
      </div>

      {/* Desktop Table */}
      <Card className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead className="w-[90px]">Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-[120px]">Type</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead className="text-right w-[80px]">Products</TableHead>
              <TableHead className="text-right w-[90px]">Lead Time</TableHead>
              <TableHead className="text-right w-[100px]">Min Order</TableHead>
              <TableHead className="w-[100px]">Rating</TableHead>
              <TableHead className="w-[90px]">Status</TableHead>
              <TableHead className="w-[80px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {vendorsLoading ? (
              <TableRow>
                <TableCell
                  colSpan={11}
                  className="text-center text-muted-foreground py-8"
                >
                  Loading suppliers...
                </TableCell>
              </TableRow>
            ) : filteredVendors.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={11}
                  className="text-center text-muted-foreground py-8"
                >
                  No suppliers found. Click "Add Supplier" to create one.
                </TableCell>
              </TableRow>
            ) : (
              filteredVendors.map((v) => {
                const isExpanded = expandedVendorId === v.id;
                return (
                  <React.Fragment key={v.id}>
                    <TableRow
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() =>
                        setExpandedVendorId(isExpanded ? null : v.id)
                      }
                    >
                      <TableCell className="px-2">
                        <ChevronRight
                          className={cn(
                            "h-4 w-4 text-muted-foreground transition-transform",
                            isExpanded && "rotate-90"
                          )}
                        />
                      </TableCell>
                      <TableCell className="font-mono font-medium text-sm">
                        {v.code}
                      </TableCell>
                      <TableCell className="font-medium">{v.name}</TableCell>
                      <TableCell>
                        {v.vendorType && (
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-xs",
                              VENDOR_TYPE_BADGES[v.vendorType]?.className
                            )}
                          >
                            {VENDOR_TYPE_BADGES[v.vendorType]?.label ||
                              v.vendorType}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          {v.contactName || "-"}
                        </div>
                        {v.email && (
                          <div className="text-xs text-muted-foreground">
                            {v.email}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {isExpanded ? vendorProducts.length : "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {v.defaultLeadTimeDays != null
                          ? `${v.defaultLeadTimeDays}d`
                          : "-"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {v.minimumOrderCents
                          ? formatCents(v.minimumOrderCents)
                          : "-"}
                      </TableCell>
                      <TableCell>
                        <RatingDots rating={v.rating} />
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            v.active === 1 ? "default" : "secondary"
                          }
                          className={cn(
                            "text-xs",
                            v.active === 1
                              ? "bg-green-600/20 text-green-400 border-green-600/30"
                              : ""
                          )}
                        >
                          {v.active === 1 ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditVendor(v);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteVendorId(v.id);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>

                    {isExpanded && (
                      <tr>
                        <td colSpan={11} className="p-0">
                          <div className="bg-muted/30 border-y px-6 py-4 space-y-3">
                            {/* Vendor products sub-header */}
                            <div className="flex items-center justify-between">
                              <h3 className="text-sm font-medium flex items-center gap-2">
                                <Package className="h-4 w-4" />
                                Product Catalog for {v.name}
                              </h3>
                              <Button
                                size="sm"
                                onClick={() => openCreateVP(v.id)}
                              >
                                <Plus className="h-3.5 w-3.5 mr-1" />
                                Add Product
                              </Button>
                            </div>

                            {/* Vendor products sub-table */}
                            {vpLoading ? (
                              <p className="text-sm text-muted-foreground py-4 text-center">
                                Loading products...
                              </p>
                            ) : vendorProducts.length === 0 ? (
                              <p className="text-sm text-muted-foreground py-4 text-center">
                                No product mappings yet. Click "Add Product" to
                                create one.
                              </p>
                            ) : (
                              <div className="border rounded-md bg-background">
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Our SKU</TableHead>
                                      <TableHead>Vendor SKU</TableHead>
                                      <TableHead>Product Name</TableHead>
                                      <TableHead className="text-right">
                                        Unit Cost
                                      </TableHead>
                                      <TableHead className="text-right">
                                        Pack Size
                                      </TableHead>
                                      <TableHead className="text-right">
                                        MOQ
                                      </TableHead>
                                      <TableHead className="text-right">
                                        Lead Time
                                      </TableHead>
                                      <TableHead className="text-center w-[70px]">
                                        Preferred
                                      </TableHead>
                                      <TableHead className="w-[80px]" />
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {vendorProducts.map((vp) => (
                                      <TableRow key={vp.id}>
                                        <TableCell className="font-mono text-xs">
                                          {resolveProductSku(vp)}
                                        </TableCell>
                                        <TableCell className="font-mono text-xs">
                                          {vp.vendorSku || "-"}
                                        </TableCell>
                                        <TableCell className="text-sm">
                                          {vp.vendorProductName ||
                                            resolveProductName(vp)}
                                        </TableCell>
                                        <TableCell className="text-right font-mono text-sm">
                                          {vp.unitCostCents != null
                                            ? formatCents(vp.unitCostCents)
                                            : "-"}
                                        </TableCell>
                                        <TableCell className="text-right">
                                          {vp.packSize ?? "-"}
                                        </TableCell>
                                        <TableCell className="text-right">
                                          {vp.moq ?? "-"}
                                        </TableCell>
                                        <TableCell className="text-right">
                                          {vp.leadTimeDays != null
                                            ? `${vp.leadTimeDays}d`
                                            : "-"}
                                        </TableCell>
                                        <TableCell className="text-center">
                                          {vp.isPreferred === 1 && (
                                            <Star className="h-4 w-4 fill-amber-400 text-amber-400 mx-auto" />
                                          )}
                                        </TableCell>
                                        <TableCell>
                                          <div className="flex gap-1">
                                            <Button
                                              variant="ghost"
                                              size="icon"
                                              className="h-7 w-7"
                                              onClick={() => openEditVP(vp)}
                                            >
                                              <Pencil className="h-3 w-3 text-muted-foreground" />
                                            </Button>
                                            <Button
                                              variant="ghost"
                                              size="icon"
                                              className="h-7 w-7"
                                              onClick={() =>
                                                setDeleteVPId(vp.id)
                                              }
                                            >
                                              <Trash2 className="h-3 w-3 text-muted-foreground" />
                                            </Button>
                                          </div>
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      {/* ================================================================= */}
      {/* Add / Edit Vendor Dialog                                          */}
      {/* ================================================================= */}
      <Dialog open={vendorDialogOpen} onOpenChange={setVendorDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingVendor ? "Edit Supplier" : "Add Supplier"}
            </DialogTitle>
            <DialogDescription>
              {editingVendor
                ? "Update supplier details."
                : "Create a new supplier/vendor record."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Row 1: Code + Name */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Code *</Label>
                <Input
                  value={vendorForm.code}
                  onChange={(e) =>
                    setVendorForm((f) => ({
                      ...f,
                      code: e.target.value.toUpperCase(),
                    }))
                  }
                  placeholder="e.g. ULTRA-PRO"
                  className="h-10 font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label>Name *</Label>
                <Input
                  value={vendorForm.name}
                  onChange={(e) =>
                    setVendorForm((f) => ({ ...f, name: e.target.value }))
                  }
                  placeholder="Vendor name"
                  className="h-10"
                />
              </div>
            </div>

            {/* Row 2: Type + Status + Rating */}
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select
                  value={vendorForm.vendorType}
                  onValueChange={(v) =>
                    setVendorForm((f) => ({ ...f, vendorType: v }))
                  }
                >
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manufacturer">Manufacturer</SelectItem>
                    <SelectItem value="distributor">Distributor</SelectItem>
                    <SelectItem value="broker">Broker</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Rating</Label>
                <Select
                  value={vendorForm.rating}
                  onValueChange={(v) =>
                    setVendorForm((f) => ({ ...f, rating: v }))
                  }
                >
                  <SelectTrigger className="h-10">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">None</SelectItem>
                    <SelectItem value="1">1 Star</SelectItem>
                    <SelectItem value="2">2 Stars</SelectItem>
                    <SelectItem value="3">3 Stars</SelectItem>
                    <SelectItem value="4">4 Stars</SelectItem>
                    <SelectItem value="5">5 Stars</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Active</Label>
                <div className="flex items-center h-10 gap-2">
                  <Switch
                    checked={vendorForm.active}
                    onCheckedChange={(checked) =>
                      setVendorForm((f) => ({ ...f, active: checked }))
                    }
                  />
                  <span className="text-sm text-muted-foreground">
                    {vendorForm.active ? "Active" : "Inactive"}
                  </span>
                </div>
              </div>
            </div>

            {/* Row 3: Contact */}
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Contact Name</Label>
                <Input
                  value={vendorForm.contactName}
                  onChange={(e) =>
                    setVendorForm((f) => ({
                      ...f,
                      contactName: e.target.value,
                    }))
                  }
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={vendorForm.email}
                  onChange={(e) =>
                    setVendorForm((f) => ({ ...f, email: e.target.value }))
                  }
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Phone</Label>
                <Input
                  value={vendorForm.phone}
                  onChange={(e) =>
                    setVendorForm((f) => ({ ...f, phone: e.target.value }))
                  }
                  className="h-10"
                />
              </div>
            </div>

            {/* Row 4: Address + Website */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Address</Label>
                <Input
                  value={vendorForm.address}
                  onChange={(e) =>
                    setVendorForm((f) => ({ ...f, address: e.target.value }))
                  }
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Website</Label>
                <Input
                  value={vendorForm.website}
                  onChange={(e) =>
                    setVendorForm((f) => ({ ...f, website: e.target.value }))
                  }
                  placeholder="https://..."
                  className="h-10"
                />
              </div>
            </div>

            {/* Row 5: Payment Terms */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Payment Terms (days)</Label>
                <Input
                  type="number"
                  min="0"
                  value={vendorForm.paymentTermsDays}
                  onChange={(e) =>
                    setVendorForm((f) => ({
                      ...f,
                      paymentTermsDays: e.target.value,
                    }))
                  }
                  placeholder="e.g. 30"
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Payment Terms Type</Label>
                <Select
                  value={vendorForm.paymentTermsType}
                  onValueChange={(v) =>
                    setVendorForm((f) => ({ ...f, paymentTermsType: v }))
                  }
                >
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="net">Net</SelectItem>
                    <SelectItem value="prepaid">Prepaid</SelectItem>
                    <SelectItem value="cod">COD</SelectItem>
                    <SelectItem value="credit_card">Credit Card</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Row 6: Lead time + Min order + Free freight */}
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Default Lead Time (days)</Label>
                <Input
                  type="number"
                  min="0"
                  value={vendorForm.defaultLeadTimeDays}
                  onChange={(e) =>
                    setVendorForm((f) => ({
                      ...f,
                      defaultLeadTimeDays: e.target.value,
                    }))
                  }
                  placeholder="e.g. 7"
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Minimum Order ($)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={vendorForm.minimumOrderDollars}
                  onChange={(e) =>
                    setVendorForm((f) => ({
                      ...f,
                      minimumOrderDollars: e.target.value,
                    }))
                  }
                  placeholder="0.00"
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Free Freight ($)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={vendorForm.freeFreightThresholdDollars}
                  onChange={(e) =>
                    setVendorForm((f) => ({
                      ...f,
                      freeFreightThresholdDollars: e.target.value,
                    }))
                  }
                  placeholder="0.00"
                  className="h-10"
                />
              </div>
            </div>

            {/* Row 7: Country + Tax ID + Account # */}
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Country</Label>
                <Input
                  value={vendorForm.country}
                  onChange={(e) =>
                    setVendorForm((f) => ({ ...f, country: e.target.value }))
                  }
                  placeholder="US"
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Tax ID</Label>
                <Input
                  value={vendorForm.taxId}
                  onChange={(e) =>
                    setVendorForm((f) => ({ ...f, taxId: e.target.value }))
                  }
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Account Number</Label>
                <Input
                  value={vendorForm.accountNumber}
                  onChange={(e) =>
                    setVendorForm((f) => ({
                      ...f,
                      accountNumber: e.target.value,
                    }))
                  }
                  className="h-10"
                />
              </div>
            </div>

            {/* Row 8: Notes */}
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={vendorForm.notes}
                onChange={(e) =>
                  setVendorForm((f) => ({ ...f, notes: e.target.value }))
                }
                placeholder="Internal notes..."
                rows={3}
              />
            </div>

            {/* Actions */}
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => setVendorDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={handleVendorSubmit}
                disabled={vendorMutating}
              >
                {vendorMutating
                  ? "Saving..."
                  : editingVendor
                  ? "Save Changes"
                  : "Create Supplier"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ================================================================= */}
      {/* Add / Edit Vendor Product Dialog                                   */}
      {/* ================================================================= */}
      <Dialog open={vpDialogOpen} onOpenChange={setVpDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingVP ? "Edit Product Mapping" : "Add Product Mapping"}
            </DialogTitle>
            <DialogDescription>
              {editingVP
                ? "Update vendor product details."
                : "Map an internal product to this vendor's catalog."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Product typeahead (Command+Popover pattern) */}
            <div className="space-y-2">
              <Label>Product *</Label>
              <Popover
                open={productPopoverOpen}
                onOpenChange={setProductPopoverOpen}
              >
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    className="w-full justify-between h-10 font-normal"
                  >
                    {vpForm.productId
                      ? (() => {
                          const p = products.find(
                            (x) => x.id === vpForm.productId
                          );
                          return p
                            ? `${p.baseSku} - ${p.name}`
                            : `Product #${vpForm.productId}`;
                        })()
                      : "Select product..."}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-[--radix-popover-trigger-width] p-0"
                  align="start"
                >
                  <Command shouldFilter={false}>
                    <CommandInput
                      placeholder="Search by SKU or name..."
                      value={productSearch}
                      onValueChange={setProductSearch}
                    />
                    <CommandList>
                      <CommandEmpty>No products found.</CommandEmpty>
                      <CommandGroup>
                        {filteredProducts.map((p) => (
                          <CommandItem
                            key={p.id}
                            value={String(p.id)}
                            onSelect={() => {
                              setVpForm((f) => ({
                                ...f,
                                productId: p.id,
                                productVariantId: null,
                              }));
                              setProductPopoverOpen(false);
                              setProductSearch("");
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                vpForm.productId === p.id
                                  ? "opacity-100"
                                  : "opacity-0"
                              )}
                            />
                            <span className="font-mono text-xs mr-2">
                              {p.baseSku}
                            </span>
                            <span className="truncate">{p.name}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            {/* Variant select (only if product is chosen and has variants) */}
            {vpForm.productId > 0 && variantsForProduct.length > 0 && (
              <div className="space-y-2">
                <Label>Variant</Label>
                <Select
                  value={
                    vpForm.productVariantId
                      ? String(vpForm.productVariantId)
                      : "none"
                  }
                  onValueChange={(val) =>
                    setVpForm((f) => ({
                      ...f,
                      productVariantId:
                        val === "none" ? null : parseInt(val),
                    }))
                  }
                >
                  <SelectTrigger className="h-10">
                    <SelectValue placeholder="Select variant..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">All / Base product</SelectItem>
                    {variantsForProduct.map((pv) => (
                      <SelectItem key={pv.id} value={String(pv.id)}>
                        {pv.sku} - {pv.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Vendor SKU + Vendor Product Name */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Vendor SKU</Label>
                <Input
                  value={vpForm.vendorSku}
                  onChange={(e) =>
                    setVpForm((f) => ({ ...f, vendorSku: e.target.value }))
                  }
                  placeholder="Vendor's SKU"
                  className="h-10 font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label>Vendor Product Name</Label>
                <Input
                  value={vpForm.vendorProductName}
                  onChange={(e) =>
                    setVpForm((f) => ({
                      ...f,
                      vendorProductName: e.target.value,
                    }))
                  }
                  placeholder="Vendor's name for product"
                  className="h-10"
                />
              </div>
            </div>

            {/* Unit Cost + Pack Size */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Unit Cost ($)</Label>
                <Input
                  type="number"
                  step="0.0001"
                  min="0"
                  value={vpForm.unitCostDollars}
                  onChange={(e) =>
                    setVpForm((f) => ({
                      ...f,
                      unitCostDollars: e.target.value,
                    }))
                  }
                  placeholder="0.00"
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Pack Size</Label>
                <Input
                  type="number"
                  min="1"
                  value={vpForm.packSize}
                  onChange={(e) =>
                    setVpForm((f) => ({ ...f, packSize: e.target.value }))
                  }
                  placeholder="e.g. 12"
                  className="h-10"
                />
              </div>
            </div>

            {/* MOQ + Lead Time */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>MOQ</Label>
                <Input
                  type="number"
                  min="1"
                  value={vpForm.moq}
                  onChange={(e) =>
                    setVpForm((f) => ({ ...f, moq: e.target.value }))
                  }
                  placeholder="Minimum order qty"
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Lead Time (days)</Label>
                <Input
                  type="number"
                  min="0"
                  value={vpForm.leadTimeDays}
                  onChange={(e) =>
                    setVpForm((f) => ({
                      ...f,
                      leadTimeDays: e.target.value,
                    }))
                  }
                  placeholder="Override vendor default"
                  className="h-10"
                />
              </div>
            </div>

            {/* Preferred toggle */}
            <div className="flex items-center gap-3">
              <Switch
                checked={vpForm.isPreferred}
                onCheckedChange={(checked) =>
                  setVpForm((f) => ({ ...f, isPreferred: checked }))
                }
              />
              <Label className="cursor-pointer">
                Preferred supplier for this product
              </Label>
            </div>

            {/* Notes */}
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={vpForm.notes}
                onChange={(e) =>
                  setVpForm((f) => ({ ...f, notes: e.target.value }))
                }
                placeholder="Notes about this mapping..."
                rows={2}
              />
            </div>

            {/* Actions */}
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => setVpDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button onClick={handleVPSubmit} disabled={vpMutating}>
                {vpMutating
                  ? "Saving..."
                  : editingVP
                  ? "Save Changes"
                  : "Add Product"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ================================================================= */}
      {/* Delete Vendor Confirmation                                        */}
      {/* ================================================================= */}
      <Dialog
        open={deleteVendorId !== null}
        onOpenChange={(open) => !open && setDeleteVendorId(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Supplier</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this supplier? This will also
              remove all associated product mappings. This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 justify-end">
            <Button
              variant="outline"
              onClick={() => setDeleteVendorId(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                deleteVendorId && deleteVendorMutation.mutate(deleteVendorId)
              }
              disabled={deleteVendorMutation.isPending}
            >
              {deleteVendorMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ================================================================= */}
      {/* Delete Vendor Product Confirmation                                */}
      {/* ================================================================= */}
      <Dialog
        open={deleteVPId !== null}
        onOpenChange={(open) => !open && setDeleteVPId(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Product Mapping</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove this product mapping from the
              vendor's catalog?
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setDeleteVPId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                deleteVPId && deleteVPMutation.mutate(deleteVPId)
              }
              disabled={deleteVPMutation.isPending}
            >
              {deleteVPMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
