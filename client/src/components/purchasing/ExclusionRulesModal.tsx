import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Filter } from "lucide-react";
import {
  DEFAULT_STALE_PO_THRESHOLDS,
  validateCandidateScoreThresholds,
  validateStalePoThresholds,
  type AutoDraftStalePoThresholds,
} from "@/features/purchasing/autoDraftSettingsValidation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { PurchasePlanningPolicyEditor } from "./PurchasePlanningPolicyEditor";
import { PurchasingAutomationGuardrailsTab } from "./planning-policy/PurchasingAutomationGuardrailsTab";
import { PurchasingExclusionRulesTab } from "./planning-policy/PurchasingExclusionRulesTab";
import { PurchasingForecastPolicyTab } from "./planning-policy/PurchasingForecastPolicyTab";
import {
  DEFAULT_FORECAST_POLICY,
  PLANNING_POLICY_TABS,
  mergeForecastPolicy,
  thresholdInputDefaults,
  validateForecastPolicyDraft,
  type AutoDraftSettings,
  type PlanningPolicyTab,
  type PurchasingForecastPolicy,
  type RulesData,
} from "./planning-policy/planningPolicyTypes";

export type { PlanningPolicyTab };

export interface ExclusionRulesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: PlanningPolicyTab;
}

export function ExclusionRulesModal({
  open,
  onOpenChange,
  initialTab,
}: ExclusionRulesModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canAdjustPlanning = hasPermission("inventory", "adjust");

  const [activeTab, setActiveTab] = useState<PlanningPolicyTab>(initialTab ?? "all");
  const [candidateScoreStrongThreshold, setCandidateScoreStrongThreshold] = useState("80");
  const [candidateScoreReviewThreshold, setCandidateScoreReviewThreshold] = useState("60");
  const [stalePoThresholdInputs, setStalePoThresholdInputs] = useState<
    Record<keyof AutoDraftStalePoThresholds, string>
  >(thresholdInputDefaults);
  const [forecastPolicyDraft, setForecastPolicyDraft] =
    useState<PurchasingForecastPolicy>(DEFAULT_FORECAST_POLICY);

  useEffect(() => {
    if (open && initialTab) {
      setActiveTab(initialTab);
    }
  }, [open, initialTab]);

  const { data: rulesData, isLoading: isRulesLoading } = useQuery<RulesData>({
    queryKey: ["/api/purchasing/exclusion-rules"],
    enabled: open,
  });

  const { data: settings } = useQuery<AutoDraftSettings>({
    queryKey: ["/api/purchasing/auto-draft-settings"],
    enabled: open,
  });

  const updateSettingsMutation = useMutation({
    mutationFn: async (updates: Partial<AutoDraftSettings>) => {
      if (!canAdjustPlanning) {
        throw new Error(
          "Inventory adjustment permission is required to change automation settings.",
        );
      }
      const res = await fetch("/api/purchasing/auto-draft-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to update settings");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/auto-draft-settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/reorder-analysis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/rfq-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/auto-draft/stale-pos?limit=25"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to update settings",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    if (!settings) return;
    setCandidateScoreStrongThreshold(String(settings.candidateScoreStrongThreshold ?? 80));
    setCandidateScoreReviewThreshold(String(settings.candidateScoreReviewThreshold ?? 60));
    const stalePoThresholds = {
      ...DEFAULT_STALE_PO_THRESHOLDS,
      ...(settings.stalePoThresholds ?? {}),
    };
    setStalePoThresholdInputs(
      Object.fromEntries(
        Object.entries(stalePoThresholds).map(([key, value]) => [key, String(value)]),
      ) as Record<keyof AutoDraftStalePoThresholds, string>,
    );
    setForecastPolicyDraft(mergeForecastPolicy(settings.forecastPolicy));
  }, [settings]);

  const saveCandidateThresholds = () => {
    const result = validateCandidateScoreThresholds(
      candidateScoreStrongThreshold,
      candidateScoreReviewThreshold,
    );
    if (!result.ok) {
      toast({
        title: result.error.title,
        description: result.error.description,
        variant: "destructive",
      });
      return;
    }
    const {
      candidateScoreStrongThreshold: strongThreshold,
      candidateScoreReviewThreshold: reviewThreshold,
    } = result.value;
    updateSettingsMutation.mutate({
      candidateScoreStrongThreshold: strongThreshold,
      candidateScoreReviewThreshold: reviewThreshold,
    });
  };

  const saveStalePoThresholds = () => {
    const result = validateStalePoThresholds(stalePoThresholdInputs);
    if (!result.ok) {
      toast({
        title: result.error.title,
        description: result.error.description,
        variant: "destructive",
      });
      return;
    }
    updateSettingsMutation.mutate({ stalePoThresholds: result.value });
  };

  const saveForecastPolicy = () => {
    const validation = validateForecastPolicyDraft(forecastPolicyDraft);
    if (!validation.ok) {
      toast({
        title: validation.error.title,
        description: validation.error.description,
        variant: "destructive",
      });
      return;
    }
    updateSettingsMutation.mutate({ forecastPolicy: forecastPolicyDraft });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[780px] max-h-[88vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Filter className="h-4 w-4" />
            Purchasing Planning Policy
          </DialogTitle>
          <DialogDescription>
            Configure stock targets, reorder exclusions, demand forecasting, and automation
            guardrails.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          defaultValue="all"
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as PlanningPolicyTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList
            aria-label="Purchasing planning policy sections"
            className="grid w-full grid-cols-5 shrink-0"
          >
            {PLANNING_POLICY_TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="text-xs">
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
            {(activeTab === "all" || activeTab === "stock-targets") && (
              <div className={activeTab === "all" ? "pb-5" : undefined}>
                <PurchasePlanningPolicyEditor />
              </div>
            )}

            {(activeTab === "all" || activeTab === "exclusions") && (
              <div className={activeTab === "all" ? "border-t pt-5 pb-5" : undefined}>
                <PurchasingExclusionRulesTab
                  open={open}
                  canAdjustPlanning={canAdjustPlanning}
                  rulesData={rulesData}
                  isLoading={isRulesLoading}
                />
              </div>
            )}

            {(activeTab === "all" || activeTab === "forecasting") && (
              <div className={activeTab === "all" ? "border-t pt-5 pb-5" : undefined}>
                <PurchasingForecastPolicyTab
                  canAdjustPlanning={canAdjustPlanning}
                  draft={forecastPolicyDraft}
                  onDraftChange={setForecastPolicyDraft}
                  onSave={saveForecastPolicy}
                  isSaving={updateSettingsMutation.isPending}
                />
              </div>
            )}

            {(activeTab === "all" || activeTab === "automation") && (
              <div className={activeTab === "all" ? "border-t pt-5" : undefined}>
                <PurchasingAutomationGuardrailsTab
                  canAdjustPlanning={canAdjustPlanning}
                  settings={settings}
                  candidateScoreStrongThreshold={candidateScoreStrongThreshold}
                  onCandidateScoreStrongThresholdChange={setCandidateScoreStrongThreshold}
                  candidateScoreReviewThreshold={candidateScoreReviewThreshold}
                  onCandidateScoreReviewThresholdChange={setCandidateScoreReviewThreshold}
                  stalePoThresholdInputs={stalePoThresholdInputs}
                  onStalePoThresholdInputsChange={setStalePoThresholdInputs}
                  onUpdateSettings={(updates) => updateSettingsMutation.mutate(updates)}
                  onSaveCandidateThresholds={saveCandidateThresholds}
                  onSaveStalePoThresholds={saveStalePoThresholds}
                  isSaving={updateSettingsMutation.isPending}
                  onOpenChange={onOpenChange}
                />
              </div>
            )}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
