import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  MapPin,
  FileText,
  Eye,
  BarChart3,
  ExternalLink,
  RefreshCw,
  Store,
  ShieldCheck,
  Clock,
  Package,
  AlertCircle,
} from "lucide-react";
import { Separator } from "@/components/ui/separator";

// ============================================================================
// Types
// ============================================================================

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

interface Policy {
  id: string;
  name: string;
  description: string;
  marketplaceId: string;
}

interface PoliciesResponse {
  fulfillmentPolicies: Policy[];
  returnPolicies: Policy[];
  paymentPolicies: Policy[];
}

interface ListingPreview {
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

// ============================================================================
// Component
// ============================================================================

export default function EbaySettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ---- Queries ----

  const {
    data: settings,
    isLoading: settingsLoading,
    error: settingsError,
  } = useQuery<EbaySettings>({
    queryKey: ["/api/ebay/settings"],
  });

  const {
    data: policies,
    isLoading: policiesLoading,
  } = useQuery<PoliciesResponse>({
    queryKey: ["/api/ebay/policies"],
    enabled: !!settings?.connected,
  });

  const {
    data: previewData,
    isLoading: previewLoading,
    refetch: refetchPreview,
  } = useQuery<{ previews: ListingPreview[] }>({
    queryKey: ["/api/ebay/listings/preview"],
  });

  const {
    data: stats,
    isLoading: statsLoading,
  } = useQuery<EbayStats>({
    queryKey: ["/api/ebay/stats"],
    enabled: !!settings?.connected,
  });

  // ---- State for forms ----

  const [locationForm, setLocationForm] = useState({
    name: "Card Shellz HQ",
    addressLine1: "20 Leonberg Rd",
    addressLine2: "",
    city: "Cranberry Township",
    stateOrProvince: "PA",
    postalCode: "16066",
    country: "US",
    merchantLocationKey: "CARDSHELLZ_HQ",
  });

  const [policySelections, setPolicySelections] = useState({
    fulfillmentPolicyId: "",
    returnPolicyId: "",
    paymentPolicyId: "",
  });

  // Sync policy selections from settings when loaded
  const policySynced = useState(false);
  if (settings?.config && !policySynced[0]) {
    if (settings.config.fulfillmentPolicyId || settings.config.returnPolicyId || settings.config.paymentPolicyId) {
      setPolicySelections({
        fulfillmentPolicyId: settings.config.fulfillmentPolicyId || "",
        returnPolicyId: settings.config.returnPolicyId || "",
        paymentPolicyId: settings.config.paymentPolicyId || "",
      });
      policySynced[1](true);
    }
  }

  // ---- Mutations ----

  const createLocationMutation = useMutation({
    mutationFn: async () => {
      const resp = await apiRequest("POST", "/api/ebay/location", locationForm);
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

  const savePoliciesMutation = useMutation({
    mutationFn: async () => {
      const resp = await apiRequest("PUT", "/api/ebay/settings", policySelections);
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

  const testListingMutation = useMutation({
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

  // ---- Render ----

  if (settingsLoading) {
    return (
      <div className="flex items-center justify-center h-full py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (settingsError) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="py-10 text-center">
            <AlertCircle className="h-10 w-10 text-destructive mx-auto mb-3" />
            <p className="text-destructive font-medium">Failed to load eBay settings</p>
            <p className="text-sm text-muted-foreground mt-1">{(settingsError as Error).message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const hasLocation = !!settings?.config?.merchantLocationKey;
  const hasPolicies = !!(
    settings?.config?.fulfillmentPolicyId &&
    settings?.config?.returnPolicyId &&
    settings?.config?.paymentPolicyId
  );

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-5xl">
      {/* Page Header */}
      <div className="flex items-center gap-3">
        <div className="bg-blue-500/10 p-2 rounded-lg">
          <Store className="h-6 w-6 text-blue-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">eBay Channel Settings</h1>
          <p className="text-sm text-muted-foreground">
            Configure your eBay integration — connection, location, policies, and listings.
          </p>
        </div>
      </div>

      {/* 1. Connection Status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Connection Status
          </CardTitle>
          <CardDescription>eBay OAuth connection and token info</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex items-center gap-3 flex-1">
              {settings?.connected ? (
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

              {settings?.ebayUsername && (
                <span className="text-sm text-muted-foreground">
                  Account: <strong className="text-foreground">{settings.ebayUsername}</strong>
                </span>
              )}

              {settings?.tokenInfo?.environment && (
                <Badge variant="outline" className="text-xs">
                  {settings.tokenInfo.environment}
                </Badge>
              )}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open("/api/ebay/oauth/consent", "_blank")}
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              {settings?.connected ? "Reconnect" : "Connect eBay"}
            </Button>
          </div>

          {settings?.tokenInfo && (
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="h-4 w-4 shrink-0" />
                <span>Access token expires: </span>
                <span className="text-foreground font-medium">
                  {new Date(settings.tokenInfo.accessTokenExpiresAt).toLocaleString()}
                </span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="h-4 w-4 shrink-0" />
                <span>Refresh token expires: </span>
                <span className="text-foreground font-medium">
                  {settings.tokenInfo.refreshTokenExpiresAt
                    ? new Date(settings.tokenInfo.refreshTokenExpiresAt).toLocaleString()
                    : "N/A"}
                </span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="h-4 w-4 shrink-0" />
                <span>Last refreshed: </span>
                <span className="text-foreground font-medium">
                  {settings.tokenInfo.lastRefreshedAt
                    ? new Date(settings.tokenInfo.lastRefreshedAt).toLocaleString()
                    : "Never"}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2. Merchant Location */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Merchant Location
          </CardTitle>
          <CardDescription>
            {hasLocation
              ? "Your eBay merchant location is configured."
              : "Create a merchant location on eBay for inventory management."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hasLocation && settings?.config?.merchantLocation ? (
            <div className="flex items-start gap-3">
              <Badge variant="default" className="bg-green-600 hover:bg-green-600 gap-1.5 py-1 px-3 shrink-0 mt-0.5">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Active
              </Badge>
              <div className="text-sm">
                <p className="font-medium">{settings.config.merchantLocation.name}</p>
                <p className="text-muted-foreground">
                  {settings.config.merchantLocation.addressLine1}
                  {settings.config.merchantLocation.addressLine2 && `, ${settings.config.merchantLocation.addressLine2}`}
                </p>
                <p className="text-muted-foreground">
                  {settings.config.merchantLocation.city}, {settings.config.merchantLocation.stateOrProvince} {settings.config.merchantLocation.postalCode}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Key: <code className="bg-muted px-1 rounded">{settings.config.merchantLocationKey}</code>
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="loc-name">Location Name</Label>
                  <Input
                    id="loc-name"
                    value={locationForm.name}
                    onChange={(e) => setLocationForm({ ...locationForm, name: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="loc-key">Location Key</Label>
                  <Input
                    id="loc-key"
                    value={locationForm.merchantLocationKey}
                    onChange={(e) => setLocationForm({ ...locationForm, merchantLocationKey: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="loc-addr1">Address Line 1</Label>
                  <Input
                    id="loc-addr1"
                    value={locationForm.addressLine1}
                    onChange={(e) => setLocationForm({ ...locationForm, addressLine1: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="loc-addr2">Address Line 2</Label>
                  <Input
                    id="loc-addr2"
                    value={locationForm.addressLine2}
                    onChange={(e) => setLocationForm({ ...locationForm, addressLine2: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <Label htmlFor="loc-city">City</Label>
                  <Input
                    id="loc-city"
                    value={locationForm.city}
                    onChange={(e) => setLocationForm({ ...locationForm, city: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="loc-state">State</Label>
                  <Input
                    id="loc-state"
                    value={locationForm.stateOrProvince}
                    onChange={(e) => setLocationForm({ ...locationForm, stateOrProvince: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="loc-zip">Postal Code</Label>
                  <Input
                    id="loc-zip"
                    value={locationForm.postalCode}
                    onChange={(e) => setLocationForm({ ...locationForm, postalCode: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="loc-country">Country</Label>
                  <Input
                    id="loc-country"
                    value={locationForm.country}
                    onChange={(e) => setLocationForm({ ...locationForm, country: e.target.value })}
                  />
                </div>
              </div>
              <Button
                onClick={() => createLocationMutation.mutate()}
                disabled={createLocationMutation.isPending || !settings?.connected}
              >
                {createLocationMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                <MapPin className="h-4 w-4 mr-2" />
                Create Location on eBay
              </Button>
              {!settings?.connected && (
                <p className="text-xs text-muted-foreground">Connect to eBay first before creating a location.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 3. Business Policies */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Business Policies
          </CardTitle>
          <CardDescription>
            Select default fulfillment, return, and payment policies for eBay listings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!settings?.connected ? (
            <p className="text-sm text-muted-foreground">Connect to eBay to load business policies.</p>
          ) : policiesLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading policies from eBay...
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <Label>Fulfillment Policy (Shipping)</Label>
                  <Select
                    value={policySelections.fulfillmentPolicyId}
                    onValueChange={(v) => setPolicySelections({ ...policySelections, fulfillmentPolicyId: v })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select shipping policy..." />
                    </SelectTrigger>
                    <SelectContent>
                      {(policies?.fulfillmentPolicies || []).map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Return Policy</Label>
                  <Select
                    value={policySelections.returnPolicyId}
                    onValueChange={(v) => setPolicySelections({ ...policySelections, returnPolicyId: v })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select return policy..." />
                    </SelectTrigger>
                    <SelectContent>
                      {(policies?.returnPolicies || []).map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Payment Policy</Label>
                  <Select
                    value={policySelections.paymentPolicyId}
                    onValueChange={(v) => setPolicySelections({ ...policySelections, paymentPolicyId: v })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select payment policy..." />
                    </SelectTrigger>
                    <SelectContent>
                      {(policies?.paymentPolicies || []).map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {hasPolicies && (
                <Badge variant="default" className="bg-green-600 hover:bg-green-600 gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  All policies configured
                </Badge>
              )}

              <div>
                <Button
                  onClick={() => savePoliciesMutation.mutate()}
                  disabled={
                    savePoliciesMutation.isPending ||
                    !policySelections.fulfillmentPolicyId ||
                    !policySelections.returnPolicyId ||
                    !policySelections.paymentPolicyId
                  }
                >
                  {savePoliciesMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Save Policy Selections
                </Button>
              </div>

              {policies && !policies.fulfillmentPolicies.length && !policies.returnPolicies.length && !policies.paymentPolicies.length && (
                <p className="text-sm text-muted-foreground">
                  No business policies found. Create policies in your{" "}
                  <a
                    href="https://www.ebay.com/sh/sell-preferences/business-policies"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    eBay Seller Hub
                  </a>{" "}
                  first.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 4. Listing Preview */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5" />
                Listing Preview
              </CardTitle>
              <CardDescription>
                Preview how your products would appear on eBay.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetchPreview()}
              disabled={previewLoading}
            >
              {previewLoading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {previewLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              Generating previews...
            </div>
          ) : !previewData?.previews?.length ? (
            <p className="text-sm text-muted-foreground py-4">No products available for preview.</p>
          ) : (
            <div className="space-y-4">
              {previewData.previews.map((preview) => (
                <div
                  key={preview.productId}
                  className="border rounded-lg p-4 flex flex-col sm:flex-row gap-4"
                >
                  {/* Image */}
                  <div className="shrink-0">
                    {preview.images.length > 0 ? (
                      <img
                        src={preview.images[0]}
                        alt={preview.title}
                        className="w-24 h-24 object-cover rounded-md border bg-muted"
                      />
                    ) : (
                      <div className="w-24 h-24 rounded-md border bg-muted flex items-center justify-center">
                        <Package className="h-8 w-8 text-muted-foreground" />
                      </div>
                    )}
                  </div>

                  {/* Details */}
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-medium text-sm leading-snug line-clamp-2">
                        {preview.title}
                      </h3>
                      {hasLocation && hasPolicies && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0 text-xs"
                          onClick={() => testListingMutation.mutate(preview.productId)}
                          disabled={testListingMutation.isPending}
                        >
                          {testListingMutation.isPending ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <ExternalLink className="h-3 w-3 mr-1" />
                          )}
                          Test List
                        </Button>
                      )}
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-xs">
                        {preview.category}
                      </Badge>
                      <Badge variant="secondary" className="text-xs">
                        Cat #{preview.categoryId}
                      </Badge>
                      <Badge variant="secondary" className="text-xs">
                        {preview.brand}
                      </Badge>
                    </div>

                    {preview.description && (
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {preview.description}
                      </p>
                    )}

                    {preview.variants.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {preview.variants.map((v) => (
                          <div
                            key={v.sku}
                            className="text-xs bg-muted rounded px-2 py-1"
                          >
                            <span className="font-mono">{v.sku}</span>
                            <span className="text-muted-foreground mx-1">—</span>
                            <span className="font-medium">${v.price}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {preview.images.length > 1 && (
                      <div className="flex gap-1.5">
                        {preview.images.slice(1, 5).map((img, i) => (
                          <img
                            key={i}
                            src={img}
                            alt=""
                            className="w-10 h-10 object-cover rounded border bg-muted"
                          />
                        ))}
                        {preview.images.length > 5 && (
                          <div className="w-10 h-10 rounded border bg-muted flex items-center justify-center text-xs text-muted-foreground">
                            +{preview.images.length - 5}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 5. Channel Stats */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            Channel Stats
          </CardTitle>
          <CardDescription>eBay channel performance overview</CardDescription>
        </CardHeader>
        <CardContent>
          {!settings?.connected ? (
            <p className="text-sm text-muted-foreground">Connect to eBay to view channel stats.</p>
          ) : statsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading stats...
            </div>
          ) : stats ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="border rounded-lg p-4 text-center">
                <p className="text-3xl font-bold">{stats.totalOrders}</p>
                <p className="text-sm text-muted-foreground mt-1">Total Orders</p>
              </div>
              <div className="border rounded-lg p-4 text-center">
                <p className="text-3xl font-bold">{stats.activeListings}</p>
                <p className="text-sm text-muted-foreground mt-1">Active Listings</p>
              </div>
              <div className="border rounded-lg p-4 text-center">
                <p className="text-sm font-medium">
                  {stats.lastSyncAt
                    ? new Date(stats.lastSyncAt).toLocaleString()
                    : "Never"}
                </p>
                <p className="text-sm text-muted-foreground mt-1">Last Sync</p>
                <Badge
                  variant={stats.syncStatus === "ok" ? "default" : "secondary"}
                  className={`mt-2 text-xs ${stats.syncStatus === "ok" ? "bg-green-600" : ""}`}
                >
                  {stats.syncStatus}
                </Badge>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Setup Checklist */}
      {settings?.connected && (!hasLocation || !hasPolicies) && (
        <Card className="border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/10">
          <CardContent className="py-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-amber-800 dark:text-amber-400">Setup incomplete</p>
                <ul className="mt-1 space-y-1 text-amber-700 dark:text-amber-500">
                  {!hasLocation && <li>• Create a merchant location</li>}
                  {!hasPolicies && <li>• Select business policies (fulfillment, return, payment)</li>}
                </ul>
                <p className="mt-2 text-muted-foreground">Complete these steps before creating listings.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
