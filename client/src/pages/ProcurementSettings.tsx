// ProcurementSettings.tsx
//
// Admin settings page for Spec A. Mounted at /settings/procurement.
//
// Each of the 9 procurement settings gets its own card with a label, short
// description, and a toggle. Changes PATCH /api/settings/procurement
// immediately (per-toggle; no "save all" button). Settings are loaded and
// kept in sync via React Query cache invalidation on success.
//
// Only `requireApproval` and `autoSendOnApprove` affect the current
// implementation (Spec A). The remaining settings are scaffolded for
// Specs B and C — clearly labeled so admins know they are not yet active.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Settings2 } from "lucide-react";

type ProcurementSettings = {
  requireApproval: boolean;
  autoSendOnApprove: boolean;
  requireAcknowledgeBeforeReceive: boolean;
  hideIncotermsDomestic: boolean;
  enableShipmentTracking: boolean;
  autoPutawayLocation: boolean;
  autoCloseOnReconcile: boolean;
  oneClickReceiveStart: boolean;
  useNewPoEditor: boolean;
};

type SettingMeta = {
  key: keyof ProcurementSettings;
  label: string;
  description: string;
  category: "Approvals" | "Create & Send" | "Receiving" | "Reconciliation";
  active: boolean; // true = consumed today, false = scaffolded for future specs
};

// Order defines display order in the page.
const SETTING_META: SettingMeta[] = [
  {
    key: "requireApproval",
    label: "Require approval",
    description:
      "When on, POs above a matching approval tier go to 'pending approval' on send instead of advancing straight to 'sent'.",
    category: "Approvals",
    active: true,
  },
  {
    key: "autoSendOnApprove",
    label: "Auto-send on approve",
    description:
      "When on, approved POs skip the 'approved' visible status and advance to 'sent' as soon as the PDF is generated.",
    category: "Create & Send",
    active: true,
  },
  {
    key: "useNewPoEditor",
    label: "Use the new PO editor",
    description:
      "Feature flag for the redesigned full-page PO editor. When off, the '+ New PO' button opens the legacy dialog.",
    category: "Create & Send",
    active: true,
  },
  {
    key: "hideIncotermsDomestic",
    label: "Hide incoterms for US vendors",
    description:
      "Hide the incoterms field on POs when the selected vendor's country is US. Incoterms are rarely relevant for domestic orders.",
    category: "Create & Send",
    active: true,
  },
  {
    key: "requireAcknowledgeBeforeReceive",
    label: "Require vendor acknowledgement before receive",
    description:
      "When on, a PO must be acknowledged by the vendor before a receipt can be opened against it.",
    category: "Receiving",
    active: false,
  },
  {
    key: "enableShipmentTracking",
    label: "Enable shipment tracking",
    description:
      "Show the shipment tracking fields (carrier, tracking number, ETA) on POs and receipts.",
    category: "Receiving",
    active: false,
  },
  {
    key: "autoPutawayLocation",
    label: "Auto-fill putaway location",
    description:
      "Pre-fill the receiving line's putaway location from the last known location for each SKU.",
    category: "Receiving",
    active: false,
  },
  {
    key: "oneClickReceiveStart",
    label: "One-click start receive",
    description:
      "Auto-start a new receipt (skip the intermediate 'draft' step) when you click 'Create receipt' on a PO.",
    category: "Receiving",
    active: false,
  },
  {
    key: "autoCloseOnReconcile",
    label: "Auto-close on reconcile",
    description:
      "When a PO is fully received, paid, and 3-way reconciled, automatically mark it closed.",
    category: "Reconciliation",
    active: false,
  },
];

// Group settings by category for rendering.
const CATEGORY_ORDER: SettingMeta["category"][] = [
  "Approvals",
  "Create & Send",
  "Receiving",
  "Reconciliation",
];

export default function ProcurementSettings() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: settings, isLoading } = useQuery<ProcurementSettings>({
    queryKey: ["/api/settings/procurement"],
    queryFn: async () => {
      const res = await fetch("/api/settings/procurement");
      if (!res.ok) throw new Error("Failed to load procurement settings");
      return res.json();
    },
  });

  const patchMutation = useMutation({
    mutationFn: async ({ key, value }: { key: keyof ProcurementSettings; value: boolean }) => {
      const res = await fetch("/api/settings/procurement", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to update setting");
      return data as ProcurementSettings;
    },
    onSuccess: (data) => {
      qc.setQueryData(["/api/settings/procurement"], data);
    },
    onError: (err: any) => {
      toast({
        title: "Could not update setting",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  function onToggle(key: keyof ProcurementSettings, next: boolean) {
    // Optimistic UI: flip locally, then reconcile from server.
    if (settings) {
      qc.setQueryData(["/api/settings/procurement"], { ...settings, [key]: next });
    }
    patchMutation.mutate({ key, value: next });
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-3xl mx-auto">
      <div>
        <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
          <Settings2 className="h-5 w-5 md:h-6 md:w-6" />
          Procurement Settings
        </h1>
        <p className="text-sm text-muted-foreground">
          Solo-operator defaults with per-setting flexibility. Only a few of these
          are wired in today — the rest are scaffolded for upcoming work.
        </p>
      </div>

      {isLoading && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">Loading…</CardContent>
        </Card>
      )}

      {settings &&
        CATEGORY_ORDER.map((category) => {
          const items = SETTING_META.filter((m) => m.category === category);
          if (items.length === 0) return null;
          return (
            <div key={category} className="space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground pt-2">
                {category}
              </h2>
              {items.map((meta) => {
                const value = settings[meta.key];
                return (
                  <Card key={meta.key}>
                    <CardContent className="p-4 flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Label className="text-base font-medium">{meta.label}</Label>
                          {!meta.active && (
                            <Badge variant="outline" className="text-xs">
                              Coming soon
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">
                          {meta.description}
                        </p>
                      </div>
                      <div className="shrink-0 pt-1">
                        <Switch
                          checked={value}
                          onCheckedChange={(checked) => onToggle(meta.key, checked)}
                          aria-label={meta.label}
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
