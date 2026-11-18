import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  FIELD_LABELS,
  PLANNING_ADJUST_PERMISSION_MESSAGE,
  type RulesData,
} from "./planningPolicyTypes";

export interface PurchasingExclusionRulesTabProps {
  open: boolean;
  canAdjustPlanning: boolean;
  rulesData: RulesData | undefined;
  isLoading?: boolean;
}

export function PurchasingExclusionRulesTab({
  open,
  canAdjustPlanning,
  rulesData,
  isLoading = false,
}: PurchasingExclusionRulesTabProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newField, setNewField] = useState("category");
  const [newValue, setNewValue] = useState("");

  const { data: fieldValues } = useQuery<{ field: string; values: string[] }>({
    queryKey: ["/api/purchasing/exclusion-rules/field-values", newField],
    queryFn: async () => {
      const res = await fetch(`/api/purchasing/exclusion-rules/field-values?field=${newField}`);
      if (!res.ok) return { field: newField, values: [] };
      return res.json();
    },
    enabled: open,
  });

  const addRuleMutation = useMutation({
    mutationFn: async ({ field, value }: { field: string; value: string }) => {
      if (!canAdjustPlanning) {
        throw new Error("Inventory adjustment permission is required to change exclusions.");
      }
      const res = await fetch("/api/purchasing/exclusion-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field, value }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        if (res.status === 409) throw new Error("Rule already exists");
        throw new Error(err?.error || "Failed to add rule");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/exclusion-rules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/dashboard"] });
      setNewValue("");
      toast({ title: "Rule added" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add rule", description: err.message, variant: "destructive" });
    },
  });

  const deleteRuleMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!canAdjustPlanning) {
        throw new Error("Inventory adjustment permission is required to change exclusions.");
      }
      const res = await fetch(`/api/purchasing/exclusion-rules/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete rule");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/exclusion-rules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/dashboard"] });
      toast({ title: "Rule deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete rule", description: err.message, variant: "destructive" });
    },
  });

  const handleAddRule = () => {
    if (!newValue.trim()) return;
    addRuleMutation.mutate({ field: newField, value: newValue.trim() });
  };

  return (
    <div className="space-y-5">
      {!canAdjustPlanning && (
        <p className="text-sm text-muted-foreground">{PLANNING_ADJUST_PERMISSION_MESSAGE}</p>
      )}
      <fieldset disabled={!canAdjustPlanning} className="space-y-5">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-semibold">Active Rules</span>
            {rulesData && (
              <Badge variant="outline" className="text-[10px] bg-muted text-muted-foreground">
                {rulesData.rules.length} rules · {rulesData.totalExcluded} products excluded
              </Badge>
            )}
          </div>
          <div className="space-y-1.5">
            {isLoading && !rulesData && (
              <div className="text-xs text-muted-foreground text-center py-3">
                Loading exclusion rules...
              </div>
            )}
            {rulesData?.rules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-center gap-2 p-2 bg-muted/50 border rounded-md text-sm"
              >
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-[80px] flex-shrink-0">
                  {FIELD_LABELS[rule.field] || rule.field}
                </span>
                <span className="flex-1 text-sm">{rule.value}</span>
                <span className="text-[11px] text-muted-foreground flex-shrink-0">
                  {rule.matchCount} products
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-red-500 hover:bg-red-50"
                  aria-label={`Delete exclusion rule ${rule.value}`}
                  onClick={() => deleteRuleMutation.mutate(rule.id)}
                  disabled={deleteRuleMutation.isPending}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
            {rulesData?.rules.length === 0 && (
              <div className="text-xs text-muted-foreground text-center py-3">
                No exclusion rules yet
              </div>
            )}
          </div>
        </div>

        <div className="border-t" />

        <div>
          <span className="text-xs font-semibold block mb-2">Add Rule</span>
          <div className="bg-muted/50 border rounded-md p-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] font-semibold text-muted-foreground block mb-1">
                  Match Field
                </label>
                <Select
                  value={newField}
                  onValueChange={(value) => {
                    setNewField(value);
                    setNewValue("");
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(FIELD_LABELS).map(([val, label]) => (
                      <SelectItem key={val} value={val}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[11px] font-semibold text-muted-foreground block mb-1">
                  Value
                </label>
                <Select value={newValue} onValueChange={setNewValue}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder={`Select ${FIELD_LABELS[newField] || newField}...`} />
                  </SelectTrigger>
                  <SelectContent className="max-h-[200px]">
                    {(fieldValues?.values || []).map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                    {(!fieldValues?.values || fieldValues.values.length === 0) && (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        No values found
                      </div>
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={handleAddRule}
                disabled={!newValue.trim() || addRuleMutation.isPending}
              >
                <Plus className="h-3 w-3 mr-1" />
                Add Rule
              </Button>
            </div>
          </div>
        </div>

        <div className="border-t" />

        <div>
          <span className="text-xs font-semibold block mb-1">Per-Product Overrides</span>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Individual products can be excluded from the Reorder Analysis table using the{" "}
            <strong className="text-foreground">⋯ menu → Exclude from reorder</strong> on any row.
            Per-product exclusions are tracked separately and survive rule changes.
          </p>
        </div>
      </fieldset>
    </div>
  );
}
