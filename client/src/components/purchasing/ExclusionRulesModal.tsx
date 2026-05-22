import { useEffect, useState } from "react";
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
  autoDraftMode: "draft_po" | "review_only";
  approvalPolicy: "high_confidence_only" | "high_confidence_and_strong_candidate";
  includeOrderSoon: boolean;
  skipOnOpenPo: boolean;
  skipNoVendor: boolean;
  candidateScoreStrongThreshold: number;
  candidateScoreReviewThreshold: number;
  stalePoThresholds: AutoDraftStalePoThresholds;
}

interface AutoDraftStalePoThresholds {
  reviewPendingWarningDays: number;
  reviewPendingCriticalDays: number;
  supplierSendWarningDays: number;
  supplierSendCriticalDays: number;
  supplierFollowupWarningDays: number;
  supplierFollowupCriticalDays: number;
  receivingWarningDays: number;
  receivingCriticalDays: number;
  apCloseoutWarningDays: number;
  apCloseoutCriticalDays: number;
  exceptionBlockedWarningDays: number;
  exceptionBlockedCriticalDays: number;
  closeoutWarningDays: number;
  closeoutCriticalDays: number;
}

const FIELD_LABELS: Record<string, string> = {
  category: "Category",
  brand: "Brand",
  product_type: "Product Type",
  sku_prefix: "SKU Prefix",
  sku_exact: "SKU (exact)",
  tag: "Tag",
};

const DEFAULT_STALE_PO_THRESHOLDS: AutoDraftStalePoThresholds = {
  reviewPendingWarningDays: 2,
  reviewPendingCriticalDays: 5,
  supplierSendWarningDays: 2,
  supplierSendCriticalDays: 5,
  supplierFollowupWarningDays: 7,
  supplierFollowupCriticalDays: 14,
  receivingWarningDays: 3,
  receivingCriticalDays: 10,
  apCloseoutWarningDays: 7,
  apCloseoutCriticalDays: 21,
  exceptionBlockedWarningDays: 1,
  exceptionBlockedCriticalDays: 3,
  closeoutWarningDays: 7,
  closeoutCriticalDays: 14,
};

const STALE_PO_THRESHOLD_ROWS: Array<{
  label: string;
  warningKey: keyof AutoDraftStalePoThresholds;
  criticalKey: keyof AutoDraftStalePoThresholds;
}> = [
  { label: "Review", warningKey: "reviewPendingWarningDays", criticalKey: "reviewPendingCriticalDays" },
  { label: "Send", warningKey: "supplierSendWarningDays", criticalKey: "supplierSendCriticalDays" },
  { label: "Supplier", warningKey: "supplierFollowupWarningDays", criticalKey: "supplierFollowupCriticalDays" },
  { label: "Receiving", warningKey: "receivingWarningDays", criticalKey: "receivingCriticalDays" },
  { label: "AP", warningKey: "apCloseoutWarningDays", criticalKey: "apCloseoutCriticalDays" },
  { label: "Exceptions", warningKey: "exceptionBlockedWarningDays", criticalKey: "exceptionBlockedCriticalDays" },
  { label: "Closeout", warningKey: "closeoutWarningDays", criticalKey: "closeoutCriticalDays" },
];

function thresholdInputDefaults(): Record<keyof AutoDraftStalePoThresholds, string> {
  return Object.fromEntries(
    Object.entries(DEFAULT_STALE_PO_THRESHOLDS).map(([key, value]) => [key, String(value)]),
  ) as Record<keyof AutoDraftStalePoThresholds, string>;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExclusionRulesModal({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newField, setNewField] = useState("category");
  const [newValue, setNewValue] = useState("");
  const [candidateScoreStrongThreshold, setCandidateScoreStrongThreshold] = useState("80");
  const [candidateScoreReviewThreshold, setCandidateScoreReviewThreshold] = useState("60");
  const [stalePoThresholdInputs, setStalePoThresholdInputs] = useState<Record<keyof AutoDraftStalePoThresholds, string>>(thresholdInputDefaults());

  const { data: rulesData, isLoading } = useQuery<RulesData>({
    queryKey: ["/api/purchasing/exclusion-rules"],
    enabled: open,
  });

  const { data: settings } = useQuery<AutoDraftSettings>({
    queryKey: ["/api/purchasing/auto-draft-settings"],
    enabled: open,
  });

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
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/reorder-analysis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/auto-draft/stale-pos?limit=25"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update settings", description: err.message, variant: "destructive" });
    },
  });

  useEffect(() => {
    if (!settings) return;
    setCandidateScoreStrongThreshold(String(settings.candidateScoreStrongThreshold ?? 80));
    setCandidateScoreReviewThreshold(String(settings.candidateScoreReviewThreshold ?? 60));
    const stalePoThresholds = { ...DEFAULT_STALE_PO_THRESHOLDS, ...(settings.stalePoThresholds ?? {}) };
    setStalePoThresholdInputs(Object.fromEntries(
      Object.entries(stalePoThresholds).map(([key, value]) => [key, String(value)]),
    ) as Record<keyof AutoDraftStalePoThresholds, string>);
  }, [settings]);

  const handleAddRule = () => {
    if (!newValue.trim()) return;
    addRuleMutation.mutate({ field: newField, value: newValue.trim() });
  };

  const saveCandidateThresholds = () => {
    const strongThreshold = Number(candidateScoreStrongThreshold);
    const reviewThreshold = Number(candidateScoreReviewThreshold);
    if (!Number.isInteger(strongThreshold) || strongThreshold < 0 || strongThreshold > 100) {
      toast({ title: "Invalid strong threshold", description: "Use a whole number from 0 to 100.", variant: "destructive" });
      return;
    }
    if (!Number.isInteger(reviewThreshold) || reviewThreshold < 0 || reviewThreshold > 100) {
      toast({ title: "Invalid review threshold", description: "Use a whole number from 0 to 100.", variant: "destructive" });
      return;
    }
    if (reviewThreshold > strongThreshold) {
      toast({
        title: "Invalid thresholds",
        description: "Review threshold must be less than or equal to the strong threshold.",
        variant: "destructive",
      });
      return;
    }
    updateSettingsMutation.mutate({
      candidateScoreStrongThreshold: strongThreshold,
      candidateScoreReviewThreshold: reviewThreshold,
    });
  };

  const saveStalePoThresholds = () => {
    const parsed = {} as AutoDraftStalePoThresholds;
    for (const key of Object.keys(DEFAULT_STALE_PO_THRESHOLDS) as Array<keyof AutoDraftStalePoThresholds>) {
      const value = Number(stalePoThresholdInputs[key]);
      if (!Number.isInteger(value) || value < 0 || value > 365) {
        toast({ title: "Invalid stale PO threshold", description: "Use whole days from 0 to 365.", variant: "destructive" });
        return;
      }
      parsed[key] = value;
    }
    for (const row of STALE_PO_THRESHOLD_ROWS) {
      if (parsed[row.warningKey] > parsed[row.criticalKey]) {
        toast({
          title: "Invalid stale PO thresholds",
          description: `${row.label} warning days must be less than or equal to critical days.`,
          variant: "destructive",
        });
        return;
      }
    }
    updateSettingsMutation.mutate({ stalePoThresholds: parsed });
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
                  <Select value={newField} onValueChange={(v) => { setNewField(v); setNewValue(""); }}>
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
                  <Select value={newValue} onValueChange={setNewValue}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder={`Select ${FIELD_LABELS[newField] || newField}...`} />
                    </SelectTrigger>
                    <SelectContent className="max-h-[200px]">
                      {(fieldValues?.values || []).map((v) => (
                        <SelectItem key={v} value={v}>{v}</SelectItem>
                      ))}
                      {(!fieldValues?.values || fieldValues.values.length === 0) && (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">No values found</div>
                      )}
                    </SelectContent>
                  </Select>
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
              <div>
                <h4 className="text-sm font-medium mb-1">Run mode</h4>
                <p className="text-[11px] text-muted-foreground mb-2">
                  Create draft POs only uses recommendations that pass the quality gate. Recommendation only records an auditable run without PO changes.
                </p>
                <Select
                  value={settings?.autoDraftMode ?? "draft_po"}
                  onValueChange={(v) => updateSettingsMutation.mutate({ autoDraftMode: v as AutoDraftSettings["autoDraftMode"] })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft_po">Create draft POs</SelectItem>
                    <SelectItem value="review_only">Recommendation only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="rounded-md border bg-muted/40 p-3">
                <h4 className="text-sm font-medium mb-1">Approval policy</h4>
                <p className="text-[11px] text-muted-foreground mb-2">
                  Controls which actionable recommendations are allowed to create or update draft POs.
                </p>
                <Select
                  value={settings?.approvalPolicy ?? "high_confidence_only"}
                  onValueChange={(value) => updateSettingsMutation.mutate({
                    approvalPolicy: value as AutoDraftSettings["approvalPolicy"],
                  })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="high_confidence_only">High confidence only</SelectItem>
                    <SelectItem value="high_confidence_and_strong_candidate">
                      High confidence + strong candidate
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground mt-2">
                  {settings?.approvalPolicy === "high_confidence_and_strong_candidate"
                    ? "Draft POs require the high-confidence quality gate and the strong candidate score band."
                    : "Draft POs require the high-confidence quality gate. Candidate score stays review-only."}
                </p>
              </div>
              <div className="rounded-md border bg-muted/40 p-3 space-y-3">
                <div>
                  <h4 className="text-sm font-medium">Candidate score thresholds</h4>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Controls strong and review candidate bands. The stricter approval policy also uses the strong band.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[11px] font-semibold text-muted-foreground block mb-1">Review candidate at</label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={candidateScoreReviewThreshold}
                      onChange={(event) => setCandidateScoreReviewThreshold(event.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-muted-foreground block mb-1">Strong candidate at</label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={candidateScoreStrongThreshold}
                      onChange={(event) => setCandidateScoreStrongThreshold(event.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={saveCandidateThresholds}
                    disabled={updateSettingsMutation.isPending}
                  >
                    Save thresholds
                  </Button>
                </div>
              </div>
              <div className="rounded-md border bg-muted/40 p-3 space-y-3">
                <div>
                  <h4 className="text-sm font-medium">Stale PO aging thresholds</h4>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Controls when auto-draft POs appear in stale aging diagnostics. Values are days in the current PO stage.
                  </p>
                </div>
                <div className="space-y-2">
                  <div className="grid grid-cols-[1fr_74px_74px] gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <span>Stage</span>
                    <span>Warn</span>
                    <span>Critical</span>
                  </div>
                  {STALE_PO_THRESHOLD_ROWS.map((row) => (
                    <div key={row.label} className="grid grid-cols-[1fr_74px_74px] gap-2 items-center">
                      <span className="text-xs font-medium">{row.label}</span>
                      <Input
                        type="number"
                        min={0}
                        max={365}
                        step={1}
                        value={stalePoThresholdInputs[row.warningKey]}
                        onChange={(event) => setStalePoThresholdInputs((current) => ({
                          ...current,
                          [row.warningKey]: event.target.value,
                        }))}
                        className="h-8 text-xs"
                      />
                      <Input
                        type="number"
                        min={0}
                        max={365}
                        step={1}
                        value={stalePoThresholdInputs[row.criticalKey]}
                        onChange={(event) => setStalePoThresholdInputs((current) => ({
                          ...current,
                          [row.criticalKey]: event.target.value,
                        }))}
                        className="h-8 text-xs"
                      />
                    </div>
                  ))}
                </div>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={saveStalePoThresholds}
                    disabled={updateSettingsMutation.isPending}
                  >
                    Save aging thresholds
                  </Button>
                </div>
              </div>
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
