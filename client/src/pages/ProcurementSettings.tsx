// This page distinguishes settings with runtime consumers from retained options.
// Saved values remain readable even when their feature is unavailable.
import React, { useRef, useState } from "react";
import { procurementSettingsSnapshotSchema as settingsSchema, type ProcurementSettingKey, type ProcurementSettings } from "@shared/procurement/procurement-settings";
import { financialCommandFetchJson, FinancialCommandRequestError } from "@/lib/financial-command";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Settings2 } from "lucide-react";
import { Link } from "wouter";

type SettingsIntent = { key: ProcurementSettingKey; value: boolean; expectedRevision: number; idempotencyKey: string };

type SettingMeta = {
  key: keyof ProcurementSettings;
  label: string;
  description: string;
  category: "Approvals" | "Create & Send" | "Receiving" | "Reconciliation" | "Planning";
  active: boolean; // Enabled only after tracing a current runtime consumer.
};

// Verified consumers are named beside each available option. Retained options
// have storage projections but no behavior consumer; changing them is disabled.
const SETTING_META: SettingMeta[] = [
  {
    // purchasing.service.ts:sendWithLockedEconomics/getMatchingApprovalTierTx
    key: "requireApproval",
    label: "Require approval",
    description:
      "When on, sending a PO at or above a configured approval tier requires an approval that covers its current value. POs without a matching tier can proceed without that extra step.",
    category: "Approvals",
    active: true,
  },
  {
    key: "autoSendOnApprove",
    label: "Auto-send on approve",
    description:
      "This option does not send a purchase or advance its status after approval.",
    category: "Create & Send",
    active: false,
  },
  {
    // PurchaseOrders.tsx:handleNewPoClick/poHref; purchase detail/dashboard links
    key: "useNewPoEditor",
    label: "Use the new PO editor",
    description:
      "Use the full-page editor for new and editable purchase orders. When off, new purchases open in the original dialog.",
    category: "Create & Send",
    active: true,
  },
  {
    // PurchaseOrderEdit.tsx:showIncotermsField. US is always hidden there.
    key: "hideIncotermsDomestic",
    label: "Hide incoterms until supplier country is known",
    description:
      "In the full-page PO editor, hide incoterms while the supplier country is unknown. US suppliers always hide the field; other known countries show it.",
    category: "Create & Send",
    active: true,
  },
  {
    key: "requireAcknowledgeBeforeReceive",
    label: "Require vendor acknowledgement before receive",
    description:
      "This option does not enforce vendor acknowledgement before receiving.",
    category: "Receiving",
    active: false,
  },
  {
    key: "enableShipmentTracking",
    label: "Enable shipment tracking",
    description:
      "This option does not control shipment fields or connect carrier tracking.",
    category: "Receiving",
    active: false,
  },
  {
    key: "autoPutawayLocation",
    label: "Auto-fill putaway location",
    description:
      "This option does not choose or prefill a receiving location.",
    category: "Receiving",
    active: false,
  },
  {
    key: "oneClickReceiveStart",
    label: "One-click start receive",
    description:
      "This option does not start receipts automatically.",
    category: "Receiving",
    active: false,
  },
  {
    key: "autoCloseOnReconcile",
    label: "Auto-close on reconcile",
    description:
      "This option does not close reconciled purchases automatically.",
    category: "Reconciliation",
    active: false,
  },
  {
    // App.tsx:ReorderAnalysisRoute and AppShell.tsx procurement nav label
    key: "useNewReorderCockpit",
    label: "Use the new Reorder Engine cockpit",
    description:
      "Use the Reorder Engine for purchasing recommendations and planning review. When off, Reorder Analysis opens the original page. The original page remains available at /reorder-analysis/legacy.",
    category: "Planning",
    active: true,
  },
];

// Group settings by category for rendering.
const CATEGORY_ORDER: SettingMeta["category"][] = [
  "Approvals",
  "Create & Send",
  "Receiving",
  "Reconciliation",
  "Planning",
];

export default function ProcurementSettings() {
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("settings", "edit");
  const qc = useQueryClient();
  const pendingWrite = useRef(false);
  const [unresolvedIntent, setUnresolvedIntent] = useState<SettingsIntent | null>(null);

  const query = useQuery({
    queryKey: ["/api/settings/procurement"],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/settings/procurement", { credentials: "include", signal });
      if (!res.ok) throw new Error("Failed to load procurement settings");
      return settingsSchema.parse(await res.json());
    },
  });
  // Other screens share this query key and may have populated its cache first.
  const parsedSettings = settingsSchema.safeParse(query.data);
  const settings = parsedSettings.success ? parsedSettings.data : undefined;
  const loadFailed = query.isError || (query.data !== undefined && !parsedSettings.success);

  const patchMutation = useMutation({
    mutationFn: async ({ key, value, expectedRevision, idempotencyKey }: SettingsIntent) => {
      await qc.cancelQueries({ queryKey: ["/api/settings/procurement"] });
      const body = await financialCommandFetchJson<unknown>("/api/settings/procurement", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ key, value, expectedRevision }),
      });
      const parsed = settingsSchema.safeParse(body);
      if (!parsed.success) {
        throw new FinancialCommandRequestError("The saved response was incomplete. Retry the saved change to recover its confirmed result.", {
          status: 200, code: "PROCUREMENT_SETTINGS_RESPONSE_INVALID", retryable: true, ambiguous: true,
        });
      }
      return parsed.data;
    },
    onSuccess: (data) => {
      setUnresolvedIntent(null);
      qc.setQueryData(["/api/settings/procurement"], data);
      // A replay is the original result; another administrator may since have
      // changed policy. Refresh before offering another edit.
      void qc.invalidateQueries({ queryKey: ["/api/settings/procurement"] });
    },
    onError: async (error: Error, intent) => {
      setUnresolvedIntent(error instanceof FinancialCommandRequestError && error.ambiguous ? intent : null);
      toast({ title: "Could not confirm setting change", description: error.message, variant: "destructive" });
      // A failed response might follow a committed write. Read saved state;
      // never leave an optimistic or guessed value displayed as confirmed.
      await qc.invalidateQueries({ queryKey: ["/api/settings/procurement"] });
    },
    onSettled: () => { pendingWrite.current = false; },
  });

  function onToggle(key: keyof ProcurementSettings, next: boolean) {
    const available = SETTING_META.find((meta) => meta.key === key)?.active === true;
    if (!canEdit || !available || !settings || loadFailed || query.isFetching || pendingWrite.current || unresolvedIntent) return;
    pendingWrite.current = true;
    patchMutation.mutate({ key, value: next, expectedRevision: settings.revision, idempotencyKey: crypto.randomUUID() });
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-3xl mx-auto">
      <div>
        <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
          <Settings2 className="h-5 w-5 md:h-6 md:w-6" />
          Procurement Settings
        </h1>
        <p className="text-sm text-muted-foreground">
          Available settings control current purchasing behavior. Saved preferences for unavailable options remain visible below.
        </p>
        {!canEdit && <p className="mt-2 text-sm">Your role has read-only access to these settings.</p>}
      </div>

      {hasPermission("inventory_planning", "view") && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <h2 className="font-semibold">ATP promise safety</h2>
            <p className="text-sm text-muted-foreground">
              Review promise-safety floors and demand evidence. These controls are separate from
              the purchasing reorder buffer (safetyStockDays).
            </p>
            <Button asChild variant="outline">
              <Link href="/settings/procurement/promise-safety">Manage ATP promise safety</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {query.isLoading && <p role="status" className="text-sm">Loading procurement settings…</p>}
      {loadFailed && (
        <div role="alert" className="rounded border p-3 text-sm">
          {settings ? "Settings could not be refreshed. Shown values may be outdated." : "Procurement settings could not be loaded."}
          <Button variant="link" disabled={query.isFetching} onClick={() => query.refetch()}>Retry settings</Button>
        </div>
      )}
      {patchMutation.isPending && <p role="status" className="text-sm">Confirming saved setting…</p>}
      {patchMutation.isError && <p role="alert" className="text-sm text-destructive">The save was not confirmed. Review the current saved value before trying again.</p>}
      {unresolvedIntent && (
        <div className="rounded border p-3 text-sm space-y-2">
          <p>A previous change has an uncertain outcome. Recover that result before making another change.</p>
          <Button disabled={!canEdit || patchMutation.isPending} onClick={() => {
            if (pendingWrite.current) return;
            pendingWrite.current = true;
            patchMutation.mutate(unresolvedIntent);
          }}>Retry saved change</Button>
        </div>
      )}

      {settings && CATEGORY_ORDER.map((category) => {
        const items = SETTING_META.filter((meta) => meta.category === category);
        if (items.length === 0) return null;
        return (
          <div key={category} className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground pt-2">{category}</h2>
            {items.map((meta) => {
              const value = settings[meta.key];
              const settingId = `procurement-setting-${meta.key}`;
              return (
                <Card key={meta.key} data-setting={meta.key}>
                  <CardContent className="p-4 flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Label htmlFor={settingId} className="text-base font-medium">{meta.label}</Label>
                        <Badge variant="outline" className="text-xs">{meta.active ? "Available" : "Unavailable"}</Badge>
                      </div>
                      <p id={`${settingId}-description`} className="text-sm text-muted-foreground mt-1">{meta.description}</p>
                      {!meta.active && <p id={`${settingId}-availability`} className="mt-1 text-xs text-muted-foreground">Saved preference: {value ? "On" : "Off"}. This option has no effect.</p>}
                    </div>
                    <div className="shrink-0 pt-1">
                      <Switch
                        id={settingId}
                        checked={value}
                        disabled={!meta.active || !canEdit || patchMutation.isPending || query.isFetching || loadFailed || unresolvedIntent !== null}
                        onCheckedChange={(checked) => onToggle(meta.key, checked)}
                        aria-label={meta.label}
                        aria-describedby={`${settingId}-description${meta.active ? "" : ` ${settingId}-availability`}`}
                      />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
