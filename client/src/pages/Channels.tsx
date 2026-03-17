import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  Store, Plus, Settings, RefreshCw, Trash2, CheckCircle2, AlertCircle,
  Clock, Pause, Play, ExternalLink, Building2, Package, Lock, MapPin, Link2, Save, Upload,
  ShieldAlert, Radio, FileText, Eye, BarChart3, ShieldCheck, Loader2, XCircle,
} from "lucide-react";

interface ChannelConnection {
  id: number;
  channelId: number;
  shopDomain: string | null;
  lastSyncAt: string | null;
  syncStatus: string | null;
  syncError: string | null;
}

interface PartnerProfile {
  id: number;
  channelId: number;
  companyName: string;
  contactName: string | null;
  contactEmail: string | null;
  discountPercent: number;
  slaDays: number;
}

interface Channel {
  id: number;
  name: string;
  type: string;
  provider: string;
  status: string;
  isDefault: number;
  priority: number;
  createdAt: string;
  connection: ChannelConnection | null;
  partnerProfile: PartnerProfile | null;
}

interface ShopifyLocation {
  id: string;
  name: string;
  address1: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  active: boolean;
}

interface LocationMapping {
  shopifyLocationId: string;
  warehouseId: number;
  warehouseCode: string;
  warehouseName: string;
}

interface WarehouseOption {
  id: number;
  code: string;
  name: string;
}

// eBay-specific types
interface EbaySettings {
  connected: boolean;
  configured: boolean;
  channel: { id: number; name: string; status: string } | null;
  ebayUsername: string | null;
  tokenInfo: {
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
    lastRefreshedAt: string;
    environment: string;
  } | null;
  config: {
    merchantLocationKey: string | null;
    fulfillmentPolicyId: string | null;
    returnPolicyId: string | null;
    paymentPolicyId: string | null;
    merchantLocation: {
      name: string;
      addressLine1: string;
      addressLine2: string;
      city: string;
      stateOrProvince: string;
      postalCode: string;
      country: string;
    } | null;
  };
  lastSyncAt: string | null;
  syncStatus: string;
  error?: string;
}

interface EbayPolicy {
  id: string;
  name: string;
  description: string;
  marketplaceId: string;
}

interface EbayPoliciesResponse {
  fulfillmentPolicies: EbayPolicy[];
  returnPolicies: EbayPolicy[];
  paymentPolicies: EbayPolicy[];
}

interface EbayListingPreview {
  productId: number;
  title: string;
  description: string | null;
  category: string;
  categoryId: string;
  images: string[];
  variants: { sku: string; name: string; priceCents: number; price: string }[];
  bulletPoints: string[];
  brand: string;
}

interface EbayStats {
  totalOrders: number;
  activeListings: number;
  lastSyncAt: string | null;
  syncStatus: string;
}

const PROVIDER_OPTIONS = [
  { value: "shopify", label: "Shopify", icon: "🛒" },
  { value: "ebay", label: "eBay", icon: "🏷️" },
  { value: "amazon", label: "Amazon", icon: "📦" },
  { value: "etsy", label: "Etsy", icon: "🎨" },
  { value: "manual", label: "Manual Entry", icon: "✏️" },
];

const STATUS_BADGES: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
  active: { variant: "default", label: "Active" },
  paused: { variant: "secondary", label: "Paused" },
  pending_setup: { variant: "outline", label: "Pending Setup" },
  error: { variant: "destructive", label: "Error" },
};

export default function Channels() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [newChannel, setNewChannel] = useState({
    name: "",
    type: "internal",
    provider: "shopify",
    status: "pending_setup",
  });

  const canView = hasPermission("channels", "view");
  const canCreate = hasPermission("channels", "create");
  const canEdit = hasPermission("channels", "edit");
  const canDelete = hasPermission("channels", "delete");

  const { data: channels = [], isLoading } = useQuery<Channel[]>({
    queryKey: ["/api/channels"],
    queryFn: async () => {
      const res = await fetch("/api/channels", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch channels");
      return res.json();
    },
    enabled: canView,
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof newChannel) => {
      const res = await fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create channel");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels"] });
      setIsCreateOpen(false);
      setNewChannel({ name: "", type: "internal", provider: "shopify", status: "pending_setup" });
      toast({ title: "Channel created successfully" });
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: number; [key: string]: any }) => {
      const res = await fetch(`/api/channels/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update channel");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels"] });
      toast({ title: "Channel updated" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/channels/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete channel");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels"] });
      setSelectedChannel(null);
      toast({ title: "Channel deleted" });
    },
  });

  // Shopify connection credentials (for setup)
  const [connectDomain, setConnectDomain] = useState("");
  const [connectToken, setConnectToken] = useState("");
  const [connecting, setConnecting] = useState(false);

  // Shopify location mapping state
  const [shopifyLocations, setShopifyLocations] = useState<ShopifyLocation[]>([]);
  const [locationMappings, setLocationMappings] = useState<Record<string, number | null>>({});
  const [locationsLoading, setLocationsLoading] = useState(false);

  // eBay-specific state
  const [ebayLocationForm, setEbayLocationForm] = useState({
    name: "Card Shellz HQ",
    addressLine1: "20 Leonberg Rd",
    addressLine2: "",
    city: "Cranberry Township",
    stateOrProvince: "PA",
    postalCode: "16066",
    country: "US",
    merchantLocationKey: "CARDSHELLZ_HQ",
  });
  const [ebayPolicySelections, setEbayPolicySelections] = useState({
    fulfillmentPolicyId: "",
    returnPolicyId: "",
    paymentPolicyId: "",
  });
  const [ebayPolicySynced, setEbayPolicySynced] = useState(false);

  const isEbaySelected = selectedChannel?.provider === 'ebay';

  const { data: ebaySettings, isLoading: ebaySettingsLoading } = useQuery<EbaySettings>({
    queryKey: ["/api/ebay/settings"],
    enabled: isEbaySelected,
  });

  const { data: ebayPolicies, isLoading: ebayPoliciesLoading } = useQuery<EbayPoliciesResponse>({
    queryKey: ["/api/ebay/policies"],
    enabled: isEbaySelected && !!ebaySettings?.connected,
  });

  const { data: ebayPreviewData, isLoading: ebayPreviewLoading, refetch: refetchEbayPreview } = useQuery<{ previews: EbayListingPreview[] }>({
    queryKey: ["/api/ebay/listings/preview"],
    enabled: isEbaySelected,
  });

  const { data: ebayStats, isLoading: ebayStatsLoading } = useQuery<EbayStats>({
    queryKey: ["/api/ebay/stats"],
    enabled: isEbaySelected && !!ebaySettings?.connected,
  });

  // Sync policy selections from eBay settings when loaded
  useEffect(() => {
    if (ebaySettings?.config && !ebayPolicySynced) {
      if (ebaySettings.config.fulfillmentPolicyId || ebaySettings.config.returnPolicyId || ebaySettings.config.paymentPolicyId) {
        setEbayPolicySelections({
          fulfillmentPolicyId: ebaySettings.config.fulfillmentPolicyId || "",
          returnPolicyId: ebaySettings.config.returnPolicyId || "",
          paymentPolicyId: ebaySettings.config.paymentPolicyId || "",
        });
        setEbayPolicySynced(true);
      }
    }
  }, [ebaySettings, ebayPolicySynced]);

  // Reset eBay policy sync flag when switching channels
  useEffect(() => {
    setEbayPolicySynced(false);
  }, [selectedChannel?.id]);

  const createEbayLocationMutation = useMutation({
    mutationFn: async () => {
      const resp = await apiRequest("POST", "/api/ebay/location", ebayLocationForm);
      return resp.json();
    },
    onSuccess: (data) => {
      toast({ title: "Location Created", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/settings"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const saveEbayPoliciesMutation = useMutation({
    mutationFn: async () => {
      const resp = await apiRequest("PUT", "/api/ebay/settings", ebayPolicySelections);
      return resp.json();
    },
    onSuccess: () => {
      toast({ title: "Settings Saved", description: "Business policy selections saved." });
      queryClient.invalidateQueries({ queryKey: ["/api/ebay/settings"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const testEbayListingMutation = useMutation({
    mutationFn: async (productId: number) => {
      const resp = await apiRequest("POST", "/api/ebay/listings/test", { productId });
      return resp.json();
    },
    onSuccess: (data) => {
      toast({
        title: data.success ? "Test Listing Created!" : "Partial Success",
        description: data.warning || data.message,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const ebayHasLocation = !!ebaySettings?.config?.merchantLocationKey;
  const ebayHasPolicies = !!(
    ebaySettings?.config?.fulfillmentPolicyId &&
    ebaySettings?.config?.returnPolicyId &&
    ebaySettings?.config?.paymentPolicyId
  );

  const { data: warehouses = [] } = useQuery<WarehouseOption[]>({
    queryKey: ["/api/warehouses"],
    queryFn: async () => {
      const res = await fetch("/api/warehouses", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch warehouses");
      return res.json();
    },
  });

  const fetchShopifyLocations = async (channelId: number) => {
    setLocationsLoading(true);
    try {
      const res = await fetch(`/api/channels/${channelId}/shopify-locations`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch locations");
      const data = await res.json();
      setShopifyLocations(data.locations || []);
      // Build mapping state from existing mappings
      const map: Record<string, number | null> = {};
      for (const loc of data.locations || []) {
        const existing = (data.mappings || []).find((m: LocationMapping) => m.shopifyLocationId === loc.id);
        map[loc.id] = existing ? existing.warehouseId : null;
      }
      setLocationMappings(map);
    } catch (err) {
      toast({ title: "Error", description: "Failed to fetch Shopify locations", variant: "destructive" });
    } finally {
      setLocationsLoading(false);
    }
  };

  const saveLocationMappings = useMutation({
    mutationFn: async (channelId: number) => {
      const mappings = Object.entries(locationMappings)
        .filter(([_, warehouseId]) => warehouseId !== null)
        .map(([shopifyLocationId, warehouseId]) => ({ shopifyLocationId, warehouseId }));
      const res = await fetch(`/api/channels/${channelId}/map-locations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mappings }),
      });
      if (!res.ok) throw new Error("Failed to save mappings");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/warehouses"] });
      toast({ title: "Location mappings saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // Warehouse settings for channel sync kill switch
  const { data: warehouseSettings } = useQuery<any>({
    queryKey: ["/api/warehouse-settings/default"],
    queryFn: async () => {
      const res = await fetch("/api/warehouse-settings/default", { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: canView,
  });

  const channelSyncEnabled = warehouseSettings?.channelSyncEnabled === 1;

  const toggleChannelSyncMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!warehouseSettings?.id) throw new Error("No warehouse settings found");
      const res = await fetch(`/api/warehouse-settings/${warehouseSettings.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ channelSyncEnabled: enabled ? 1 : 0 }),
      });
      if (!res.ok) throw new Error("Failed to update settings");
      // Refresh the cached kill switch in the service
      await fetch("/api/channel-sync/refresh-enabled", {
        method: "POST",
        credentials: "include",
      });
      return res.json();
    },
    onSuccess: (_data, enabled) => {
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse-settings/default"] });
      toast({
        title: enabled ? "Channel sync enabled" : "Channel sync disabled",
        description: enabled
          ? "Inventory will now push to connected sales channels."
          : "All inventory pushes to sales channels are paused.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const syncInventoryMutation = useMutation({
    mutationFn: async (channelId: number) => {
      const res = await fetch("/api/channel-sync/all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ channelId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Sync failed" }));
        throw new Error(err.error || "Sync failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels"] });
      toast({
        title: "Inventory sync started",
        description: "Pushing inventory to Shopify in background. Check server logs for progress.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    },
  });

  const handleStatusToggle = (channel: Channel) => {
    const newStatus = channel.status === "active" ? "paused" : "active";
    updateMutation.mutate({ id: channel.id, status: newStatus });
  };

  const getSyncStatusIcon = (connection: ChannelConnection | null) => {
    if (!connection) return <Clock className="h-4 w-4 text-muted-foreground" />;
    switch (connection.syncStatus) {
      case "ok": return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
      case "error": return <AlertCircle className="h-4 w-4 text-destructive" />;
      case "syncing": return <RefreshCw className="h-4 w-4 text-blue-500 animate-spin" />;
      default: return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getProviderIcon = (provider: string) => {
    const opt = PROVIDER_OPTIONS.find(p => p.value === provider);
    return opt?.icon || "🔗";
  };

  if (!canView) {
    return (
      <div className="flex items-center justify-center h-96" data-testid="page-channels-no-access">
        <Card className="p-6 text-center">
          <Lock className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold">Access Denied</h2>
          <p className="text-muted-foreground mt-2">You don't have permission to view channels.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6" data-testid="page-channels">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Store className="h-8 w-8 text-primary" />
            Sales Channels
          </h1>
          <p className="text-muted-foreground">Manage your connected stores and marketplace integrations</p>
        </div>
        {canCreate && (
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-create-channel" className="min-h-[44px]">
                <Plus className="h-4 w-4 mr-2" />
                Add Channel
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
              <DialogHeader>
                <DialogTitle>Add New Channel</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="channel-name" className="text-sm">Channel Name</Label>
                  <Input
                    id="channel-name"
                    className="w-full h-11"
                    value={newChannel.name}
                    onChange={(e) => setNewChannel(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="e.g., Shopify Main Store"
                    data-testid="input-channel-name"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="channel-type" className="text-sm">Type</Label>
                  <Select
                    value={newChannel.type}
                    onValueChange={(value) => setNewChannel(prev => ({ ...prev, type: value }))}
                  >
                    <SelectTrigger className="w-full h-11" data-testid="select-channel-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="internal">Internal Store</SelectItem>
                      <SelectItem value="partner">Partner / Dropship</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="channel-provider" className="text-sm">Provider</Label>
                  <Select
                    value={newChannel.provider}
                    onValueChange={(value) => setNewChannel(prev => ({ ...prev, provider: value }))}
                  >
                    <SelectTrigger className="w-full h-11" data-testid="select-channel-provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDER_OPTIONS.map(opt => (
                        <SelectItem key={opt.value} value={opt.value}>
                          <span className="flex items-center gap-2">
                            <span>{opt.icon}</span>
                            <span>{opt.label}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <DialogFooter>
                <Button
                  className="min-h-[44px]"
                  onClick={() => createMutation.mutate(newChannel)}
                  disabled={!newChannel.name || createMutation.isPending}
                  data-testid="button-submit-channel"
                >
                  Create Channel
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {/* Channel Sync Kill Switch */}
      {warehouseSettings && canEdit && (
        <Card className={`border-l-4 ${channelSyncEnabled ? 'border-l-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20' : 'border-l-amber-500 bg-amber-50/50 dark:bg-amber-950/20'}`}>
          <CardContent className="flex items-center justify-between py-3 px-4">
            <div className="flex items-center gap-3">
              {channelSyncEnabled
                ? <Radio className="h-5 w-5 text-emerald-600" />
                : <ShieldAlert className="h-5 w-5 text-amber-600" />
              }
              <div>
                <p className="font-medium text-sm">
                  Inventory Push to Channels: {channelSyncEnabled ? "Active" : "Disabled"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {channelSyncEnabled
                    ? "ATP quantities are being pushed to connected sales channels."
                    : "No inventory data is being sent to any sales channel."}
                </p>
              </div>
            </div>
            <Switch
              checked={channelSyncEnabled}
              onCheckedChange={(checked) => toggleChannelSyncMutation.mutate(checked)}
              disabled={toggleChannelSyncMutation.isPending}
            />
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : channels.length === 0 ? (
        <Card className="p-12 text-center">
          <Store className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No Channels Connected</h2>
          <p className="text-muted-foreground mb-4">Add your first sales channel to start syncing orders and inventory.</p>
          {canCreate && (
            <Button onClick={() => setIsCreateOpen(true)} className="min-h-[44px]">
              <Plus className="h-4 w-4 mr-2" />
              Add Your First Channel
            </Button>
          )}
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {channels.map(channel => (
            <Card 
              key={channel.id} 
              className={`relative overflow-hidden transition-all cursor-pointer hover:shadow-md ${
                channel.status === 'active' ? 'border-l-4 border-l-emerald-500' : 
                channel.status === 'error' ? 'border-l-4 border-l-destructive' :
                channel.status === 'paused' ? 'border-l-4 border-l-amber-400' : ''
              }`}
              onClick={() => setSelectedChannel(channel)}
              data-testid={`channel-card-${channel.id}`}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 bg-muted rounded-md flex items-center justify-center text-xl">
                      {getProviderIcon(channel.provider)}
                    </div>
                    <div>
                      <CardTitle className="text-base">{channel.name}</CardTitle>
                      <CardDescription className="capitalize">
                        {channel.provider} • {channel.type === 'partner' ? 'Partner' : 'Internal'}
                      </CardDescription>
                    </div>
                  </div>
                  {canEdit && (
                    <Switch
                      checked={channel.status === 'active'}
                      onCheckedChange={() => handleStatusToggle(channel)}
                      onClick={(e) => e.stopPropagation()}
                      data-testid={`switch-channel-status-${channel.id}`}
                    />
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  {getSyncStatusIcon(channel.connection)}
                  <span>
                    {channel.connection?.lastSyncAt 
                      ? `Last sync: ${new Date(channel.connection.lastSyncAt).toLocaleDateString()}`
                      : 'Never synced'}
                  </span>
                </div>
                {channel.connection?.syncError && (
                  <p className="text-xs text-destructive mt-2 line-clamp-2">
                    {channel.connection.syncError}
                  </p>
                )}
              </CardContent>
              <CardFooter className="pt-0">
                <Badge variant={STATUS_BADGES[channel.status]?.variant || 'outline'}>
                  {STATUS_BADGES[channel.status]?.label || channel.status}
                </Badge>
                {channel.isDefault === 1 && (
                  <Badge variant="secondary" className="ml-2">Primary</Badge>
                )}
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {/* Channel Detail Dialog */}
      <Dialog open={!!selectedChannel} onOpenChange={(open) => !open && setSelectedChannel(null)}>
        <DialogContent className="max-w-md md:max-w-2xl lg:max-w-3xl max-h-[90vh] overflow-y-auto p-4">
          {selectedChannel && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className="text-xl">{getProviderIcon(selectedChannel.provider)}</span>
                  {selectedChannel.name}
                </DialogTitle>
              </DialogHeader>
              
              <Tabs defaultValue="settings" className="mt-4">
                <TabsList className="w-full flex-wrap h-auto">
                  <TabsTrigger value="settings" className="text-sm">Settings</TabsTrigger>
                  <TabsTrigger value="connection" className="text-sm">Connection</TabsTrigger>
                  {selectedChannel.type === 'partner' && (
                    <TabsTrigger value="partner" className="text-sm">Partner Info</TabsTrigger>
                  )}
                </TabsList>
                
                <TabsContent value="settings" className="space-y-4 mt-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-sm">Status</Label>
                      <Select
                        value={selectedChannel.status}
                        onValueChange={(value) => {
                          updateMutation.mutate({ id: selectedChannel.id, status: value });
                          setSelectedChannel({ ...selectedChannel, status: value });
                        }}
                        disabled={!canEdit}
                      >
                        <SelectTrigger className="h-11">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="paused">Paused</SelectItem>
                          <SelectItem value="pending_setup">Pending Setup</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-sm">Priority</Label>
                      <Input
                        className="w-full h-11"
                        type="number"
                        value={selectedChannel.priority}
                        onChange={(e) => {
                          const priority = parseInt(e.target.value) || 0;
                          updateMutation.mutate({ id: selectedChannel.id, priority });
                          setSelectedChannel({ ...selectedChannel, priority });
                        }}
                        disabled={!canEdit}
                        autoComplete="off"
                      />
                      <p className="text-xs text-muted-foreground">Higher priority syncs first</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                    <div>
                      <p className="font-medium">Primary Channel</p>
                      <p className="text-sm text-muted-foreground">
                        Make this the default channel for {selectedChannel.provider}
                      </p>
                    </div>
                    <Switch
                      checked={selectedChannel.isDefault === 1}
                      onCheckedChange={(checked) => {
                        updateMutation.mutate({ id: selectedChannel.id, isDefault: checked ? 1 : 0 });
                        setSelectedChannel({ ...selectedChannel, isDefault: checked ? 1 : 0 });
                      }}
                      disabled={!canEdit}
                    />
                  </div>
                </TabsContent>
                
                <TabsContent value="connection" className="space-y-4 mt-4">
                  {selectedChannel.connection ? (
                    <div className="space-y-4">
                      <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
                        {getSyncStatusIcon(selectedChannel.connection)}
                        <div className="flex-1">
                          <p className="font-medium capitalize">{selectedChannel.connection.syncStatus || 'Never synced'}</p>
                          {selectedChannel.connection.lastSyncAt && (
                            <p className="text-sm text-muted-foreground">
                              Last sync: {new Date(selectedChannel.connection.lastSyncAt).toLocaleString()}
                            </p>
                          )}
                        </div>
                        {selectedChannel.connection.shopDomain && (
                          <Button variant="outline" size="icon" className="min-h-[44px] min-w-[44px] shrink-0" asChild>
                            <a href={`https://${selectedChannel.connection.shopDomain}`} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                        )}
                      </div>

                      <Button
                        variant="outline"
                        className="w-full min-h-[44px]"
                        onClick={() => syncInventoryMutation.mutate(selectedChannel.id)}
                        disabled={syncInventoryMutation.isPending || !channelSyncEnabled}
                        title={!channelSyncEnabled ? "Channel sync is disabled — enable it above" : undefined}
                      >
                        <Upload className={`h-4 w-4 mr-2 ${syncInventoryMutation.isPending ? 'animate-spin' : ''}`} />
                        {syncInventoryMutation.isPending ? "Pushing inventory..." : "Push Inventory to Shopify"}
                      </Button>

                      {selectedChannel.connection.syncError && (
                        <div className="p-3 bg-destructive/10 text-destructive rounded-lg">
                          <p className="text-sm font-medium">Sync Error</p>
                          <p className="text-sm">{selectedChannel.connection.syncError}</p>
                        </div>
                      )}

                      {/* Shopify Location Mapping */}
                      {selectedChannel.provider === 'shopify' && (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <MapPin className="h-4 w-4 text-muted-foreground" />
                              <Label className="text-sm font-medium">Location Mapping</Label>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              className="min-h-[36px]"
                              onClick={() => fetchShopifyLocations(selectedChannel.id)}
                              disabled={locationsLoading}
                            >
                              <RefreshCw className={`h-3 w-3 mr-1 ${locationsLoading ? 'animate-spin' : ''}`} />
                              {shopifyLocations.length === 0 ? 'Load Locations' : 'Refresh'}
                            </Button>
                          </div>

                          {shopifyLocations.length > 0 ? (
                            <div className="space-y-2">
                              <p className="text-xs text-muted-foreground">
                                Map each Shopify location to an Echelon warehouse for inventory sync.
                              </p>
                              {shopifyLocations.map((loc) => (
                                <div key={loc.id} className="flex items-center gap-3 p-3 border rounded-lg">
                                  <div className="flex-1 min-w-0">
                                    <p className="font-medium text-sm truncate">{loc.name}</p>
                                    <p className="text-xs text-muted-foreground truncate">
                                      {[loc.address1, loc.city, loc.province].filter(Boolean).join(", ") || "No address"}
                                    </p>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    <Link2 className="h-3 w-3 text-muted-foreground" />
                                    <Select
                                      value={locationMappings[loc.id] != null ? String(locationMappings[loc.id]) : "none"}
                                      onValueChange={(val) => {
                                        setLocationMappings(prev => ({
                                          ...prev,
                                          [loc.id]: val === "none" ? null : parseInt(val),
                                        }));
                                      }}
                                    >
                                      <SelectTrigger className="w-[180px] h-9 text-sm">
                                        <SelectValue placeholder="Not mapped" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="none">Not mapped</SelectItem>
                                        {warehouses.map((wh) => (
                                          <SelectItem key={wh.id} value={String(wh.id)}>
                                            {wh.code} — {wh.name}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                </div>
                              ))}
                              <Button
                                className="w-full min-h-[44px] mt-2"
                                onClick={() => saveLocationMappings.mutate(selectedChannel.id)}
                                disabled={saveLocationMappings.isPending}
                              >
                                <Save className="h-4 w-4 mr-2" />
                                {saveLocationMappings.isPending ? "Saving..." : "Save Mappings"}
                              </Button>
                            </div>
                          ) : !locationsLoading ? (
                            <p className="text-sm text-muted-foreground text-center py-4">
                              Click "Load Locations" to fetch your Shopify locations and map them to warehouses.
                            </p>
                          ) : (
                            <div className="flex items-center justify-center py-6">
                              <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
                              <span className="ml-2 text-sm text-muted-foreground">Fetching locations from Shopify...</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="py-4">
                      {selectedChannel.provider === 'shopify' ? (
                        <div className="space-y-4">
                          <div className="flex items-center gap-2 mb-2">
                            <Store className="h-5 w-5 text-muted-foreground" />
                            <p className="font-medium">Connect to Shopify</p>
                          </div>
                          <div className="space-y-3">
                            <div>
                              <Label htmlFor="shopDomain" className="text-sm">Shop Domain</Label>
                              <Input
                                id="shopDomain"
                                placeholder="your-store.myshopify.com"
                                value={connectDomain}
                                onChange={(e) => setConnectDomain(e.target.value)}
                                className="mt-1"
                                spellCheck={false}
                              />
                            </div>
                            <div>
                              <Label htmlFor="accessToken" className="text-sm">Access Token</Label>
                              <Input
                                id="accessToken"
                                type="password"
                                placeholder="shpat_..."
                                value={connectToken}
                                onChange={(e) => setConnectToken(e.target.value)}
                                className="mt-1"
                                spellCheck={false}
                              />
                              <p className="text-xs text-muted-foreground mt-1">
                                Admin API access token from your Shopify custom app.
                              </p>
                            </div>
                          </div>
                          <Button
                            className="w-full min-h-[44px]"
                            disabled={!connectDomain || !connectToken || connecting}
                            onClick={async () => {
                              setConnecting(true);
                              try {
                                const res = await fetch(`/api/channels/${selectedChannel.id}/setup-shopify`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  credentials: 'include',
                                  body: JSON.stringify({ shopDomain: connectDomain, accessToken: connectToken }),
                                });
                                const data = await res.json();
                                if (!res.ok) {
                                  toast({
                                    title: "Connection failed",
                                    description: data.message || data.error,
                                    variant: "destructive"
                                  });
                                  return;
                                }
                                toast({ title: "Connected to Shopify!", description: `Shop: ${data.shop?.name}` });
                                setConnectDomain("");
                                setConnectToken("");
                                // Load locations from the setup response
                                if (data.locations?.length) {
                                  setShopifyLocations(data.locations);
                                  const map: Record<string, number | null> = {};
                                  for (const loc of data.locations) {
                                    const existing = (data.mappings || []).find((m: any) => m.shopifyLocationId === loc.id);
                                    map[loc.id] = existing ? existing.warehouseId : null;
                                  }
                                  setLocationMappings(map);
                                }
                                queryClient.invalidateQueries({ queryKey: ["/api/channels"] });
                                // Refresh selectedChannel to show connected state
                                const refreshRes = await fetch("/api/channels", { credentials: "include" });
                                if (refreshRes.ok) {
                                  const channels: Channel[] = await refreshRes.json();
                                  const updated = channels.find(c => c.id === selectedChannel.id);
                                  if (updated) setSelectedChannel(updated);
                                }
                              } catch (err) {
                                toast({ title: "Error", description: "Failed to connect", variant: "destructive" });
                              } finally {
                                setConnecting(false);
                              }
                            }}
                            data-testid="button-setup-shopify"
                          >
                            <Store className="h-4 w-4 mr-2" />
                            {connecting ? "Connecting..." : "Connect to Shopify"}
                          </Button>
                        </div>
                      ) : (
                        <Button className="mt-4 min-h-[44px]" variant="outline">
                          Configure Connection
                        </Button>
                      )}
                    </div>
                  )}
                  {/* eBay Connection & Config */}
                  {selectedChannel.provider === 'ebay' && (
                    <>
                    {ebaySettingsLoading ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : (
                      <>
                        {/* Connection Status */}
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                            <Label className="text-sm font-medium">Connection Status</Label>
                          </div>
                          <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 bg-muted rounded-lg">
                            <div className="flex items-center gap-3 flex-1">
                              {ebaySettings?.connected ? (
                                <Badge variant="default" className="bg-green-600 hover:bg-green-600 gap-1.5 py-1 px-3">
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  Connected
                                </Badge>
                              ) : (
                                <Badge variant="destructive" className="gap-1.5 py-1 px-3">
                                  <XCircle className="h-3.5 w-3.5" />
                                  Not Connected
                                </Badge>
                              )}
                              {ebaySettings?.ebayUsername && (
                                <span className="text-sm text-muted-foreground">
                                  Account: <strong className="text-foreground">{ebaySettings.ebayUsername}</strong>
                                </span>
                              )}
                              {ebaySettings?.tokenInfo?.environment && (
                                <Badge variant="outline" className="text-xs">{ebaySettings.tokenInfo.environment}</Badge>
                              )}
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              className="min-h-[36px] shrink-0"
                              onClick={() => window.open("/api/ebay/oauth/consent", "_blank")}
                            >
                              <ExternalLink className="h-4 w-4 mr-2" />
                              {ebaySettings?.connected ? "Reconnect" : "Connect eBay"}
                            </Button>
                          </div>
                          {ebaySettings?.tokenInfo && (
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-muted-foreground">
                              <div className="flex items-center gap-1">
                                <Clock className="h-3 w-3 shrink-0" />
                                Access expires: <span className="text-foreground font-medium">{new Date(ebaySettings.tokenInfo.accessTokenExpiresAt).toLocaleDateString()}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                <Clock className="h-3 w-3 shrink-0" />
                                Refresh expires: <span className="text-foreground font-medium">{ebaySettings.tokenInfo.refreshTokenExpiresAt ? new Date(ebaySettings.tokenInfo.refreshTokenExpiresAt).toLocaleDateString() : "N/A"}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                <Clock className="h-3 w-3 shrink-0" />
                                Last refreshed: <span className="text-foreground font-medium">{ebaySettings.tokenInfo.lastRefreshedAt ? new Date(ebaySettings.tokenInfo.lastRefreshedAt).toLocaleDateString() : "Never"}</span>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Merchant Location */}
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <MapPin className="h-4 w-4 text-muted-foreground" />
                            <Label className="text-sm font-medium">Merchant Location</Label>
                          </div>
                          {ebayHasLocation && ebaySettings?.config?.merchantLocation ? (
                            <div className="flex items-start gap-3 p-3 border rounded-lg">
                              <Badge variant="default" className="bg-green-600 hover:bg-green-600 gap-1.5 py-1 px-3 shrink-0 mt-0.5">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Active
                              </Badge>
                              <div className="text-sm">
                                <p className="font-medium">{ebaySettings.config.merchantLocation.name}</p>
                                <p className="text-muted-foreground">
                                  {ebaySettings.config.merchantLocation.addressLine1}
                                  {ebaySettings.config.merchantLocation.addressLine2 && `, ${ebaySettings.config.merchantLocation.addressLine2}`}
                                </p>
                                <p className="text-muted-foreground">
                                  {ebaySettings.config.merchantLocation.city}, {ebaySettings.config.merchantLocation.stateOrProvince} {ebaySettings.config.merchantLocation.postalCode}
                                </p>
                                <p className="text-xs text-muted-foreground mt-1">
                                  Key: <code className="bg-muted px-1 rounded">{ebaySettings.config.merchantLocationKey}</code>
                                </p>
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-3 p-3 border rounded-lg">
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <Label htmlFor="ebay-loc-name" className="text-xs">Location Name</Label>
                                  <Input id="ebay-loc-name" className="h-9 text-sm" value={ebayLocationForm.name} onChange={(e) => setEbayLocationForm({ ...ebayLocationForm, name: e.target.value })} />
                                </div>
                                <div>
                                  <Label htmlFor="ebay-loc-key" className="text-xs">Location Key</Label>
                                  <Input id="ebay-loc-key" className="h-9 text-sm" value={ebayLocationForm.merchantLocationKey} onChange={(e) => setEbayLocationForm({ ...ebayLocationForm, merchantLocationKey: e.target.value })} />
                                </div>
                              </div>
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <Label htmlFor="ebay-loc-addr1" className="text-xs">Address Line 1</Label>
                                  <Input id="ebay-loc-addr1" className="h-9 text-sm" value={ebayLocationForm.addressLine1} onChange={(e) => setEbayLocationForm({ ...ebayLocationForm, addressLine1: e.target.value })} />
                                </div>
                                <div>
                                  <Label htmlFor="ebay-loc-addr2" className="text-xs">Address Line 2</Label>
                                  <Input id="ebay-loc-addr2" className="h-9 text-sm" value={ebayLocationForm.addressLine2} onChange={(e) => setEbayLocationForm({ ...ebayLocationForm, addressLine2: e.target.value })} />
                                </div>
                              </div>
                              <div className="grid grid-cols-4 gap-3">
                                <div>
                                  <Label htmlFor="ebay-loc-city" className="text-xs">City</Label>
                                  <Input id="ebay-loc-city" className="h-9 text-sm" value={ebayLocationForm.city} onChange={(e) => setEbayLocationForm({ ...ebayLocationForm, city: e.target.value })} />
                                </div>
                                <div>
                                  <Label htmlFor="ebay-loc-state" className="text-xs">State</Label>
                                  <Input id="ebay-loc-state" className="h-9 text-sm" value={ebayLocationForm.stateOrProvince} onChange={(e) => setEbayLocationForm({ ...ebayLocationForm, stateOrProvince: e.target.value })} />
                                </div>
                                <div>
                                  <Label htmlFor="ebay-loc-zip" className="text-xs">ZIP</Label>
                                  <Input id="ebay-loc-zip" className="h-9 text-sm" value={ebayLocationForm.postalCode} onChange={(e) => setEbayLocationForm({ ...ebayLocationForm, postalCode: e.target.value })} />
                                </div>
                                <div>
                                  <Label htmlFor="ebay-loc-country" className="text-xs">Country</Label>
                                  <Input id="ebay-loc-country" className="h-9 text-sm" value={ebayLocationForm.country} onChange={(e) => setEbayLocationForm({ ...ebayLocationForm, country: e.target.value })} />
                                </div>
                              </div>
                              <Button
                                size="sm"
                                className="min-h-[36px]"
                                onClick={() => createEbayLocationMutation.mutate()}
                                disabled={createEbayLocationMutation.isPending || !ebaySettings?.connected}
                              >
                                {createEbayLocationMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                                <MapPin className="h-4 w-4 mr-2" />
                                Create Location on eBay
                              </Button>
                              {!ebaySettings?.connected && (
                                <p className="text-xs text-muted-foreground">Connect to eBay first.</p>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Business Policies */}
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-muted-foreground" />
                            <Label className="text-sm font-medium">Business Policies</Label>
                          </div>
                          {!ebaySettings?.connected ? (
                            <p className="text-sm text-muted-foreground p-3 bg-muted rounded-lg">Connect to eBay to load business policies.</p>
                          ) : ebayPoliciesLoading ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground p-3">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Loading policies from eBay...
                            </div>
                          ) : (
                            <div className="space-y-3 p-3 border rounded-lg">
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <div>
                                  <Label className="text-xs">Fulfillment (Shipping)</Label>
                                  <Select value={ebayPolicySelections.fulfillmentPolicyId} onValueChange={(v) => setEbayPolicySelections({ ...ebayPolicySelections, fulfillmentPolicyId: v })}>
                                    <SelectTrigger className="mt-1 h-9 text-sm"><SelectValue placeholder="Select..." /></SelectTrigger>
                                    <SelectContent>
                                      {(ebayPolicies?.fulfillmentPolicies || []).map((p) => (
                                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div>
                                  <Label className="text-xs">Return Policy</Label>
                                  <Select value={ebayPolicySelections.returnPolicyId} onValueChange={(v) => setEbayPolicySelections({ ...ebayPolicySelections, returnPolicyId: v })}>
                                    <SelectTrigger className="mt-1 h-9 text-sm"><SelectValue placeholder="Select..." /></SelectTrigger>
                                    <SelectContent>
                                      {(ebayPolicies?.returnPolicies || []).map((p) => (
                                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div>
                                  <Label className="text-xs">Payment Policy</Label>
                                  <Select value={ebayPolicySelections.paymentPolicyId} onValueChange={(v) => setEbayPolicySelections({ ...ebayPolicySelections, paymentPolicyId: v })}>
                                    <SelectTrigger className="mt-1 h-9 text-sm"><SelectValue placeholder="Select..." /></SelectTrigger>
                                    <SelectContent>
                                      {(ebayPolicies?.paymentPolicies || []).map((p) => (
                                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              </div>
                              <div className="flex items-center gap-3">
                                <Button
                                  size="sm"
                                  className="min-h-[36px]"
                                  onClick={() => saveEbayPoliciesMutation.mutate()}
                                  disabled={saveEbayPoliciesMutation.isPending || !ebayPolicySelections.fulfillmentPolicyId || !ebayPolicySelections.returnPolicyId || !ebayPolicySelections.paymentPolicyId}
                                >
                                  {saveEbayPoliciesMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                                  Save Policies
                                </Button>
                                {ebayHasPolicies && (
                                  <Badge variant="default" className="bg-green-600 hover:bg-green-600 gap-1.5 text-xs">
                                    <CheckCircle2 className="h-3 w-3" />
                                    All configured
                                  </Badge>
                                )}
                              </div>
                              {ebayPolicies && !ebayPolicies.fulfillmentPolicies.length && !ebayPolicies.returnPolicies.length && !ebayPolicies.paymentPolicies.length && (
                                <p className="text-xs text-muted-foreground">
                                  No policies found. Create them in your{" "}
                                  <a href="https://www.ebay.com/sh/sell-preferences/business-policies" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">eBay Seller Hub</a> first.
                                </p>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Listing Preview */}
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Eye className="h-4 w-4 text-muted-foreground" />
                              <Label className="text-sm font-medium">Listing Preview</Label>
                            </div>
                            <Button variant="outline" size="sm" className="min-h-[32px]" onClick={() => refetchEbayPreview()} disabled={ebayPreviewLoading}>
                              {ebayPreviewLoading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                              Refresh
                            </Button>
                          </div>
                          {ebayPreviewLoading ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                              <Loader2 className="h-4 w-4 animate-spin" /> Generating previews...
                            </div>
                          ) : !ebayPreviewData?.previews?.length ? (
                            <p className="text-sm text-muted-foreground py-4">No products available for preview.</p>
                          ) : (
                            <div className="space-y-3">
                              {ebayPreviewData.previews.map((preview) => (
                                <div key={preview.productId} className="border rounded-lg p-3 flex gap-3">
                                  <div className="shrink-0">
                                    {preview.images.length > 0 ? (
                                      <img src={preview.images[0]} alt={preview.title} className="w-16 h-16 object-cover rounded border bg-muted" />
                                    ) : (
                                      <div className="w-16 h-16 rounded border bg-muted flex items-center justify-center">
                                        <Package className="h-6 w-6 text-muted-foreground" />
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex-1 min-w-0 space-y-1">
                                    <div className="flex items-start justify-between gap-2">
                                      <h3 className="font-medium text-xs leading-snug line-clamp-2">{preview.title}</h3>
                                      {ebayHasLocation && ebayHasPolicies && (
                                        <Button variant="outline" size="sm" className="shrink-0 text-xs h-7 px-2" onClick={() => testEbayListingMutation.mutate(preview.productId)} disabled={testEbayListingMutation.isPending}>
                                          {testEbayListingMutation.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <ExternalLink className="h-3 w-3 mr-1" />}
                                          Test List
                                        </Button>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <Badge variant="outline" className="text-[10px] py-0 h-5">{preview.category}</Badge>
                                      <Badge variant="secondary" className="text-[10px] py-0 h-5">{preview.brand}</Badge>
                                    </div>
                                    {preview.variants.length > 0 && (
                                      <div className="flex flex-wrap gap-1">
                                        {preview.variants.slice(0, 4).map((v) => (
                                          <span key={v.sku} className="text-[10px] bg-muted rounded px-1.5 py-0.5">
                                            <span className="font-mono">{v.sku}</span> — <span className="font-medium">${v.price}</span>
                                          </span>
                                        ))}
                                        {preview.variants.length > 4 && <span className="text-[10px] text-muted-foreground">+{preview.variants.length - 4} more</span>}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Channel Stats */}
                        {ebaySettings?.connected && (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <BarChart3 className="h-4 w-4 text-muted-foreground" />
                              <Label className="text-sm font-medium">Channel Stats</Label>
                            </div>
                            {ebayStatsLoading ? (
                              <div className="flex items-center gap-2 text-sm text-muted-foreground p-3">
                                <Loader2 className="h-4 w-4 animate-spin" /> Loading stats...
                              </div>
                            ) : ebayStats ? (
                              <div className="grid grid-cols-3 gap-3">
                                <div className="border rounded-lg p-3 text-center">
                                  <p className="text-2xl font-bold">{ebayStats.totalOrders}</p>
                                  <p className="text-xs text-muted-foreground mt-1">Total Orders</p>
                                </div>
                                <div className="border rounded-lg p-3 text-center">
                                  <p className="text-2xl font-bold">{ebayStats.activeListings}</p>
                                  <p className="text-xs text-muted-foreground mt-1">Active Listings</p>
                                </div>
                                <div className="border rounded-lg p-3 text-center">
                                  <p className="text-sm font-medium">{ebayStats.lastSyncAt ? new Date(ebayStats.lastSyncAt).toLocaleDateString() : "Never"}</p>
                                  <p className="text-xs text-muted-foreground mt-1">Last Sync</p>
                                  <Badge variant={ebayStats.syncStatus === "ok" ? "default" : "secondary"} className={`mt-1 text-[10px] ${ebayStats.syncStatus === "ok" ? "bg-green-600" : ""}`}>
                                    {ebayStats.syncStatus}
                                  </Badge>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        )}

                        {/* Setup Checklist */}
                        {ebaySettings?.connected && (!ebayHasLocation || !ebayHasPolicies) && (
                          <div className="flex items-start gap-3 p-3 border border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/10 rounded-lg">
                            <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                            <div className="text-xs">
                              <p className="font-medium text-amber-800 dark:text-amber-400">Setup incomplete</p>
                              <ul className="mt-1 space-y-0.5 text-amber-700 dark:text-amber-500">
                                {!ebayHasLocation && <li>• Create a merchant location</li>}
                                {!ebayHasPolicies && <li>• Select business policies</li>}
                              </ul>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                    </>
                  )}
                </TabsContent>

                {selectedChannel.type === 'partner' && (
                  <TabsContent value="partner" className="space-y-4 mt-4">
                    {selectedChannel.partnerProfile ? (
                      <div className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <Label className="text-sm text-muted-foreground">Company</Label>
                            <p className="font-medium">{selectedChannel.partnerProfile.companyName}</p>
                          </div>
                          <div>
                            <Label className="text-sm text-muted-foreground">Contact</Label>
                            <p className="font-medium">{selectedChannel.partnerProfile.contactName || '-'}</p>
                          </div>
                          <div>
                            <Label className="text-sm text-muted-foreground">Email</Label>
                            <p className="font-medium">{selectedChannel.partnerProfile.contactEmail || '-'}</p>
                          </div>
                          <div>
                            <Label className="text-sm text-muted-foreground">Discount %</Label>
                            <p className="font-medium">{selectedChannel.partnerProfile.discountPercent}%</p>
                          </div>
                          <div>
                            <Label className="text-sm text-muted-foreground">SLA Days</Label>
                            <p className="font-medium">{selectedChannel.partnerProfile.slaDays} days</p>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-8">
                        <Building2 className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                        <p className="text-muted-foreground">No partner profile configured.</p>
                        <Button className="mt-4" variant="outline">
                          Add Partner Details
                        </Button>
                      </div>
                    )}
                  </TabsContent>
                )}
              </Tabs>
              
              {canDelete && (
                <div className="flex justify-end mt-4 pt-4 border-t">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      if (confirm('Are you sure you want to delete this channel?')) {
                        deleteMutation.mutate(selectedChannel.id);
                      }
                    }}
                    data-testid="button-delete-channel"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete Channel
                  </Button>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
