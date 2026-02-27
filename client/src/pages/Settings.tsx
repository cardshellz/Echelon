import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Building2, Package, Bell, Clock, Save, Volume2, ShoppingCart, Plus, Pencil, Trash2, Info } from "lucide-react";
import { useSettings } from "@/lib/settings";
import { themeNames, themeDescriptions, previewTheme, type SoundTheme } from "@/lib/sounds";

interface Settings {
  [key: string]: string | null;
}

interface Warehouse {
  id: number;
  code: string;
  name: string;
  isDefault: number;
}

export default function Settings() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { soundTheme, setSoundTheme } = useSettings();

  const [formData, setFormData] = useState<Settings>({
    company_name: "",
    company_address: "",
    company_city: "",
    company_state: "",
    company_postal_code: "",
    company_country: "US",
    default_timezone: "America/New_York",
    default_warehouse_id: "",
    allow_multiple_skus_per_bin: "true",
    default_lead_time_days: "120",
    default_safety_stock_days: "7",
    cycle_count_auto_approve_tolerance: "0",
    cycle_count_approval_threshold: "10",
  });

  const { data: settings, isLoading } = useQuery<Settings>({
    queryKey: ["/api/settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error("Failed to load settings");
      return res.json();
    },
  });

  const { data: warehouses } = useQuery<Warehouse[]>({
    queryKey: ["/api/warehouses"],
  });

  useEffect(() => {
    if (settings) {
      setFormData(prev => ({
        ...prev,
        ...settings,
      }));
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async (data: Settings) => {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to save settings");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Settings saved", description: "Your settings have been updated." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save settings", variant: "destructive" });
    },
  });

  const handleSave = () => {
    saveMutation.mutate(formData);
  };

  const canEdit = hasPermission("settings", "edit");

  // ── Approval Tiers ──────────────────────────────────────────────────
  const [showTierDialog, setShowTierDialog] = useState(false);
  const [editingTier, setEditingTier] = useState<any>(null);
  const [tierForm, setTierForm] = useState({ tierName: "", thresholdDollars: "", approverRole: "lead", sortOrder: "0", active: true });

  const { data: tiersData } = useQuery<{ tiers: any[] }>({ queryKey: ["/api/purchasing/approval-tiers"] });
  const tiers = tiersData?.tiers ?? [];

  function openAddTier() {
    setEditingTier(null);
    setTierForm({ tierName: "", thresholdDollars: "", approverRole: "lead", sortOrder: "0", active: true });
    setShowTierDialog(true);
  }

  function openEditTier(t: any) {
    setEditingTier(t);
    setTierForm({
      tierName: t.tierName,
      thresholdDollars: (t.thresholdCents / 100).toFixed(2),
      approverRole: t.approverRole,
      sortOrder: String(t.sortOrder ?? 0),
      active: t.active !== 0,
    });
    setShowTierDialog(true);
  }

  const saveTierMutation = useMutation({
    mutationFn: async () => {
      const body = {
        tierName: tierForm.tierName,
        thresholdCents: Math.round(parseFloat(tierForm.thresholdDollars || "0") * 100),
        approverRole: tierForm.approverRole,
        sortOrder: parseInt(tierForm.sortOrder || "0"),
        active: tierForm.active ? 1 : 0,
      };
      const url = editingTier
        ? `/api/purchasing/approval-tiers/${editingTier.id}`
        : "/api/purchasing/approval-tiers";
      const method = editingTier ? "PATCH" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json()).error);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/approval-tiers"] });
      setShowTierDialog(false);
      toast({ title: editingTier ? "Tier updated" : "Tier created" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteTierMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/purchasing/approval-tiers/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/approval-tiers"] });
      toast({ title: "Tier deleted" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="p-4 md:p-6 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const timezones = [
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Phoenix",
    "America/Anchorage",
    "Pacific/Honolulu",
    "Europe/London",
    "Europe/Paris",
    "Europe/Berlin",
    "Asia/Tokyo",
    "Asia/Shanghai",
    "Australia/Sydney",
  ];

  return (
    <div className="p-2 md:p-6 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">General Settings</h1>
          <p className="text-muted-foreground">Configure your organization and system defaults</p>
        </div>
        {canEdit && (
          <Button onClick={handleSave} disabled={saveMutation.isPending} data-testid="button-save-settings" className="w-full md:w-auto min-h-[44px]">
            <Save className="h-4 w-4 mr-2" />
            {saveMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        )}
      </div>

      <Tabs defaultValue="company" className="space-y-6">
        <TabsList className="w-full overflow-x-auto flex-nowrap justify-start md:justify-center">
          <TabsTrigger value="company" data-testid="tab-company">
            <Building2 className="h-4 w-4 mr-2" />
            Company
          </TabsTrigger>
          <TabsTrigger value="inventory" data-testid="tab-inventory">
            <Package className="h-4 w-4 mr-2" />
            Inventory
          </TabsTrigger>
          <TabsTrigger value="picking" data-testid="tab-picking">
            <Clock className="h-4 w-4 mr-2" />
            Picking
          </TabsTrigger>
          <TabsTrigger value="notifications" data-testid="tab-notifications">
            <Bell className="h-4 w-4 mr-2" />
            Notifications
          </TabsTrigger>
          <TabsTrigger value="procurement">
            <ShoppingCart className="h-4 w-4 mr-2" />
            Procurement
          </TabsTrigger>
        </TabsList>

        <TabsContent value="company" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Company Information</CardTitle>
              <CardDescription>Your organization details used on labels and documents</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="company_name" className="text-sm">Company Name</Label>
                  <Input
                    id="company_name"
                    value={formData.company_name || ""}
                    onChange={(e) => setFormData({ ...formData, company_name: e.target.value })}
                    disabled={!canEdit}
                    className="h-11"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-testid="input-company-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="default_timezone" className="text-sm">Default Timezone</Label>
                  <Select
                    value={formData.default_timezone || "America/New_York"}
                    onValueChange={(val) => setFormData({ ...formData, default_timezone: val })}
                    disabled={!canEdit}
                  >
                    <SelectTrigger className="h-11" data-testid="select-timezone">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {timezones.map((tz) => (
                        <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="company_address" className="text-sm">Address</Label>
                <Input
                  id="company_address"
                  value={formData.company_address || ""}
                  onChange={(e) => setFormData({ ...formData, company_address: e.target.value })}
                  disabled={!canEdit}
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-company-address"
                />
              </div>

              <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
                <div className="space-y-2">
                  <Label htmlFor="company_city" className="text-sm">City</Label>
                  <Input
                    id="company_city"
                    value={formData.company_city || ""}
                    onChange={(e) => setFormData({ ...formData, company_city: e.target.value })}
                    disabled={!canEdit}
                    className="h-11"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-testid="input-company-city"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="company_state" className="text-sm">State</Label>
                  <Input
                    id="company_state"
                    value={formData.company_state || ""}
                    onChange={(e) => setFormData({ ...formData, company_state: e.target.value })}
                    disabled={!canEdit}
                    className="h-11"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-testid="input-company-state"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="company_postal_code" className="text-sm">Postal Code</Label>
                  <Input
                    id="company_postal_code"
                    value={formData.company_postal_code || ""}
                    onChange={(e) => setFormData({ ...formData, company_postal_code: e.target.value })}
                    disabled={!canEdit}
                    className="h-11"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-testid="input-company-postal"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="company_country" className="text-sm">Country</Label>
                  <Input
                    id="company_country"
                    value={formData.company_country || "US"}
                    onChange={(e) => setFormData({ ...formData, company_country: e.target.value })}
                    disabled={!canEdit}
                    className="h-11"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-testid="input-company-country"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Default Warehouse</CardTitle>
              <CardDescription>The default warehouse used for new operations</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Label htmlFor="default_warehouse_id" className="text-sm">Default Warehouse</Label>
                <Select
                  value={formData.default_warehouse_id || ""}
                  onValueChange={(val) => setFormData({ ...formData, default_warehouse_id: val })}
                  disabled={!canEdit}
                >
                  <SelectTrigger className="h-11" data-testid="select-default-warehouse">
                    <SelectValue placeholder="Select default warehouse" />
                  </SelectTrigger>
                  <SelectContent>
                    {warehouses?.map((wh) => (
                      <SelectItem key={wh.id} value={String(wh.id)}>
                        {wh.code} - {wh.name} {wh.isDefault ? "(Current Default)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="inventory" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Procurement Defaults</CardTitle>
              <CardDescription>Default lead time and safety stock for products without per-product overrides</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="default_lead_time_days" className="text-sm">Default Lead Time (days)</Label>
                  <Input
                    id="default_lead_time_days"
                    type="number"
                    value={formData.default_lead_time_days || "120"}
                    onChange={(e) => setFormData({ ...formData, default_lead_time_days: e.target.value })}
                    disabled={!canEdit}
                    className="h-11"
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">Products without a specific lead time will use this value</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="default_safety_stock_days" className="text-sm">Default Safety Stock (days of cover)</Label>
                  <Input
                    id="default_safety_stock_days"
                    type="number"
                    value={formData.default_safety_stock_days || "7"}
                    onChange={(e) => setFormData({ ...formData, default_safety_stock_days: e.target.value })}
                    disabled={!canEdit}
                    className="h-11"
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">Extra days of inventory buffer beyond lead time, scales with velocity per product</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Bin Management</CardTitle>
              <CardDescription>Configure how bins are managed in the warehouse</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="allow_multiple_skus_per_bin">Allow Multiple SKUs Per Bin</Label>
                  <p className="text-sm text-muted-foreground">
                    When enabled, multiple different products can be stored in the same bin location.
                    When disabled, each bin can only contain one SKU.
                  </p>
                </div>
                <Switch
                  id="allow_multiple_skus_per_bin"
                  checked={formData.allow_multiple_skus_per_bin === "true"}
                  onCheckedChange={(checked) => 
                    setFormData({ ...formData, allow_multiple_skus_per_bin: checked ? "true" : "false" })
                  }
                  disabled={!canEdit}
                  data-testid="switch-allow-multiple-skus"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Cycle Count Settings</CardTitle>
              <CardDescription>Configure cycle count variance handling and auto-approval thresholds</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="cycle_count_auto_approve_tolerance" className="text-sm">Auto-Approve Tolerance (units)</Label>
                  <Input
                    id="cycle_count_auto_approve_tolerance"
                    type="number"
                    value={formData.cycle_count_auto_approve_tolerance || "0"}
                    onChange={(e) => setFormData({ ...formData, cycle_count_auto_approve_tolerance: e.target.value })}
                    disabled={!canEdit}
                    className="h-11"
                    autoComplete="off"
                    min="0"
                  />
                  <p className="text-xs text-muted-foreground">Variances within this range are auto-approved during counting. Set to 0 to disable.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cycle_count_approval_threshold" className="text-sm">Approval Threshold (units)</Label>
                  <Input
                    id="cycle_count_approval_threshold"
                    type="number"
                    value={formData.cycle_count_approval_threshold || "10"}
                    onChange={(e) => setFormData({ ...formData, cycle_count_approval_threshold: e.target.value })}
                    disabled={!canEdit}
                    className="h-11"
                    autoComplete="off"
                    min="0"
                  />
                  <p className="text-xs text-muted-foreground">Variances above this threshold are flagged as requiring approval</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="picking" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Volume2 className="h-5 w-5" />
                Sound & Haptic Feedback
              </CardTitle>
              <CardDescription>Choose sounds for picking confirmations. Operational settings like batch size live in Picking → Settings per warehouse.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <Label className="text-sm">Sound Theme</Label>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                  {(Object.keys(themeNames) as SoundTheme[]).map((theme) => (
                    <button
                      key={theme}
                      type="button"
                      onClick={() => {
                        setSoundTheme(theme);
                        if (theme !== "silent") {
                          setTimeout(() => previewTheme(theme), 100);
                        }
                      }}
                      className={`p-3 rounded-lg border text-left transition-colors ${
                        soundTheme === theme 
                          ? "border-primary bg-primary/10" 
                          : "border-slate-200 hover:bg-slate-50"
                      }`}
                      data-testid={`button-sound-${theme}`}
                    >
                      <div className="font-medium text-sm">{themeNames[theme]}</div>
                      <div className="text-xs text-muted-foreground">{themeDescriptions[theme]}</div>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Click a theme to preview and apply it</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Alert Settings</CardTitle>
              <CardDescription>Configure which notifications are enabled</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label>Low Stock Alerts</Label>
                  <p className="text-sm text-muted-foreground">
                    Notify when items fall below the low stock threshold
                  </p>
                </div>
                <Switch
                  checked={formData.enable_low_stock_alerts === "true"}
                  onCheckedChange={(checked) =>
                    setFormData({ ...formData, enable_low_stock_alerts: checked ? "true" : "false" })
                  }
                  disabled={!canEdit}
                  data-testid="switch-low-stock-alerts"
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="procurement" className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>PO Approval Tiers</CardTitle>
                  <CardDescription>Require approval for purchase orders that meet or exceed a threshold</CardDescription>
                </div>
                {canEdit && (
                  <Button size="sm" onClick={openAddTier}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Tier
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start gap-2 rounded-md bg-blue-50 border border-blue-200 p-3 text-sm text-blue-800">
                <Info className="h-4 w-4 mt-0.5 shrink-0" />
                <p>
                  POs auto-approve when no tier threshold is met. Add a tier at <strong>$0</strong> to require approval for all POs. The matching tier is the highest-threshold tier whose value ≤ the PO total.
                </p>
              </div>

              {tiers.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  No approval tiers configured — all POs auto-approve on submission.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tier Name</TableHead>
                      <TableHead>Threshold</TableHead>
                      <TableHead>Approver Role</TableHead>
                      <TableHead>Sort Order</TableHead>
                      <TableHead>Active</TableHead>
                      {canEdit && <TableHead></TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...tiers].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="font-medium">{t.tierName}</TableCell>
                        <TableCell className="font-mono">${(t.thresholdCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}</TableCell>
                        <TableCell className="capitalize">{t.approverRole}</TableCell>
                        <TableCell>{t.sortOrder ?? 0}</TableCell>
                        <TableCell>
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${t.active !== 0 ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>
                            {t.active !== 0 ? "Active" : "Inactive"}
                          </span>
                        </TableCell>
                        {canEdit && (
                          <TableCell>
                            <div className="flex gap-1">
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openEditTier(t)}>
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-500 hover:text-red-700"
                                onClick={() => { if (confirm(`Delete tier "${t.tierName}"?`)) deleteTierMutation.mutate(t.id); }}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Approval Tier Dialog */}
      <Dialog open={showTierDialog} onOpenChange={setShowTierDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingTier ? "Edit Approval Tier" : "Add Approval Tier"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Tier Name *</Label>
              <Input placeholder="e.g. Standard, High Value" value={tierForm.tierName} onChange={(e) => setTierForm(f => ({ ...f, tierName: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Threshold ($) *</Label>
                <Input type="number" step="0.01" min="0" placeholder="0.00" value={tierForm.thresholdDollars} onChange={(e) => setTierForm(f => ({ ...f, thresholdDollars: e.target.value }))} />
                <p className="text-xs text-muted-foreground">Min PO total to trigger this tier</p>
              </div>
              <div className="space-y-2">
                <Label>Sort Order</Label>
                <Input type="number" min="0" value={tierForm.sortOrder} onChange={(e) => setTierForm(f => ({ ...f, sortOrder: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Required Approver Role *</Label>
              <select className="w-full border rounded-md h-10 px-3 text-sm bg-background" value={tierForm.approverRole} onChange={(e) => setTierForm(f => ({ ...f, approverRole: e.target.value }))}>
                <option value="lead">Lead</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="flex items-center gap-3">
              <Switch checked={tierForm.active} onCheckedChange={(v) => setTierForm(f => ({ ...f, active: v }))} />
              <Label>Active</Label>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowTierDialog(false)}>Cancel</Button>
              <Button onClick={() => saveTierMutation.mutate()} disabled={!tierForm.tierName || !tierForm.thresholdDollars || saveTierMutation.isPending}>
                {saveTierMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
