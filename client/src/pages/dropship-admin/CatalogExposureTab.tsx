import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Boxes,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileSearch,
  MinusCircle,
  PlusCircle,
  Save,
  Search,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildAdminCatalogExposurePreviewUrl,
  buildCatalogExposureRuleFromPreviewRow,
  buildCatalogExposureRuleInput,
  catalogExposureRecordToInput,
  catalogExposureRuleKey,
  createDropshipIdempotencyKey,
  fetchJson,
  formatStatus,
  putJson,
  queryErrorMessage,
  type DropshipAdminCatalogExposurePreviewResponse,
  type DropshipAdminCatalogExposurePreviewRow,
  type DropshipAdminCatalogExposureRuleInput,
  type DropshipAdminCatalogExposureRulesReplaceResponse,
  type DropshipAdminCatalogExposureRulesResponse,
} from "@/lib/dropship-ops-surface";
import {
  CatalogMetric,
  ProductVariantSkuPicker,
  SearchableOptionPicker,
  type DropshipProductVariantOption,
} from "./dropship-admin-shared";

type CatalogExposureScopeFilter =
  DropshipAdminCatalogExposureRuleInput["scopeType"];

type CatalogExposureActionFilter =
  DropshipAdminCatalogExposureRuleInput["action"];

type CatalogPreviewVisibilityFilter = "all" | "visible" | "hidden";

type CatalogPreviewStatusFilter = "active" | "inactive" | "all";

interface DropshipProductOption {
  id: number;
  sku?: string | null;
  baseSku?: string | null;
  name: string;
  active?: number | null;
  status?: string | null;
}

interface DropshipProductLineOption {
  id: number;
  name: string;
  status?: string | null;
  productCount?: number | null;
}

interface DropshipProductCategoryOption {
  id: number;
  name: string;
  isActive?: boolean | null;
  productCount?: number | null;
}

interface CatalogRuleTargetLabels {
  productLineNamesById: Map<number, string>;
  productLabelsById: Map<number, string>;
  variantLabelsById: Map<number, string>;
  categoryLabelsByKey: Map<string, string>;
}

const CATALOG_PREVIEW_PAGE_SIZE = 50;

interface CatalogRuleFormState {
  scopeType: CatalogExposureScopeFilter;
  action: CatalogExposureActionFilter;
  productLineId: string;
  productId: string;
  productVariantId: string;
  category: string;
  priority: string;
  notes: string;
}

const emptyCatalogRuleForm: CatalogRuleFormState = {
  scopeType: "catalog",
  action: "include",
  productLineId: "",
  productId: "",
  productVariantId: "",
  category: "",
  priority: "0",
  notes: "",
};

function CatalogExposureTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [visibilityFilter, setVisibilityFilter] =
    useState<CatalogPreviewVisibilityFilter>("all");
  const [catalogStatusFilter, setCatalogStatusFilter] =
    useState<CatalogPreviewStatusFilter>("active");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    visibility: "all" as CatalogPreviewVisibilityFilter,
    catalogStatus: "active" as CatalogPreviewStatusFilter,
  });
  const [previewPage, setPreviewPage] = useState(1);
  const [draftRules, setDraftRules] = useState<
    DropshipAdminCatalogExposureRuleInput[]
  >([]);
  const [loadedRulesKey, setLoadedRulesKey] = useState("");
  const [ruleForm, setRuleForm] =
    useState<CatalogRuleFormState>(emptyCatalogRuleForm);
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const previewUrl = useMemo(
    () =>
      buildAdminCatalogExposurePreviewUrl({
        search: appliedFilters.search,
        visibility: appliedFilters.visibility,
        catalogStatus: appliedFilters.catalogStatus,
        page: previewPage,
        limit: CATALOG_PREVIEW_PAGE_SIZE,
      }),
    [appliedFilters, previewPage],
  );

  const rulesQuery = useQuery<DropshipAdminCatalogExposureRulesResponse>({
    queryKey: ["/api/dropship/admin/catalog/rules"],
    queryFn: () =>
      fetchJson<DropshipAdminCatalogExposureRulesResponse>(
        "/api/dropship/admin/catalog/rules",
      ),
  });
  const previewQuery = useQuery<DropshipAdminCatalogExposurePreviewResponse>({
    queryKey: [previewUrl],
    queryFn: () =>
      fetchJson<DropshipAdminCatalogExposurePreviewResponse>(previewUrl),
  });
  const productLinesQuery = useQuery<DropshipProductLineOption[]>({
    queryKey: ["/api/product-lines", "active"],
    queryFn: () =>
      fetchJson<DropshipProductLineOption[]>(
        "/api/product-lines?status=active",
      ),
  });
  const categoriesQuery = useQuery<DropshipProductCategoryOption[]>({
    queryKey: ["/api/product-categories"],
    queryFn: () =>
      fetchJson<DropshipProductCategoryOption[]>("/api/product-categories"),
  });
  const productsQuery = useQuery<DropshipProductOption[]>({
    queryKey: ["/api/products", "active-options"],
    queryFn: () => fetchJson<DropshipProductOption[]>("/api/products"),
  });
  const variantsQuery = useQuery<DropshipProductVariantOption[]>({
    queryKey: ["/api/product-variants", "active-options"],
    queryFn: () =>
      fetchJson<DropshipProductVariantOption[]>("/api/product-variants"),
  });

  const previewRows = previewQuery.data?.rows ?? [];
  const previewTotal = previewQuery.data?.total ?? 0;
  const previewLimit = previewQuery.data?.limit ?? CATALOG_PREVIEW_PAGE_SIZE;
  const previewTotalPages = Math.max(1, Math.ceil(previewTotal / previewLimit));
  const activeRuleInputs = useMemo(
    () =>
      normalizeCatalogRuleOrder(
        (rulesQuery.data?.rules ?? [])
          .filter((rule) => rule.isActive !== false)
          .map(catalogExposureRecordToInput),
      ),
    [rulesQuery.data?.rules],
  );
  const activeRulesKey = useMemo(
    () => catalogExposureRulesStateKey(activeRuleInputs),
    [activeRuleInputs],
  );
  const draftRulesKey = useMemo(
    () => catalogExposureRulesStateKey(draftRules),
    [draftRules],
  );
  const hasUnsavedExposureChanges = draftRulesKey !== activeRulesKey;
  const unsavedExposureRuleCount = hasUnsavedExposureChanges
    ? draftRules.length
    : 0;
  const productLineOptions = useMemo(
    () =>
      (productLinesQuery.data ?? [])
        .filter(
          (line) =>
            line.status === undefined ||
            line.status === null ||
            line.status === "active",
        )
        .sort((first, second) => first.name.localeCompare(second.name)),
    [productLinesQuery.data],
  );
  const categoryOptions = useMemo(
    () =>
      (categoriesQuery.data ?? [])
        .filter((category) => category.isActive !== false)
        .sort((first, second) => first.name.localeCompare(second.name)),
    [categoriesQuery.data],
  );
  const productOptions = useMemo(
    () =>
      (productsQuery.data ?? [])
        .filter((product) =>
          product.status ? product.status === "active" : product.active !== 0,
        )
        .sort((first, second) => {
          const firstSku = first.sku ?? first.baseSku ?? "";
          const secondSku = second.sku ?? second.baseSku ?? "";
          const skuCompare = firstSku.localeCompare(secondSku);
          return skuCompare !== 0
            ? skuCompare
            : first.name.localeCompare(second.name);
        }),
    [productsQuery.data],
  );
  const variantOptions = useMemo(
    () =>
      (variantsQuery.data ?? [])
        .filter((variant) => variant.isActive !== false && variant.active !== 0)
        .sort((first, second) => {
          const skuCompare = (first.sku ?? "").localeCompare(second.sku ?? "");
          if (skuCompare !== 0) return skuCompare;
          const nameCompare = first.name.localeCompare(second.name);
          return nameCompare !== 0 ? nameCompare : first.id - second.id;
        }),
    [variantsQuery.data],
  );
  const catalogRuleTargetLabels = useMemo<CatalogRuleTargetLabels>(
    () => ({
      productLineNamesById: new Map(
        productLineOptions.map((line) => [line.id, line.name]),
      ),
      productLabelsById: new Map(
        productOptions.map((product) => [
          product.id,
          [product.sku ?? product.baseSku, product.name]
            .filter(Boolean)
            .join(" - ") || `Product ${product.id}`,
        ]),
      ),
      variantLabelsById: new Map(
        variantOptions.map((variant) => [
          variant.id,
          [variant.sku, variant.name].filter(Boolean).join(" - ") ||
            `Variant ${variant.id}`,
        ]),
      ),
      categoryLabelsByKey: new Map(
        categoryOptions.map((category) => [
          normalizeCatalogRuleLabelKey(category.name),
          category.name,
        ]),
      ),
    }),
    [categoryOptions, productLineOptions, productOptions, variantOptions],
  );

  useEffect(() => {
    if (!rulesQuery.data) return;
    if (activeRulesKey === loadedRulesKey) return;
    setDraftRules(activeRuleInputs);
    setLoadedRulesKey(activeRulesKey);
  }, [activeRuleInputs, activeRulesKey, loadedRulesKey, rulesQuery.data]);

  useEffect(() => {
    if (!previewQuery.data || previewPage <= previewTotalPages) return;
    setPreviewPage(previewTotalPages);
  }, [previewPage, previewQuery.data, previewTotalPages]);

  function applyCatalogFilters() {
    setAppliedFilters({
      search,
      visibility: visibilityFilter,
      catalogStatus: catalogStatusFilter,
    });
    setPreviewPage(1);
  }

  function applyVisibilityFilter(value: CatalogPreviewVisibilityFilter) {
    setVisibilityFilter(value);
    setAppliedFilters((current) => ({ ...current, visibility: value }));
    setPreviewPage(1);
  }

  function applyCatalogStatusFilter(value: CatalogPreviewStatusFilter) {
    setCatalogStatusFilter(value);
    setAppliedFilters((current) => ({ ...current, catalogStatus: value }));
    setPreviewPage(1);
  }

  function addRuleFromForm() {
    try {
      const rule = buildCatalogExposureRuleInput({
        ...ruleForm,
        priority: draftRules.length,
      });
      upsertDraftRule(rule);
      setRuleDialogOpen(false);
      setRuleForm(emptyCatalogRuleForm);
      setMessage(
        `${catalogExposureActionLabel(rule.action)} ${catalogRuleTargetLabel(rule, catalogRuleTargetLabels)} added to unsaved changes.`,
      );
      setError("");
    } catch (caught) {
      setMessage("");
      setError(
        caught instanceof Error
          ? caught.message
          : "Catalog exposure rule is invalid.",
      );
    }
  }

  function addCatalogWideRule(action: CatalogExposureActionFilter) {
    const rule = buildCatalogExposureRuleInput({
      scopeType: "catalog",
      action,
      priority: draftRules.length,
      notes: `${catalogExposureActionLabel(action)} entire active catalog`,
      metadata: {
        source: "admin_catalog_quick_action",
      },
    });
    upsertDraftRule(rule);
    setMessage(
      `${catalogExposureActionLabel(action)} entire active catalog added to unsaved changes.`,
    );
    setError("");
  }

  function clearDraftRules() {
    setDraftRules(activeRuleInputs);
    setMessage("Unsaved exposure changes reverted.");
    setError("");
  }

  function addPreviewRule(
    row: DropshipAdminCatalogExposurePreviewRow,
    action: CatalogExposureActionFilter,
  ) {
    try {
      const rule = buildCatalogExposureRuleFromPreviewRow({
        row,
        scopeType: "variant",
        action,
      });
      upsertDraftRule({
        ...rule,
        priority: draftRules.length,
        notes:
          rule.notes
            ?.replace(/^Include /, "Expose ")
            .replace(/^Exclude /, "Hide ") ?? rule.notes,
      });
      setMessage(
        `${catalogExposureActionLabel(action)} variant rule added to unsaved changes.`,
      );
      setError("");
    } catch (caught) {
      setMessage("");
      setError(
        caught instanceof Error
          ? caught.message
          : "Catalog exposure rule is invalid.",
      );
    }
  }

  function upsertDraftRule(rule: DropshipAdminCatalogExposureRuleInput) {
    const targetKey = catalogExposureRuleTargetKey(rule);
    setDraftRules((current) => {
      const existingIndex = current.findIndex(
        (existing) => catalogExposureRuleTargetKey(existing) === targetKey,
      );
      if (existingIndex < 0) {
        return normalizeCatalogRuleOrder([...current, rule]);
      }
      return normalizeCatalogRuleOrder(
        current.map((existing, index) =>
          index === existingIndex ? rule : existing,
        ),
      );
    });
  }

  function catalogExposureRuleTargetKey(
    rule: DropshipAdminCatalogExposureRuleInput,
  ): string {
    return [
      rule.scopeType,
      rule.productVariantId ?? "",
      rule.productId ?? "",
      rule.category ?? "",
      rule.productLineId ?? "",
    ].join("|");
  }

  function removeDraftRule(rule: DropshipAdminCatalogExposureRuleInput) {
    const ruleKey = catalogExposureRuleKey(rule);
    setDraftRules((current) =>
      normalizeCatalogRuleOrder(
        current.filter(
          (existing) => catalogExposureRuleKey(existing) !== ruleKey,
        ),
      ),
    );
  }

  function moveDraftRule(
    rule: DropshipAdminCatalogExposureRuleInput,
    direction: -1 | 1,
  ) {
    const ruleKey = catalogExposureRuleKey(rule);
    setDraftRules((current) => {
      const currentIndex = current.findIndex(
        (existing) => catalogExposureRuleKey(existing) === ruleKey,
      );
      const nextIndex = currentIndex + direction;
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= current.length)
        return current;
      const next = [...current];
      [next[currentIndex], next[nextIndex]] = [
        next[nextIndex],
        next[currentIndex],
      ];
      return normalizeCatalogRuleOrder(next);
    });
  }

  async function saveDraftRules() {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const orderedRules = normalizeCatalogRuleOrder(draftRules);
      const orderedRulesKey = catalogExposureRulesStateKey(orderedRules);
      const result =
        await putJson<DropshipAdminCatalogExposureRulesReplaceResponse>(
          "/api/dropship/admin/catalog/rules",
          {
            idempotencyKey: createDropshipIdempotencyKey(
              "admin-catalog-exposure",
            ),
            rules: orderedRules,
          },
        );
      setDraftRules(orderedRules);
      setLoadedRulesKey(orderedRulesKey);
      setMessage(
        `Catalog exposure rules published as revision ${result.revisionId}.`,
      );
      await Promise.all([
        rulesQuery.refetch(),
        previewQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/ops/overview"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/audit-events"],
        }),
      ]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Catalog exposure save failed.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      {(rulesQuery.error || previewQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error ||
              queryErrorMessage(
                rulesQuery.error ?? previewQuery.error,
                "Dropship catalog exposure request failed.",
              )}
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <CatalogMetric
          icon={<Boxes className="h-4 w-4" />}
          label="Active rules"
          value={String(activeRuleInputs.length)}
        />
        <CatalogMetric
          icon={<FileSearch className="h-4 w-4" />}
          label="Unsaved changes"
          value={String(unsavedExposureRuleCount)}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[0.85fr_1.15fr]">
        <section className="rounded-md border bg-card p-4">
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold">Catalog exposure</h2>
              <p className="text-sm text-muted-foreground">
                Publish the catalog vendors can see. Rules run top to bottom,
                and later matching rules override earlier ones.
              </p>
            </div>
            <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              Common setup: expose the entire active catalog first, then add
              hide rules below it for exceptions.
            </div>
            <div className="grid gap-2">
              <Button
                type="button"
                className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
                onClick={() => addCatalogWideRule("include")}
              >
                <PlusCircle className="h-4 w-4" />
                Expose entire active catalog
              </Button>
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                onClick={() => {
                  setRuleForm(emptyCatalogRuleForm);
                  setRuleDialogOpen(true);
                }}
              >
                <PlusCircle className="h-4 w-4" />
                Add exposure rule
              </Button>
            </div>
          </div>
        </section>

        <CatalogDraftRulesTable
          hasUnsavedChanges={hasUnsavedExposureChanges}
          targetLabels={catalogRuleTargetLabels}
          rules={draftRules}
          isLoading={rulesQuery.isLoading}
          isSaving={saving}
          onClearRules={clearDraftRules}
          onMoveRule={moveDraftRule}
          onRemoveRule={removeDraftRule}
          onSaveRules={saveDraftRules}
        />
      </div>

      <CatalogRuleDialog
        open={ruleDialogOpen}
        onOpenChange={setRuleDialogOpen}
        onSubmit={addRuleFromForm}
        categoryOptions={categoryOptions}
        isLoadingCategories={
          categoriesQuery.isLoading || categoriesQuery.isFetching
        }
        isLoadingProductLines={
          productLinesQuery.isLoading || productLinesQuery.isFetching
        }
        isLoadingProducts={productsQuery.isLoading || productsQuery.isFetching}
        isLoadingVariants={variantsQuery.isLoading || variantsQuery.isFetching}
        productLineOptions={productLineOptions}
        productOptions={productOptions}
        ruleForm={ruleForm}
        setRuleForm={setRuleForm}
        variantOptions={variantOptions}
      />

      <section className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Catalog preview</h2>
            <p className="text-sm text-muted-foreground">
              Verify current exposure decisions before vendors select products.
            </p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Search SKU, product, or variant"
              />
            </div>
            <Select
              value={visibilityFilter}
              onValueChange={(value) =>
                applyVisibilityFilter(value as CatalogPreviewVisibilityFilter)
              }
            >
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All visibility</SelectItem>
                <SelectItem value="visible">Visible only</SelectItem>
                <SelectItem value="hidden">Hidden only</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={catalogStatusFilter}
              onValueChange={(value) =>
                applyCatalogStatusFilter(value as CatalogPreviewStatusFilter)
              }
            >
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active only</SelectItem>
                <SelectItem value="inactive">Inactive only</SelectItem>
                <SelectItem value="all">Both</SelectItem>
              </SelectContent>
            </Select>
            <Button
              className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
              onClick={applyCatalogFilters}
            >
              <FileSearch className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>

        <CatalogPreviewTable
          isLoading={previewQuery.isLoading || previewQuery.isFetching}
          limit={previewLimit}
          page={previewQuery.data?.page ?? previewPage}
          rows={previewRows}
          total={previewTotal}
          totalPages={previewTotalPages}
          onAddPreviewRule={addPreviewRule}
          onPageChange={setPreviewPage}
        />
      </section>
    </div>
  );
}

function CatalogRuleTargetInput({
  categoryOptions,
  isLoadingCategories,
  isLoadingProductLines,
  isLoadingProducts,
  isLoadingVariants,
  productLineOptions,
  productOptions,
  ruleForm,
  setRuleForm,
  variantOptions,
}: {
  categoryOptions: DropshipProductCategoryOption[];
  isLoadingCategories: boolean;
  isLoadingProductLines: boolean;
  isLoadingProducts: boolean;
  isLoadingVariants: boolean;
  productLineOptions: DropshipProductLineOption[];
  productOptions: DropshipProductOption[];
  ruleForm: CatalogRuleFormState;
  setRuleForm: Dispatch<SetStateAction<CatalogRuleFormState>>;
  variantOptions: DropshipProductVariantOption[];
}) {
  if (ruleForm.scopeType === "catalog") return null;

  if (ruleForm.scopeType === "product_line") {
    return (
      <SearchableOptionPicker
        label="Product line"
        value={ruleForm.productLineId}
        onChange={(value) =>
          setRuleForm((current) => ({ ...current, productLineId: value }))
        }
        options={productLineOptions.map((line) => ({
          value: String(line.id),
          label: line.name,
          detail:
            typeof line.productCount === "number"
              ? `${line.productCount} product${line.productCount === 1 ? "" : "s"}`
              : undefined,
          search: `${line.name} ${line.id}`,
        }))}
        isLoading={isLoadingProductLines}
        placeholder="Select product line"
        searchPlaceholder="Search product lines..."
        emptyText="No product lines found."
      />
    );
  }

  if (ruleForm.scopeType === "product") {
    return (
      <SearchableOptionPicker
        label="Product"
        value={ruleForm.productId}
        onChange={(value) =>
          setRuleForm((current) => ({ ...current, productId: value }))
        }
        options={productOptions.map((product) => {
          const sku = product.sku ?? product.baseSku ?? "";
          return {
            value: String(product.id),
            label: product.name,
            detail: sku || undefined,
            search: `${product.name} ${sku} ${product.id}`,
          };
        })}
        isLoading={isLoadingProducts}
        placeholder="Select product"
        searchPlaceholder="Search product or SKU..."
        emptyText="No products found."
      />
    );
  }

  if (ruleForm.scopeType === "variant") {
    return (
      <ProductVariantSkuPicker
        isLoading={isLoadingVariants}
        label="SKU / variant"
        onChange={(value) =>
          setRuleForm((current) => ({ ...current, productVariantId: value }))
        }
        value={ruleForm.productVariantId}
        variants={variantOptions}
      />
    );
  }

  return (
    <SearchableOptionPicker
      label="Category"
      value={ruleForm.category}
      onChange={(value) =>
        setRuleForm((current) => ({ ...current, category: value }))
      }
      options={categoryOptions.map((category) => ({
        value: category.name,
        label: category.name,
        detail:
          typeof category.productCount === "number"
            ? `${category.productCount} product${category.productCount === 1 ? "" : "s"}`
            : undefined,
        search: `${category.name} ${category.id}`,
      }))}
      isLoading={isLoadingCategories}
      placeholder="Select category"
      searchPlaceholder="Search categories..."
      emptyText="No categories found."
    />
  );
}

function CatalogRuleDialog({
  categoryOptions,
  isLoadingCategories,
  isLoadingProductLines,
  isLoadingProducts,
  isLoadingVariants,
  onOpenChange,
  onSubmit,
  open,
  productLineOptions,
  productOptions,
  ruleForm,
  setRuleForm,
  variantOptions,
}: {
  categoryOptions: DropshipProductCategoryOption[];
  isLoadingCategories: boolean;
  isLoadingProductLines: boolean;
  isLoadingProducts: boolean;
  isLoadingVariants: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
  open: boolean;
  productLineOptions: DropshipProductLineOption[];
  productOptions: DropshipProductOption[];
  ruleForm: CatalogRuleFormState;
  setRuleForm: Dispatch<SetStateAction<CatalogRuleFormState>>;
  variantOptions: DropshipProductVariantOption[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add exposure rule</DialogTitle>
            <DialogDescription>
              Add a broad rule or an exception. Place exceptions lower in the
              run order when they should override broader rules.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="text-sm font-medium">Scope</label>
              <Select
                value={ruleForm.scopeType}
                onValueChange={(value) =>
                  setRuleForm((current) => ({
                    ...current,
                    scopeType: value as CatalogExposureScopeFilter,
                  }))
                }
              >
                <SelectTrigger className="mt-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="catalog">Entire catalog</SelectItem>
                  <SelectItem value="product_line">Product line</SelectItem>
                  <SelectItem value="category">Category</SelectItem>
                  <SelectItem value="product">Product</SelectItem>
                  <SelectItem value="variant">Variant</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">Action</label>
              <Select
                value={ruleForm.action}
                onValueChange={(value) =>
                  setRuleForm((current) => ({
                    ...current,
                    action: value as CatalogExposureActionFilter,
                  }))
                }
              >
                <SelectTrigger className="mt-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="include">Expose</SelectItem>
                  <SelectItem value="exclude">Hide</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <CatalogRuleTargetInput
              categoryOptions={categoryOptions}
              isLoadingCategories={isLoadingCategories}
              isLoadingProductLines={isLoadingProductLines}
              isLoadingProducts={isLoadingProducts}
              isLoadingVariants={isLoadingVariants}
              productLineOptions={productLineOptions}
              productOptions={productOptions}
              ruleForm={ruleForm}
              setRuleForm={setRuleForm}
              variantOptions={variantOptions}
            />

            <div className="md:col-span-2">
              <label
                className="text-sm font-medium"
                htmlFor="dropship-catalog-rule-notes"
              >
                Notes
              </label>
              <Input
                id="dropship-catalog-rule-notes"
                className="mt-2"
                value={ruleForm.notes}
                onChange={(event) =>
                  setRuleForm((current) => ({
                    ...current,
                    notes: event.target.value,
                  }))
                }
                placeholder="Optional admin note"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
            >
              <PlusCircle className="h-4 w-4" />
              Add exposure rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CatalogDraftRulesTable({
  hasUnsavedChanges,
  isLoading,
  isSaving,
  onClearRules,
  onMoveRule,
  onRemoveRule,
  onSaveRules,
  rules,
  targetLabels,
}: {
  hasUnsavedChanges: boolean;
  isLoading: boolean;
  isSaving: boolean;
  onClearRules: () => void;
  onMoveRule: (
    rule: DropshipAdminCatalogExposureRuleInput,
    direction: -1 | 1,
  ) => void;
  onRemoveRule: (rule: DropshipAdminCatalogExposureRuleInput) => void;
  onSaveRules: () => void;
  rules: DropshipAdminCatalogExposureRuleInput[];
  targetLabels: CatalogRuleTargetLabels;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Exposure rule set</h2>
          <p className="text-sm text-muted-foreground">
            {hasUnsavedChanges
              ? "Unpublished changes are staged. Publishing replaces the active admin exposure rules."
              : "Published rules are loaded. Editing this set creates unpublished changes."}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Badge variant="outline">
            {hasUnsavedChanges ? `${rules.length} unsaved` : "Published"}
          </Badge>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-2"
            disabled={isSaving || !hasUnsavedChanges}
            onClick={onClearRules}
          >
            <MinusCircle className="h-4 w-4" />
            Clear changes
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
            disabled={isSaving || !hasUnsavedChanges || rules.length === 0}
            onClick={onSaveRules}
          >
            <Save className="h-4 w-4" />
            {isSaving ? "Publishing" : "Publish"}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : rules.length === 0 ? (
        <Empty className="mt-4 rounded-md border border-dashed p-8">
          <EmptyMedia variant="icon">
            <Boxes />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No exposure rules</EmptyTitle>
            <EmptyDescription>
              Add an exposure rule before publishing. No catalog is visible
              without at least one expose rule.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="mt-4 rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[96px]">Run order</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-[168px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule, index) => (
                <TableRow key={catalogExposureRuleKey(rule)}>
                  <TableCell className="font-mono text-sm">
                    #{index + 1}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={catalogExposureActionTone(rule.action)}
                    >
                      {catalogExposureActionLabel(rule.action)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">
                      {formatStatus(rule.scopeType)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {catalogRuleTargetLabel(rule, targetLabels)}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[260px] truncate text-sm text-muted-foreground">
                    {rule.notes || "None"}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        disabled={index === 0}
                        title="Move up"
                        onClick={() => onMoveRule(rule, -1)}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        disabled={index === rules.length - 1}
                        title="Move down"
                        onClick={() => onMoveRule(rule, 1)}
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 gap-2"
                        onClick={() => onRemoveRule(rule)}
                      >
                        <MinusCircle className="h-4 w-4" />
                        Remove
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function CatalogPreviewTable({
  isLoading,
  limit,
  onAddPreviewRule,
  onPageChange,
  page,
  rows,
  total,
  totalPages,
}: {
  isLoading: boolean;
  limit: number;
  onAddPreviewRule: (
    row: DropshipAdminCatalogExposurePreviewRow,
    action: CatalogExposureActionFilter,
  ) => void;
  onPageChange: (page: number) => void;
  page: number;
  rows: DropshipAdminCatalogExposurePreviewRow[];
  total: number;
  totalPages: number;
}) {
  if (isLoading) {
    return (
      <div className="mt-4 space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <Empty className="mt-4 rounded-md border border-dashed p-8">
        <EmptyMedia variant="icon">
          <FileSearch />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No catalog rows</EmptyTitle>
          <EmptyDescription>
            No catalog preview rows match the current filters.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const firstRow = total === 0 ? 0 : (page - 1) * limit + 1;
  const lastRow = Math.min(total, firstRow + rows.length - 1);

  return (
    <div className="mt-4 rounded-md border">
      <div className="flex items-center justify-between border-b px-3 py-2 text-sm text-muted-foreground">
        <span>
          Showing {firstRow}-{lastRow} of {total} row{total === 1 ? "" : "s"}
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Catalog row</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Vendor visibility</TableHead>
            <TableHead className="w-[180px] text-right">
              Exposure change
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.productVariantId}>
              <TableCell>
                <div className="font-medium">{row.productName}</div>
                <div className="text-xs text-muted-foreground">
                  {[row.productSku, row.variantSku, row.variantName]
                    .filter(Boolean)
                    .join(" / ") || `Variant ${row.productVariantId}`}
                </div>
              </TableCell>
              <TableCell>
                <div>{row.category || "None"}</div>
                <div className="max-w-[220px] truncate text-xs text-muted-foreground">
                  {row.productLineNames.length
                    ? row.productLineNames.join(", ")
                    : "No product line"}
                </div>
              </TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={
                    row.productIsActive && row.variantIsActive
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-amber-200 bg-amber-50 text-amber-900"
                  }
                >
                  {row.productIsActive && row.variantIsActive
                    ? "Active"
                    : "Inactive"}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={
                    row.decision.exposed
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-zinc-200 bg-zinc-50 text-zinc-700"
                  }
                >
                  {row.decision.exposed ? "Visible" : "Hidden"}
                </Badge>
                <div className="mt-1 text-xs text-muted-foreground">
                  {catalogVisibilityReasonLabel(row.decision.reason)}
                </div>
              </TableCell>
              <TableCell>
                <CatalogPreviewQuickRules
                  row={row}
                  onAddPreviewRule={onAddPreviewRule}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex flex-col gap-3 border-t px-3 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>
          Page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-2"
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-2"
            disabled={page >= totalPages}
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function CatalogPreviewQuickRules({
  onAddPreviewRule,
  row,
}: {
  onAddPreviewRule: (
    row: DropshipAdminCatalogExposurePreviewRow,
    action: CatalogExposureActionFilter,
  ) => void;
  row: DropshipAdminCatalogExposurePreviewRow;
}) {
  const action: CatalogExposureActionFilter = row.decision.exposed
    ? "exclude"
    : "include";
  const label = row.decision.exposed ? "Hide" : "Expose";
  const Icon = row.decision.exposed ? MinusCircle : PlusCircle;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="ml-auto h-8 gap-2"
      onClick={() => onAddPreviewRule(row, action)}
    >
      <Icon className="h-4 w-4" />
      {label}
    </Button>
  );
}

function catalogRuleTargetLabel(
  rule: DropshipAdminCatalogExposureRuleInput,
  labels: CatalogRuleTargetLabels,
): string {
  if (rule.scopeType === "catalog") return "Entire active catalog";
  if (rule.scopeType === "product_line") {
    return targetNameLabel(
      "Product line",
      rule.productLineId,
      labels.productLineNamesById,
    );
  }
  if (rule.scopeType === "product") {
    return targetNameLabel("Product", rule.productId, labels.productLabelsById);
  }
  if (rule.scopeType === "variant") {
    return targetNameLabel(
      "Variant",
      rule.productVariantId,
      labels.variantLabelsById,
    );
  }
  if (rule.scopeType === "category") {
    const category = rule.category?.trim();
    if (!category) return "Category not selected";
    return (
      labels.categoryLabelsByKey.get(normalizeCatalogRuleLabelKey(category)) ??
      category
    );
  }
  return "Unknown target";
}

function targetNameLabel(
  prefix: string,
  id: number | null | undefined,
  namesById: Map<number, string>,
): string {
  if (typeof id !== "number") return `${prefix} not selected`;
  const name = namesById.get(id);
  return name ? `${prefix}: ${name}` : `${prefix} #${id}`;
}

function normalizeCatalogRuleLabelKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeCatalogRuleOrder(
  rules: DropshipAdminCatalogExposureRuleInput[],
): DropshipAdminCatalogExposureRuleInput[] {
  return rules.map((rule, index) => ({
    ...rule,
    priority: index,
  }));
}

function catalogExposureRulesStateKey(
  rules: DropshipAdminCatalogExposureRuleInput[],
): string {
  return rules
    .map(
      (rule, index) =>
        `${index}:${catalogExposureRuleKey(rule)}:${rule.priority}:${rule.notes ?? ""}`,
    )
    .join("|");
}

function catalogExposureActionLabel(
  action: CatalogExposureActionFilter,
): string {
  return action === "include" ? "Expose" : "Hide";
}

function catalogExposureActionTone(
  action: CatalogExposureActionFilter,
): string {
  if (action === "include")
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  return "border-rose-200 bg-rose-50 text-rose-800";
}

function catalogVisibilityReasonLabel(reason: string): string {
  if (reason === "exposed") return "Allowed by exposure rule";
  if (reason === "excluded_by_admin_rule") return "Hidden by exposure rule";
  if (reason === "inactive_product_or_variant")
    return "Inactive product or variant";
  if (reason === "missing_include_rule") return "No exposure rule";
  return formatStatus(reason);
}

export {
  CATALOG_PREVIEW_PAGE_SIZE,
  emptyCatalogRuleForm,
  CatalogExposureTab,
  CatalogRuleTargetInput,
  CatalogRuleDialog,
  CatalogDraftRulesTable,
  CatalogPreviewTable,
  CatalogPreviewQuickRules,
  catalogRuleTargetLabel,
  targetNameLabel,
  normalizeCatalogRuleLabelKey,
  normalizeCatalogRuleOrder,
  catalogExposureRulesStateKey,
  catalogExposureActionLabel,
  catalogExposureActionTone,
  catalogVisibilityReasonLabel,
  CatalogMetric,
  type CatalogExposureScopeFilter,
  type CatalogExposureActionFilter,
  type CatalogPreviewVisibilityFilter,
  type CatalogPreviewStatusFilter,
  type DropshipProductOption,
  type DropshipProductLineOption,
  type DropshipProductCategoryOption,
  type CatalogRuleTargetLabels,
  type CatalogRuleFormState,
};
export default CatalogExposureTab;
