import React, { type Dispatch, type SetStateAction } from "react";
import { Link } from "wouter";
import { ArrowUpRight } from "lucide-react";
import {
  STALE_PO_THRESHOLD_ROWS,
  type AutoDraftStalePoThresholds,
} from "@/features/purchasing/autoDraftSettingsValidation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  PLANNING_ADJUST_PERMISSION_MESSAGE,
  type AutoDraftSettings,
} from "./planningPolicyTypes";

export interface PurchasingAutomationGuardrailsTabProps {
  canAdjustPlanning: boolean;
  settings: AutoDraftSettings | undefined;
  candidateScoreStrongThreshold: string;
  onCandidateScoreStrongThresholdChange: (value: string) => void;
  candidateScoreReviewThreshold: string;
  onCandidateScoreReviewThresholdChange: (value: string) => void;
  stalePoThresholdInputs: Record<keyof AutoDraftStalePoThresholds, string>;
  onStalePoThresholdInputsChange: Dispatch<
    SetStateAction<Record<keyof AutoDraftStalePoThresholds, string>>
  >;
  onUpdateSettings: (updates: Partial<AutoDraftSettings>) => void;
  onSaveCandidateThresholds: () => void;
  onSaveStalePoThresholds: () => void;
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PurchasingAutomationGuardrailsTab({
  canAdjustPlanning,
  settings,
  candidateScoreStrongThreshold,
  onCandidateScoreStrongThresholdChange,
  candidateScoreReviewThreshold,
  onCandidateScoreReviewThresholdChange,
  stalePoThresholdInputs,
  onStalePoThresholdInputsChange,
  onUpdateSettings,
  onSaveCandidateThresholds,
  onSaveStalePoThresholds,
  isSaving,
  onOpenChange,
}: PurchasingAutomationGuardrailsTabProps) {
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-0.5">
          <div className="text-xs font-semibold">Automation Workspace</div>
          <p className="text-xs text-muted-foreground">
            Full recommendation review queues and auto-draft run controls live on{" "}
            <code className="text-[11px]">/procurement/automation</code>.
          </p>
        </div>
        <Link
          href="/procurement/automation"
          onClick={() => onOpenChange(false)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          Open Automation
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      {!canAdjustPlanning && (
        <p className="text-sm text-muted-foreground">{PLANNING_ADJUST_PERMISSION_MESSAGE}</p>
      )}

      <fieldset disabled={!canAdjustPlanning} className="space-y-5">
        <div className="space-y-3">
          <div>
            <span className="text-xs font-semibold block">RFQ Draft Automation</span>
            <p className="text-[11px] text-muted-foreground mt-1">
              Scheduled recommendation runs can prepare price-free RFQ drafts for trusted
              requirements with an existing preferred supplier. Drafts are never sent automatically.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 rounded-md border bg-muted/40 p-3 sm:grid-cols-2">
            <div>
              <label className="text-[10px] text-muted-foreground block mb-1">Draft mode</label>
              <Select
                value={settings?.rfqDraftAutomationMode ?? "manual"}
                onValueChange={(value) =>
                  onUpdateSettings({
                    rfqDraftAutomationMode: value as AutoDraftSettings["rfqDraftAutomationMode"],
                  })
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual selection only</SelectItem>
                  <SelectItem value="preferred_vendor">Draft for preferred suppliers</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-1">
                Minimum demand confidence
              </label>
              <Select
                value={settings?.rfqDraftMinimumConfidence ?? "high"}
                onValueChange={(value) =>
                  onUpdateSettings({
                    rfqDraftMinimumConfidence:
                      value as AutoDraftSettings["rfqDraftMinimumConfidence"],
                  })
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="high">High only</SelectItem>
                  <SelectItem value="medium">Medium or high</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-1">
                Maximum lines per run
              </label>
              <Select
                value={String(settings?.rfqDraftMaximumLinesPerRun ?? 100)}
                onValueChange={(value) =>
                  onUpdateSettings({ rfqDraftMaximumLinesPerRun: Number(value) })
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[25, 50, 100, 250, 500].map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {value} lines
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border bg-background px-3 py-2">
              <div>
                <div className="text-xs font-medium">Require trusted forecast</div>
                <p className="text-[10px] text-muted-foreground">
                  Hold watch/review demand signals for an operator.
                </p>
              </div>
              <Switch
                checked={settings?.rfqDraftRequireTrustedForecast ?? true}
                onCheckedChange={(value) =>
                  onUpdateSettings({ rfqDraftRequireTrustedForecast: value })
                }
              />
            </div>
          </div>
        </div>

        <div className="border-t" />

        <div>
          <span className="text-xs font-semibold block">Downstream Priced-PO Automation</span>
          <p className="text-[11px] text-muted-foreground mt-1 mb-3">
            RFQ requirements are always calculated without price. These controls apply only after a
            supplier and usable quote exist.
          </p>
          <div className="space-y-3">
            <div>
              <h4 className="text-sm font-medium mb-1">Run mode</h4>
              <p className="text-[11px] text-muted-foreground mb-2">
                Create draft POs only for priced recommendations that pass the quality gate.
                Recommendation only records an auditable run without PO changes.
              </p>
              <Select
                value={settings?.autoDraftMode ?? "draft_po"}
                onValueChange={(value) =>
                  onUpdateSettings({
                    autoDraftMode: value as AutoDraftSettings["autoDraftMode"],
                  })
                }
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
                onValueChange={(value) =>
                  onUpdateSettings({
                    approvalPolicy: value as AutoDraftSettings["approvalPolicy"],
                  })
                }
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
                  Controls strong and review candidate bands. The stricter approval policy also uses
                  the strong band.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] font-semibold text-muted-foreground block mb-1">
                    Review candidate at
                  </label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={candidateScoreReviewThreshold}
                    onChange={(event) => onCandidateScoreReviewThresholdChange(event.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-muted-foreground block mb-1">
                    Strong candidate at
                  </label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={candidateScoreStrongThreshold}
                    onChange={(event) => onCandidateScoreStrongThresholdChange(event.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={onSaveCandidateThresholds}
                  disabled={isSaving}
                >
                  Save thresholds
                </Button>
              </div>
            </div>
            <div className="rounded-md border bg-muted/40 p-3 space-y-3">
              <div>
                <h4 className="text-sm font-medium">Stale PO aging thresholds</h4>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Controls when auto-draft POs appear in stale aging diagnostics. Values are days in
                  the current PO stage.
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
                      onChange={(event) =>
                        onStalePoThresholdInputsChange((current) => ({
                          ...current,
                          [row.warningKey]: event.target.value,
                        }))
                      }
                      className="h-8 text-xs"
                    />
                    <Input
                      type="number"
                      min={0}
                      max={365}
                      step={1}
                      value={stalePoThresholdInputs[row.criticalKey]}
                      onChange={(event) =>
                        onStalePoThresholdInputsChange((current) => ({
                          ...current,
                          [row.criticalKey]: event.target.value,
                        }))
                      }
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
                  onClick={onSaveStalePoThresholds}
                  disabled={isSaving}
                >
                  Save aging thresholds
                </Button>
              </div>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <h4 className="text-sm font-medium">Include "Order Soon" items in auto-draft</h4>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Default: only Order Now and Stockout. Enable to also draft Order Soon items.
                </p>
              </div>
              <Switch
                checked={settings?.includeOrderSoon ?? false}
                onCheckedChange={(value) => onUpdateSettings({ includeOrderSoon: value })}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <h4 className="text-sm font-medium">Skip items already on an open PO</h4>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Recommended on. Prevents duplicate orders when a PO is already sent/acknowledged.
                </p>
              </div>
              <Switch
                checked={settings?.skipOnOpenPo ?? true}
                onCheckedChange={(value) => onUpdateSettings({ skipOnOpenPo: value })}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <h4 className="text-sm font-medium">Skip items with no preferred vendor</h4>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  When off, unassigned items go to a catch-all "Unassigned" draft PO instead of
                  being skipped.
                </p>
              </div>
              <Switch
                checked={settings?.skipNoVendor ?? true}
                onCheckedChange={(value) => onUpdateSettings({ skipNoVendor: value })}
              />
            </div>
          </div>
        </div>
      </fieldset>
    </div>
  );
}
