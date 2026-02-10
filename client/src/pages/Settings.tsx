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
import { useToast } from "@/hooks/use-toast";
import { Building2, Package, Bell, Clock, Save, Volume2 } from "lucide-react";
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
    low_stock_threshold: "10",
    critical_stock_threshold: "5",
    enable_low_stock_alerts: "true",
    allow_multiple_skus_per_bin: "true",
    picking_batch_size: "20",
    auto_release_delay_minutes: "30",
    default_lead_time_days: "120",
    default_safety_stock_qty: "0",
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
              <CardTitle>Stock Thresholds</CardTitle>
              <CardDescription>Set thresholds for low stock and critical stock alerts</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="low_stock_threshold" className="text-sm">Low Stock Threshold (units)</Label>
                  <Input
                    id="low_stock_threshold"
                    type="number"
                    value={formData.low_stock_threshold || "10"}
                    onChange={(e) => setFormData({ ...formData, low_stock_threshold: e.target.value })}
                    disabled={!canEdit}
                    className="h-11"
                    autoComplete="off"
                    data-testid="input-low-stock-threshold"
                  />
                  <p className="text-xs text-muted-foreground">Items at or below this level are flagged as low stock</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="critical_stock_threshold" className="text-sm">Critical Stock Threshold (units)</Label>
                  <Input
                    id="critical_stock_threshold"
                    type="number"
                    value={formData.critical_stock_threshold || "5"}
                    onChange={(e) => setFormData({ ...formData, critical_stock_threshold: e.target.value })}
                    disabled={!canEdit}
                    className="h-11"
                    autoComplete="off"
                    data-testid="input-critical-stock-threshold"
                  />
                  <p className="text-xs text-muted-foreground">Items at or below this level are flagged as critical</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Procurement Defaults</CardTitle>
              <CardDescription>Default lead time and safety stock for products without overrides</CardDescription>
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
                  <Label htmlFor="default_safety_stock_qty" className="text-sm">Default Safety Stock (units)</Label>
                  <Input
                    id="default_safety_stock_qty"
                    type="number"
                    value={formData.default_safety_stock_qty || "0"}
                    onChange={(e) => setFormData({ ...formData, default_safety_stock_qty: e.target.value })}
                    disabled={!canEdit}
                    className="h-11"
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">Products without specific safety stock will use this value</p>
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
        </TabsContent>

        <TabsContent value="picking" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Picking Defaults</CardTitle>
              <CardDescription>Configure default picking behavior</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="picking_batch_size" className="text-sm">Default Batch Size</Label>
                  <Input
                    id="picking_batch_size"
                    type="number"
                    value={formData.picking_batch_size || "20"}
                    onChange={(e) => setFormData({ ...formData, picking_batch_size: e.target.value })}
                    disabled={!canEdit}
                    className="h-11"
                    autoComplete="off"
                    data-testid="input-batch-size"
                  />
                  <p className="text-xs text-muted-foreground">Maximum orders in a single picking batch</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="auto_release_delay_minutes" className="text-sm">Auto-Release Delay (minutes)</Label>
                  <Input
                    id="auto_release_delay_minutes"
                    type="number"
                    value={formData.auto_release_delay_minutes || "30"}
                    onChange={(e) => setFormData({ ...formData, auto_release_delay_minutes: e.target.value })}
                    disabled={!canEdit}
                    className="h-11"
                    autoComplete="off"
                    data-testid="input-release-delay"
                  />
                  <p className="text-xs text-muted-foreground">Time before unclaimed orders are released back to queue</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Volume2 className="h-5 w-5" />
                Sound & Haptic Feedback
              </CardTitle>
              <CardDescription>Choose sounds for picking confirmations</CardDescription>
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
      </Tabs>
    </div>
  );
}
