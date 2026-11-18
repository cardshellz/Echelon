import React, { type Dispatch, type SetStateAction } from "react";
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
  type PurchasingForecastPolicy,
} from "./planningPolicyTypes";

export interface PurchasingForecastPolicyTabProps {
  canAdjustPlanning: boolean;
  draft: PurchasingForecastPolicy;
  onDraftChange: Dispatch<SetStateAction<PurchasingForecastPolicy>>;
  onSave: () => void;
  isSaving: boolean;
}

const DEMAND_WINDOW_FIELDS = [
  ["Short", "shortWindowDays", 1, 60],
  ["Standard", "standardWindowDays", 7, 180],
  ["Long", "longWindowDays", 30, 730],
  ["Last-year period", "seasonalWindowDays", 7, 120],
] as const;

export function PurchasingForecastPolicyTab({
  canAdjustPlanning,
  draft,
  onDraftChange,
  onSave,
  isSaving,
}: PurchasingForecastPolicyTabProps) {
  const weightTotal = Object.values(draft.weights).reduce((sum, value) => sum + value, 0);

  return (
    <div className="space-y-4">
      {!canAdjustPlanning && (
        <p className="text-sm text-muted-foreground">{PLANNING_ADJUST_PERMISSION_MESSAGE}</p>
      )}
      <fieldset disabled={!canAdjustPlanning} className="space-y-3">
        <div>
          <span className="text-xs font-semibold block">Demand Forecast Policy</span>
          <p className="text-[11px] text-muted-foreground mt-1">
            These settings drive the required-piece quantity shown in the RFQ queue. Every RFQ
            stores the applied calculation as immutable evidence.
          </p>
        </div>
        <div className="rounded-md border bg-muted/40 p-3 space-y-4">
          <div>
            <label className="text-[11px] font-semibold text-muted-foreground block mb-1">
              Forecast method
            </label>
            <Select
              value={draft.method}
              onValueChange={(method) =>
                onDraftChange((current) => ({
                  ...current,
                  method: method as PurchasingForecastPolicy["method"],
                }))
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="weighted_blend_v1">Weighted multi-window forecast</SelectItem>
                <SelectItem value="recent_order_velocity_v1">
                  Standard-window velocity only
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <div className="text-xs font-medium mb-2">Demand windows (days)</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {DEMAND_WINDOW_FIELDS.map(([label, key, min, max]) => (
                <div key={key}>
                  <label className="text-[10px] text-muted-foreground block mb-1">{label}</label>
                  <Input
                    type="number"
                    min={min}
                    max={max}
                    step={1}
                    value={draft[key]}
                    onChange={(event) =>
                      onDraftChange((current) => ({
                        ...current,
                        [key]: Number(event.target.value),
                      }))
                    }
                    className="h-8 text-xs"
                  />
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-4 mb-2">
              <div>
                <div className="text-xs font-medium">Same-period-last-year seasonality</div>
                <p className="text-[10px] text-muted-foreground">
                  When history is unavailable, its weight is automatically redistributed.
                </p>
              </div>
              <Switch
                checked={draft.seasonalEnabled}
                onCheckedChange={(seasonalEnabled) =>
                  onDraftChange((current) => ({ ...current, seasonalEnabled }))
                }
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(Object.keys(draft.weights) as Array<keyof PurchasingForecastPolicy["weights"]>).map(
                (key) => (
                  <div key={key}>
                    <label className="text-[10px] capitalize text-muted-foreground block mb-1">
                      {key} weight %
                    </label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={draft.weights[key]}
                      onChange={(event) =>
                        onDraftChange((current) => ({
                          ...current,
                          weights: { ...current.weights, [key]: Number(event.target.value) },
                        }))
                      }
                      className="h-8 text-xs"
                    />
                  </div>
                ),
              )}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">Total: {weightTotal}%</p>
          </div>

          <div className="border-t pt-3 space-y-2">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs font-medium">Future-demand overlays</div>
                <p className="text-[10px] text-muted-foreground">
                  Adds planned drops, preorders, promotions, wholesale commitments, seasonal plans,
                  and manual forecasts.
                </p>
              </div>
              <Switch
                checked={draft.forwardDemandEnabled}
                onCheckedChange={(forwardDemandEnabled) =>
                  onDraftChange((current) => ({ ...current, forwardDemandEnabled }))
                }
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">
                  Horizon days
                </label>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  step={1}
                  value={draft.forwardDemandHorizonDays}
                  onChange={(event) =>
                    onDraftChange((current) => ({
                      ...current,
                      forwardDemandHorizonDays: Number(event.target.value),
                    }))
                  }
                  className="h-8 text-xs"
                />
              </div>
              {(
                Object.keys(draft.forwardDemandConfidenceWeights) as Array<
                  keyof PurchasingForecastPolicy["forwardDemandConfidenceWeights"]
                >
              ).map((key) => (
                <div key={key}>
                  <label className="text-[10px] capitalize text-muted-foreground block mb-1">
                    {key} confidence %
                  </label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={draft.forwardDemandConfidenceWeights[key]}
                    onChange={(event) =>
                      onDraftChange((current) => ({
                        ...current,
                        forwardDemandConfidenceWeights: {
                          ...current.forwardDemandConfidenceWeights,
                          [key]: Number(event.target.value),
                        },
                      }))
                    }
                    className="h-8 text-xs"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="border-t pt-3">
            <div className="text-xs font-medium mb-2">Automation sample guardrail</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">
                  Minimum orders
                </label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={draft.automationMinimumOrderCount}
                  onChange={(event) =>
                    onDraftChange((current) => ({
                      ...current,
                      automationMinimumOrderCount: Number(event.target.value),
                    }))
                  }
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">
                  Minimum active demand days
                </label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={draft.automationMinimumActiveDays}
                  onChange={(event) =>
                    onDraftChange((current) => ({
                      ...current,
                      automationMinimumActiveDays: Number(event.target.value),
                    }))
                  }
                  className="h-8 text-xs"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button size="sm" onClick={onSave} disabled={isSaving}>
              Save forecast policy
            </Button>
          </div>
        </div>
      </fieldset>
    </div>
  );
}
