/**
 * AspectEditor — Reusable eBay Item Specifics editor.
 *
 * Used in two contexts:
 * 1. Category Mapping — editing type-level defaults
 * 2. Listing Feed — editing per-product overrides
 *
 * Shows required aspects first (red asterisk), then recommended.
 * SELECTION_ONLY → dropdown, FREE_TEXT → input with optional suggestions.
 */

import React, { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Save,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Sparkles,
} from "lucide-react";

// ============================================================================
// Types
// ============================================================================

interface Aspect {
  name: string;
  required: boolean;
  mode: string; // FREE_TEXT | SELECTION_ONLY
  usage: string; // REQUIRED | RECOMMENDED
  values: string[] | null;
  order: number;
}

interface AspectEditorProps {
  /** eBay browse category ID to fetch aspects for */
  categoryId: string;
  /** Mode: "type" for type defaults, "product" for product overrides */
  mode: "type" | "product";
  /** Product type slug (for type mode) */
  productTypeSlug?: string;
  /** Product ID (for product mode) */
  productId?: number;
  /** Type defaults to show effective values in product mode */
  typeDefaults?: Record<string, string>;
  /** Compact layout for inline use */
  compact?: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function AspectEditor({
  categoryId,
  mode,
  productTypeSlug,
  productId,
  typeDefaults,
  compact = false,
}: AspectEditorProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [localValues, setLocalValues] = useState<Record<string, string>>({});
  const [isDirty, setIsDirty] = useState(false);
  const [showRecommended, setShowRecommended] = useState(false);

  // Fetch aspect definitions for the category
  const { data: aspectsData, isLoading: aspectsLoading } = useQuery<{
    aspects: Aspect[];
    categoryId: string;
  }>({
    queryKey: ["/api/ebay/category-aspects", categoryId],
    queryFn: async () => {
      const resp = await fetch(`/api/ebay/category-aspects/${encodeURIComponent(categoryId)}`);
      if (!resp.ok) throw new Error("Failed to load aspects");
      return resp.json();
    },
    enabled: !!categoryId,
    staleTime: 5 * 60 * 1000,
  });

  // Fetch saved values
  const savedQueryKey =
    mode === "type"
      ? ["/api/ebay/type-aspect-defaults", productTypeSlug]
      : ["/api/ebay/product-aspects", productId];

  const { data: savedData, isLoading: savedLoading } = useQuery<{
    defaults?: Record<string, string>;
    overrides?: Record<string, string>;
  }>({
    queryKey: savedQueryKey,
    queryFn: async () => {
      const path =
        mode === "type"
          ? `/api/ebay/type-aspect-defaults/${encodeURIComponent(productTypeSlug!)}`
          : `/api/ebay/product-aspects/${productId}`;
      const resp = await fetch(path);
      if (!resp.ok) throw new Error("Failed to load saved values");
      return resp.json();
    },
    enabled:
      mode === "type" ? !!productTypeSlug : !!productId,
    staleTime: 30 * 1000,
  });

  // Sync saved values into local state
  useEffect(() => {
    if (!isDirty) {
      const saved =
        mode === "type"
          ? savedData?.defaults || {}
          : savedData?.overrides || {};
      setLocalValues(saved);
    }
  }, [savedData, isDirty, mode]);

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      // Validate values against allowed values for each aspect
      const invalid: string[] = [];
      for (const [name, value] of Object.entries(localValues)) {
        if (!value) continue;
        const aspect = aspects.find((a) => a.name === name);
        if (aspect?.mode === "SELECTION_ONLY" && aspect.values?.length > 0) {
          if (!aspect.values.includes(value)) {
            invalid.push(`"${name}" value "${value}" is not allowed for this category`);
          }
        }
      }
      if (invalid.length > 0) {
        throw new Error(invalid.join(". "));
      }

      const path =
        mode === "type"
          ? `/api/ebay/type-aspect-defaults/${encodeURIComponent(productTypeSlug!)}`
          : `/api/ebay/product-aspects/${productId}`;
      const body =
        mode === "type"
          ? { defaults: localValues }
          : { overrides: localValues };
      const resp = await apiRequest("PUT", path, body);
      return resp.json();
    },
    onSuccess: () => {
      toast({ title: "Saved", description: "Item specifics updated." });
      setIsDirty(false);
      queryClient.invalidateQueries({ queryKey: savedQueryKey });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/channel-config"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Error",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const aspects = aspectsData?.aspects || [];
  const requiredAspects = useMemo(
    () => aspects.filter((a) => a.required),
    [aspects],
  );
  const recommendedAspects = useMemo(
    () => aspects.filter((a) => !a.required),
    [aspects],
  );

  // Count how many required aspects are filled
  const requiredFilled = useMemo(() => {
    return requiredAspects.filter((a) => {
      const val = localValues[a.name];
      if (val) return true;
      // In product mode, check type defaults
      if (mode === "product" && typeDefaults?.[a.name]) return true;
      return false;
    }).length;
  }, [requiredAspects, localValues, mode, typeDefaults]);

  const allRequiredFilled = requiredFilled === requiredAspects.length;

  const updateValue = (name: string, value: string) => {
    setLocalValues((prev) => {
      const next = { ...prev };
      if (value === "" || value === "__clear__") {
        delete next[name];
      } else {
        next[name] = value;
      }
      return next;
    });
    setIsDirty(true);
  };

  if (aspectsLoading || savedLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading item specifics...
      </div>
    );
  }

  if (aspects.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-2">
        No item specifics found for this category.
      </div>
    );
  }

  const renderAspectField = (aspect: Aspect) => {
    const value = localValues[aspect.name] || "";
    const effectiveValue =
      mode === "product" && !value && typeDefaults?.[aspect.name]
        ? typeDefaults[aspect.name]
        : "";
    const isInherited = mode === "product" && !value && !!effectiveValue;

    if (
      aspect.mode === "SELECTION_ONLY" &&
      aspect.values &&
      aspect.values.length > 0
    ) {
      return (
        <div key={aspect.name} className="space-y-1">
          <Label className="text-xs flex items-center gap-1">
            {aspect.required && (
              <span className="text-red-500 font-bold">*</span>
            )}
            {aspect.name}
            {isInherited && (
              <Badge
                variant="outline"
                className="text-[10px] px-1 py-0 text-blue-500 border-blue-300 ml-1"
              >
                Type Default
              </Badge>
            )}
          </Label>
          <Select
            value={value || (isInherited ? effectiveValue : "")}
            onValueChange={(v) => updateValue(aspect.name, v)}
          >
            <SelectTrigger
              className={`h-8 text-xs ${
                aspect.required && !value && !effectiveValue
                  ? "border-red-300"
                  : ""
              } ${isInherited ? "text-muted-foreground" : ""}`}
            >
              <SelectValue placeholder="Select..." />
            </SelectTrigger>
            <SelectContent>
              {value && (
                <SelectItem value="__clear__" className="text-xs text-muted-foreground">
                  Clear
                </SelectItem>
              )}
              {aspect.values!.map((v) => (
                <SelectItem key={v} value={v} className="text-xs">
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    }

    // FREE_TEXT — input with datalist suggestions
    const hasValues =
      aspect.values && aspect.values.length > 0;
    const listId = hasValues
      ? `aspect-suggest-${aspect.name.replace(/\s+/g, "-")}`
      : undefined;

    return (
      <div key={aspect.name} className="space-y-1">
        <Label className="text-xs flex items-center gap-1">
          {aspect.required && (
            <span className="text-red-500 font-bold">*</span>
          )}
          {aspect.name}
          {isInherited && (
            <Badge
              variant="outline"
              className="text-[10px] px-1 py-0 text-blue-500 border-blue-300 ml-1"
            >
              Type Default
            </Badge>
          )}
        </Label>
        <Input
          className={`h-8 text-xs ${
            aspect.required && !value && !effectiveValue
              ? "border-red-300"
              : ""
          } ${isInherited && !value ? "text-muted-foreground" : ""}`}
          placeholder={
            isInherited
              ? effectiveValue
              : `Enter ${aspect.name}...`
          }
          value={value}
          onChange={(e) => updateValue(aspect.name, e.target.value)}
          list={listId}
        />
        {hasValues && (
          <datalist id={listId}>
            {aspect.values!.slice(0, 50).map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        )}
      </div>
    );
  };

  return (
    <div className={compact ? "space-y-3" : "space-y-4"}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-medium">Item Specifics</span>
          {requiredAspects.length > 0 && (
            <Badge
              variant={allRequiredFilled ? "default" : "outline"}
              className={`text-xs ${
                allRequiredFilled
                  ? "bg-green-600 hover:bg-green-600"
                  : "text-amber-600 border-amber-300"
              }`}
            >
              {allRequiredFilled ? (
                <CheckCircle2 className="h-3 w-3 mr-1" />
              ) : (
                <AlertCircle className="h-3 w-3 mr-1" />
              )}
              {requiredFilled}/{requiredAspects.length} required
            </Badge>
          )}
        </div>
        {isDirty && (
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <Save className="h-3 w-3 mr-1" />
            )}
            Save
          </Button>
        )}
      </div>

      {/* Required aspects */}
      {requiredAspects.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {requiredAspects.map(renderAspectField)}
        </div>
      )}

      {/* Recommended aspects (collapsible) */}
      {recommendedAspects.length > 0 && (
        <>
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowRecommended(!showRecommended)}
          >
            {showRecommended ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            {showRecommended ? "Hide" : "Show"} recommended (
            {recommendedAspects.length})
          </button>
          {showRecommended && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {recommendedAspects.map(renderAspectField)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
