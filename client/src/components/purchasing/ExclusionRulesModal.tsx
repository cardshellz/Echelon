import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2, Plus, Filter } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ExclusionRule {
  id: number;
  field: string;
  value: string;
  matchCount: number;
  createdAt: string;
}

interface RulesData {
  rules: ExclusionRule[];
  totalExcluded: number;
}

interface AutoDraftSettings {
  includeOrderSoon: boolean;
  skipOnOpenPo: boolean;
  skipNoVendor: boolean;
}

const FIELD_LABELS: Record<string, string> = {
  category: "Category",
  brand: "Brand",
  product_type: "Product Type",
  sku_prefix: "SKU Prefix",
  sku_exact: "SKU (exact)",
  tag: "Tag",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExclusionRulesModal({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newField, setNewField] = useState("category");
  const [newValue, setNewValue] = useState("");

  const { data: rulesData, isLoading } = useQuery<RulesData>({
    queryKey: ["/api/purchasing/exclusion-rules"],
    enabled: open,
  });

  const { data: settings } = useQuery<AutoDraftSettings>({
    queryKey: ["/api/purchasing/auto-draft-settings"],
    enabled: open,
  });

  const addRuleMutation = useMutation({
    mutationFn: async ({ field, value }: { field: string; value: string }) => {
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
      const res = await fetch(`/api/purchasing/exclusion-rules/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete rule");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/exclusion-rules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/dashboard"] });
      toast({ title: "Rule deleted" });
    },
  });

  const updateSettingsMutation = useMutation({
    mutationFn: async (updates: Partial<AutoDraftSettings>) => {
      const res = await fetch("/api/purchasing/auto-draft-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error("Failed to update settings");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/auto-draft-settings"] });
    },
  });

  const handleAddRule = () => {
    if (!newValue.trim()) return;
    addRuleMutation.mutate({ field: newField, value: newValue.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[540px] max-h-[82vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Filter className="h-4 w-4" />
            Reorder Exclusions
          </DialogTitle>
          <DialogDescription>
            Products matching these rules are hidden from reorder analysis and skipped by the nightly auto-draft job.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Active Rules */}
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
              {rulesData?.rules.map((rule) => (
                <div key={rule.id} className="flex items-center gap-2 p-2 bg-muted/50 border rounded-md text-sm">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-[80px] flex-shrink-0">
                    {FIELD_LABELS[rule.field] || rule.field}
                  </span>
                  <span className="flex-1 text-sm">{rule.value}</span>
                  <span className="text-[11px] text-muted-foreground flex-shrink-0">{rule.matchCount} products</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-red-500 hover:bg-red-50"
                    onClick={() => deleteRuleMutation.mutate(rule.id)}
                    disabled={deleteRuleMutation.isPending}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
              {rulesData?.rules.length === 0 && (
                <div className="text-xs text-muted-foreground text-center py-3">No exclusion rules yet</div>
              )}
            </div>
          </div>

          <div className="border-t" />

          {/* Add Rule */}
          <div>
            <span className="text-xs font-semibold block mb-2">Add Rule</span>
            <div className="bg-muted/50 border rounded-md p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] font-semibold text-muted-foreground block mb-1">Match Field</label>
                  <Select value={newField} onValueChange={setNewField}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(FIELD_LABELS).map(([val, label]) => (
                        <SelectItem key={val} value={val}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-muted-foreground block mb-1">Value</label>
                  <Input
                    className="h-8 text-xs"
                    placeholder="e.g. Pokemon"
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAddRule()}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button size="sm" className="h-7 text-xs" onClick={handleAddRule} disabled={!newValue.trim() || addRuleMutation.isPending}>
                  <Plus className="h-3 w-3 mr-1" />
                  Add Rule
                </Button>
              </div>
            </div>
          </div>

          <div className="border-t" />

          {/* Per-Product Note */}
          <div>
            <span className="text-xs font-semibold block mb-1">Per-Product Overrides</span>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Individual products can be excluded from the Reorder Analysis table using the{" "}
              <strong className="text-foreground">⋯ menu → Exclude from reorder</strong> on any row.
              Per-product exclusions are tracked separately and survive rule changes.
            </p>
          </div>

          <div className="border-t" />

          {/* Auto-Draft Toggles */}
          <div>
            <span className="text-xs font-semibold block mb-3">Auto-Draft Behavior</span>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h4 className="text-sm font-medium">Include "Order Soon" items in auto-draft</h4>
                  <p className="text-[11px] text-muted-foreground mt-0.5">Default: only Order Now and Stockout. Enable to also draft Order Soon items.</p>
                </div>
                <Switch
                  checked={settings?.includeOrderSoon ?? false}
                  onCheckedChange={(v) => updateSettingsMutation.mutate({ includeOrderSoon: v })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h4 className="text-sm font-medium">Skip items already on an open PO</h4>
                  <p className="text-[11px] text-muted-foreground mt-0.5">Recommended on. Prevents duplicate orders when a PO is already sent/acknowledged.</p>
                </div>
                <Switch
                  checked={settings?.skipOnOpenPo ?? true}
                  onCheckedChange={(v) => updateSettingsMutation.mutate({ skipOnOpenPo: v })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h4 className="text-sm font-medium">Skip items with no preferred vendor</h4>
                  <p className="text-[11px] text-muted-foreground mt-0.5">When off, unassigned items go to a catch-all "Unassigned" draft PO instead of being skipped.</p>
                </div>
                <Switch
                  checked={settings?.skipNoVendor ?? true}
                  onCheckedChange={(v) => updateSettingsMutation.mutate({ skipNoVendor: v })}
                />
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
