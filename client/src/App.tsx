import React from "react";
import { Switch, Route, useLocation, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SettingsProvider } from "@/lib/settings";
import { AuthProvider, useAuth } from "@/lib/auth";
import type { StaffSystemRole } from "@/lib/staff-authority";
import { StaffAccessNotice } from "@/components/staff-access-notice";
import { PURCHASING_DASHBOARD_READ_PERMISSIONS, PURCHASING_READ_PERMISSION, RECEIVING_READ_PERMISSIONS } from "@/lib/procurement-access";
import { VendorAuthProvider, useVendorAuth } from "@/lib/vendor-auth";
import { DropshipAuthProvider, dropshipPortalPath, isDropshipPortalHost, useDropshipAuth } from "@/lib/dropship-auth";
import { PWAUpdatePrompt } from "@/components/PWAUpdatePrompt";
import NotFound from "@/pages/not-found";
import {
  CUSTOMER_RETURN_PORTAL_PATH,
  CUSTOMER_RETURN_PORTAL_ACCESS_PATH,
  CUSTOMER_RETURN_PORTAL_LEGACY_PATH,
  isCustomerReturnPortalPath,
} from "@shared/returns/customer-return-portal-paths";

const Layout = React.lazy(() => import("@/components/layout/AppShell"));
const Login = React.lazy(() => import("@/pages/Login"));

const VendorLayout = React.lazy(() => import("@/components/vendor/VendorLayout"));
const VendorLogin = React.lazy(() => import("@/pages/vendor/VendorLogin"));
const VendorRegister = React.lazy(() => import("@/pages/vendor/VendorRegister"));
const VendorDashboard = React.lazy(() => import("@/pages/vendor/VendorDashboard"));
const VendorProducts = React.lazy(() => import("@/pages/vendor/VendorProducts"));
const VendorOrders = React.lazy(() => import("@/pages/vendor/VendorOrders"));
const VendorWallet = React.lazy(() => import("@/pages/vendor/VendorWallet"));
const VendorSettings = React.lazy(() => import("@/pages/vendor/VendorSettings"));
const DropshipPortalAuth = React.lazy(() => import("@/pages/dropship/DropshipPortalAuth"));
const DropshipPortalPrivacy = React.lazy(() => import("@/pages/dropship/DropshipPortalPrivacy"));
const DropshipPortalDashboard = React.lazy(() => import("@/pages/dropship/DropshipPortalDashboard"));
const DropshipPortalHome = React.lazy(() => import("@/pages/dropship/DropshipPortalHome"));
const DropshipPortalCatalog = React.lazy(() => import("@/pages/dropship/DropshipPortalCatalog"));
const DropshipPortalNotifications = React.lazy(() => import("@/pages/dropship/DropshipPortalNotifications"));
const DropshipPortalCostChanges = React.lazy(() => import("@/pages/dropship/DropshipPortalCostChanges"));
const DropshipPortalOnboarding = React.lazy(() => import("@/pages/dropship/DropshipPortalOnboarding"));
const DropshipPortalOrders = React.lazy(() => import("@/pages/dropship/DropshipPortalOrders"));
const DropshipPortalReturns = React.lazy(() => import("@/pages/dropship/DropshipPortalReturns"));
const DropshipPortalSettings = React.lazy(() => import("@/pages/dropship/DropshipPortalSettings"));
const DropshipPortalWallet = React.lazy(() => import("@/pages/dropship/DropshipPortalWallet"));
const Dashboard = React.lazy(() => import("@/pages/Dashboard"));
const Inventory = React.lazy(() => import("@/pages/Inventory"));
const Builds = React.lazy(() => import("@/pages/Builds"));
const SupplyTransformations = React.lazy(() => import("@/pages/SupplyTransformations"));
const InventoryCutover = React.lazy(() => import("@/pages/InventoryCutover"));
const ProcurementPromiseSafetySettings = React.lazy(() => import("@/pages/ProcurementPromiseSafetySettings"));
const ChannelInventory = React.lazy(() => import("@/pages/ChannelInventory"));
const BuildRecipeCreate = React.lazy(() => import("@/pages/BuildRecipeCreate"));
const Orders = React.lazy(() => import("@/pages/Orders"));
const Dropship = React.lazy(() => import("@/pages/Dropship"));
const Subscriptions = React.lazy(() => import("@/pages/Subscriptions"));
const PickingPage = React.lazy(() => import("@/pages/PickingPage"));
const PickPriority = React.lazy(() => import("@/pages/PickPriority"));
const OrderHistory = React.lazy(() => import("@/pages/OrderHistory"));
const WarehousePage = React.lazy(() => import("@/pages/WarehousePage"));
const PickZones = React.lazy(() => import("@/pages/PickZones"));
const WarehouseSettingsPage = React.lazy(() => import("@/pages/WarehouseSettingsPage"));
const WorkConfigurationPage = React.lazy(() => import("@/pages/warehouse-work/WorkConfigurationPage"));
const AssemblyWorkPage = React.lazy(() => import("@/pages/warehouse-work/AssemblyWorkPage"));
const Integrations = React.lazy(() => import("@/pages/Integrations"));
const Users = React.lazy(() => import("@/pages/Users"));
const Roles = React.lazy(() => import("@/pages/Roles"));
const ChannelsPage = React.lazy(() => import("@/pages/ChannelsPage"));
const CatalogPage = React.lazy(() => import("@/pages/CatalogPage"));
const ProductDetail = React.lazy(() => import("@/pages/ProductDetail"));
const CycleCounts = React.lazy(() => import("@/pages/CycleCounts"));
const Transfers = React.lazy(() => import("@/pages/Transfers"));
const Suppliers = React.lazy(() => import("@/pages/Suppliers"));
const PurchasingView = React.lazy(() => import("@/pages/PurchasingView"));
const ReorderEngine = React.lazy(() => import("@/pages/ReorderEngine"));
const ProcurementAutomation = React.lazy(() => import("@/pages/ProcurementAutomation"));
const ProcurementRuns = React.lazy(() => import("@/pages/ProcurementRuns"));
const ProcurementRfqs = React.lazy(() => import("@/pages/ProcurementRfqs"));
const Receiving = React.lazy(() => import("@/pages/Receiving"));
const InventoryHistory = React.lazy(() => import("@/pages/InventoryHistory"));
const Replenishment = React.lazy(() => import("@/pages/Replenishment"));
const SlottingSetup = React.lazy(() => import("@/pages/SlottingSetup"));
const ChannelAllocation = React.lazy(() => import("@/pages/ChannelAllocation"));
const ProductLines = React.lazy(() => import("@/pages/ProductLines"));
const ShippingGroups = React.lazy(() => import("@/pages/ShippingGroups"));
const PurchaseOrders = React.lazy(() => import("@/pages/PurchaseOrders"));
const PurchaseOrderDetail = React.lazy(() => import("@/pages/PurchaseOrderDetail"));
const PurchaseOrderEdit = React.lazy(() => import("@/pages/PurchaseOrderEdit"));
const PurchasingDashboard = React.lazy(() => import("@/pages/PurchasingDashboard"));
const Returns = React.lazy(() => import("@/pages/Returns"));
const ReturnLabelSettings = React.lazy(() => import("@/pages/ReturnLabelSettings"));
const ReturnCases = React.lazy(() => import("@/pages/ReturnCases"));
const ReturnPolicies = React.lazy(() => import("@/pages/ReturnPolicies"));
const CustomerReturnPortalPreview = React.lazy(() => import("@/pages/CustomerReturnPortalPreview"));
const CustomerReturnCustomerPortal = React.lazy(() => import("@/pages/CustomerReturnCustomerPortal"));
const CustomerReturnPortalAccess = React.lazy(() => import("@/pages/CustomerReturnPortalAccess"));
const InboundShipments = React.lazy(() => import("@/pages/InboundShipments"));
const OutboundShipments = React.lazy(() => import("@/pages/OutboundShipments"));
const ShipmentOrderContext = React.lazy(() => import("@/pages/ShipmentOrderContext"));
const InboundShipmentDetail = React.lazy(() => import("@/pages/InboundShipmentDetail"));
const CostDashboard = React.lazy(() => import("@/pages/CostDashboard"));
const APDashboard = React.lazy(() => import("@/pages/APDashboard"));
const APInvoices = React.lazy(() => import("@/pages/APInvoices"));
const APInvoiceDetail = React.lazy(() => import("@/pages/APInvoiceDetail"));
const APPayments = React.lazy(() => import("@/pages/APPayments"));
const SupplierCredits = React.lazy(() => import("@/pages/SupplierCredits"));
const SupplierReturns = React.lazy(() => import("@/pages/SupplierReturns"));
const StaffPasswordChange = React.lazy(() =>
  import("@/components/identity/StaffPasswordChange").then((m) => ({ default: m.StaffPasswordChange })),
);
const Settings = React.lazy(() => import("@/pages/Settings"));
const ProcurementSettings = React.lazy(() => import("@/pages/ProcurementSettings"));
const ShippingSettings = React.lazy(() => import("@/pages/ShippingSettings"));
const ShippingServiceLevels = React.lazy(() => import("@/pages/ShippingServiceLevels"));
const ShippingServiceLevelDetail = React.lazy(() => import("@/pages/ShippingServiceLevelDetail"));
const NotificationPreferences = React.lazy(() => import("@/pages/NotificationPreferences"));
const EbayChannelPage = React.lazy(() => import("@/pages/EbayChannelPage"));
const WalmartChannelRouteHost = React.lazy(() =>
  import("@/pages/WalmartChannelPage").then((m) => ({ default: m.WalmartChannelRouteHost })),
);
const ShopifyChannelPage = React.lazy(() => import("@/pages/ShopifyChannelPage"));
const SyncLogPage = React.lazy(() => import("@/pages/SyncLogPage"));
const OmsOrders = React.lazy(() => import("@/pages/OmsOrders"));
const OrderEdits = React.lazy(() => import("@/pages/OrderEdits"));
const FlowMonitor = React.lazy(() => import("@/pages/FlowMonitor"));
const VendorList = React.lazy(() => import("@/pages/VendorList"));
const VendorDetail = React.lazy(() => import("@/pages/VendorDetail"));
const DemandPlanner = React.lazy(() => import("@/pages/DemandPlanner"));

function RouteSuspenseFallback({ fullScreen = false }: { fullScreen?: boolean }) {
  return (
    <div className={`flex items-center justify-center ${fullScreen ? "min-h-screen" : "min-h-[50vh]"}`}>
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
    </div>
  );
}

function DeferredWalmartChannelRouteHost() {
  const [location] = useLocation();
  const isWalmartRoute = /^\/channels\/walmart\/[1-9]\d*(?:\/listings\/bulk)?$/.test(location);
  const [activated, setActivated] = React.useState(isWalmartRoute);

  React.useEffect(() => {
    if (isWalmartRoute) setActivated(true);
  }, [isWalmartRoute]);

  if (!activated && !isWalmartRoute) return null;

  return (
    <React.Suspense fallback={null}>
      <WalmartChannelRouteHost />
    </React.Suspense>
  );
}

// Reorder Engine feature-flag switch (design spec §4.6, PR 2). Reads the
// procurement settings and renders the new cockpit when `useNewReorderCockpit`
// is on; the legacy PurchasingView otherwise. Fail-safe: any settings-load
// error falls back to the legacy page. The legacy page also stays directly
// reachable at /reorder-analysis/legacy.
function ReorderAnalysisRoute() {
  type ProcurementSettings = { useNewReorderCockpit?: boolean; [key: string]: unknown };
  const { data: procurementSettings, isLoading } = useQuery<ProcurementSettings>({
    queryKey: ["/api/settings/procurement"],
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (procurementSettings?.useNewReorderCockpit === true) {
    return <ReorderEngine />;
  }
  return <PurchasingView />;
}

function ProtectedRoute({
  component: Component,
  allowedSystemRoles,
  requiredPermission,
  anyOfPermissions,
  allOfPermissions,
}: { 
  component: React.ComponentType;
  allowedSystemRoles?: StaffSystemRole[];
  requiredPermission?: { resource: string; action: string };
  anyOfPermissions?: { resource: string; action: string }[];
  allOfPermissions?: { resource: string; action: string }[];
}) {
  const { user, isLoading, hasPermission, hasSystemRole, assignedRoles, accessStatus } = useAuth();
  
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }
  
  if (accessStatus === "unverified") return <StaffAccessNotice />;
  if (!user) {
    return <Redirect to="/login" />;
  }
  
  if (assignedRoles.length === 0) return <StaffAccessNotice />;
  if (allowedSystemRoles && !allowedSystemRoles.some(hasSystemRole)) {
    return <StaffAccessNotice denied />;
  }
  if (
    requiredPermission
    && !hasPermission(requiredPermission.resource, requiredPermission.action)
  ) {
    return <StaffAccessNotice denied />;
  }
  if (anyOfPermissions && !anyOfPermissions.some(permission => hasPermission(permission.resource, permission.action))) {
    return <StaffAccessNotice denied />;
  }
  if (allOfPermissions && !allOfPermissions.every(permission => hasPermission(permission.resource, permission.action))) {
    return <StaffAccessNotice denied />;
  }
  
  return <Component />;
}

function VendorProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAuthenticated, isLoading } = useVendorAuth();
  
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-red-600"></div>
      </div>
    );
  }
  
  if (!isAuthenticated) {
    return <Redirect to="/vendor/login" />;
  }
  
  return (
    <VendorLayout>
      <Component />
    </VendorLayout>
  );
}

function VendorRouter() {
  return (
    <VendorAuthProvider>
      <Switch>
        <Route path="/vendor/login" component={VendorLogin} />
        <Route path="/vendor/register" component={VendorRegister} />
        <Route path="/vendor/dashboard">
          <VendorProtectedRoute component={VendorDashboard} />
        </Route>
        <Route path="/vendor/products">
          <VendorProtectedRoute component={VendorProducts} />
        </Route>
        <Route path="/vendor/orders">
          <VendorProtectedRoute component={VendorOrders} />
        </Route>
        <Route path="/vendor/wallet">
          <VendorProtectedRoute component={VendorWallet} />
        </Route>
        <Route path="/vendor/settings">
          <VendorProtectedRoute component={VendorSettings} />
        </Route>
        <Route path="/vendor">
          <Redirect to="/vendor/dashboard" />
        </Route>
      </Switch>
    </VendorAuthProvider>
  );
}

function DropshipPortalProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAuthenticated, isLoading } = useDropshipAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-emerald-600"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Redirect to={dropshipPortalPath("/login")} />;
  }

  return <Component />;
}

function DropshipPortalRouter() {
  const portalRoot = isDropshipPortalHost() ? "" : "/dropship-portal";

  return (
    <DropshipAuthProvider>
      <Switch>
        <Route path={`${portalRoot}/login`} component={DropshipPortalAuth} />
        <Route path={`${portalRoot}/setup`} component={DropshipPortalAuth} />
        {/* Public on purpose: vendors read it before signing in, and payment
            providers reviewing our data use open it without an account. */}
        <Route path={`${portalRoot}/privacy`} component={DropshipPortalPrivacy} />
        <Route path={`${portalRoot}/home`}>
          <DropshipPortalProtectedRoute component={DropshipPortalHome} />
        </Route>
        <Route path={`${portalRoot}/onboarding`}>
          <DropshipPortalProtectedRoute component={DropshipPortalOnboarding} />
        </Route>
        <Route path={`${portalRoot}/dashboard`}>
          <DropshipPortalProtectedRoute component={DropshipPortalDashboard} />
        </Route>
        {/* One page for every step, so the vendor's work survives moving between them. */}
        <Route path={`${portalRoot}/catalog/:step?`}>
          <DropshipPortalProtectedRoute component={DropshipPortalCatalog} />
        </Route>
        <Route path={`${portalRoot}/orders`}>
          <DropshipPortalProtectedRoute component={DropshipPortalOrders} />
        </Route>
        <Route path={`${portalRoot}/wallet`}>
          <DropshipPortalProtectedRoute component={DropshipPortalWallet} />
        </Route>
        <Route path={`${portalRoot}/returns`}>
          <DropshipPortalProtectedRoute component={DropshipPortalReturns} />
        </Route>
        <Route path={`${portalRoot}/settings`}>
          <DropshipPortalProtectedRoute component={DropshipPortalSettings} />
        </Route>
        <Route path={`${portalRoot}/notifications`}>
          <DropshipPortalProtectedRoute component={DropshipPortalNotifications} />
        </Route>
        <Route path={`${portalRoot}/cost-changes`}>
          <DropshipPortalProtectedRoute component={DropshipPortalCostChanges} />
        </Route>
        <Route path={portalRoot || "/"}>
          <Redirect to={dropshipPortalPath("/home")} />
        </Route>
        <Route component={DropshipPortalAuth} />
      </Switch>
    </DropshipAuthProvider>
  );
}

function Router() {
  const [location] = useLocation();
  const { user, isLoading, accessStatus, assignedRoles, hasPermission, hasSystemRole,credentialActionRequired } = useAuth();

  // The prelaunch customer experience has its own access screen and never
  // renders the warehouse application shell, including during sign-in.
  if (isCustomerReturnPortalPath(location)) {
    return (
      <Switch>
        <Route path="/customer-returns" component={CustomerReturnCustomerPortal} />
        <Route path={CUSTOMER_RETURN_PORTAL_ACCESS_PATH} component={CustomerReturnPortalAccess} />
        <Route path={CUSTOMER_RETURN_PORTAL_PATH} component={CustomerReturnPortalPreview} />
        <Route path={CUSTOMER_RETURN_PORTAL_LEGACY_PATH}><Redirect to={CUSTOMER_RETURN_PORTAL_PATH} /></Route>
        <Route component={NotFound} />
      </Switch>
    );
  }

  if (isDropshipPortalHost() || location.startsWith("/dropship-portal")) {
    return <DropshipPortalRouter />;
  }

  // Vendor portal routes — completely separate auth
  if (location.startsWith("/vendor")) {
    return <VendorRouter />;
  }

  if (location === "/login") {
    return <Login />;
  }
  
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }
  
  if (accessStatus === "unverified") return <StaffAccessNotice />;
  if (!user) {
    return <Redirect to="/login" />;
  }

  if(credentialActionRequired || location === "/staff/password") return <StaffPasswordChange/>;

  if (assignedRoles.length === 0) return <StaffAccessNotice />;

  const landingPath = [
    { path: "/picking", allowed: hasPermission("picking", "view") },
    { path: "/picking/logs", allowed: hasPermission("picking", "view_logs") },
    { path: "/picking/metrics", allowed: hasPermission("picking", "view_metrics") },
    { path: "/picking/settings", allowed: hasPermission("picking", "manage_settings") },
    { path: "/users", allowed: hasPermission("users", "view") },
    { path: "/roles", allowed: hasPermission("roles", "view") },
    { path: "/channels", allowed: hasPermission("channels", "view") },
    { path: "/inventory/supply-transformations", allowed: hasPermission("inventory_planning", "view") },
    { path: "/assembly", allowed: hasPermission("warehouse_work", "assembly") },
    { path: "/order-edits", allowed: hasPermission("orders", "edit") },
    { path: "/outbound-shipments", allowed: hasPermission("shipments", "view") },
    { path: "/purchase-orders", allowed: hasPermission("purchasing", "view") },
    { path: "/receiving", allowed: RECEIVING_READ_PERMISSIONS.some(permission => hasPermission(permission.resource, permission.action)) },
    { path: "/dropship", allowed: hasPermission("dropship", "view") },
    { path: "/subscriptions", allowed: hasPermission("shellz", "admin") },
    { path: "/settings", allowed: hasPermission("settings", "view") },
    { path: "/orders", allowed: hasPermission("orders", "view") },
  ].find(candidate => candidate.allowed)?.path;

  return (
    <Layout>
      <DeferredWalmartChannelRouteHost key={user.id} />
      <React.Suspense fallback={<RouteSuspenseFallback />}>
      <Switch>
        <Route path="/">
          {hasPermission("inventory", "view") ? <Dashboard /> : landingPath ? <Redirect to={landingPath} /> : <StaffAccessNotice />}
        </Route>
        <Route path="/inventory">
          <ProtectedRoute component={Inventory} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/inventory/builds/recipes/new">
          <ProtectedRoute component={BuildRecipeCreate} allOfPermissions={[{ resource: "inventory", action: "view" }, { resource: "inventory", action: "adjust" }]} />
        </Route>
        <Route path="/inventory/builds/recipes/:recipeId/edit">
          <ProtectedRoute component={BuildRecipeCreate} allOfPermissions={[{ resource: "inventory", action: "view" }, { resource: "inventory", action: "adjust" }]} />
        </Route>
        <Route path="/inventory/builds">
          <ProtectedRoute component={Builds} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/inventory/cutover">
          <ProtectedRoute
            component={InventoryCutover}
            requiredPermission={{ resource: "inventory_planning", action: "view" }}
          />
        </Route>
        <Route path="/inventory/supply-transformations">
          <ProtectedRoute
            component={SupplyTransformations}
            requiredPermission={{ resource: "inventory_planning", action: "view" }}
          />
        </Route>
        <Route path="/cycle-counts">
          <ProtectedRoute component={CycleCounts} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/slotting-setup">
          <ProtectedRoute component={SlottingSetup} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/bin-assignments">
          <ProtectedRoute component={SlottingSetup} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/transfers">
          <ProtectedRoute component={Transfers} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/orders">
          <ProtectedRoute component={Orders} requiredPermission={{ resource: "orders", action: "view" }} />
        </Route>
        <Route path="/dropship">
          <ProtectedRoute component={Dropship} requiredPermission={{ resource: "dropship", action: "view" }} />
        </Route>
        <Route path="/subscriptions">
          <ProtectedRoute component={Subscriptions} requiredPermission={{ resource: "shellz", action: "admin" }} />
        </Route>
        <Route path="/vendors/:id">
          <ProtectedRoute component={VendorDetail} requiredPermission={{ resource: "dropship", action: "view" }} />
        </Route>
        <Route path="/vendors">
          <ProtectedRoute component={VendorList} requiredPermission={{ resource: "dropship", action: "view" }} />
        </Route>
        <Route path="/picking">
          <ProtectedRoute component={PickingPage} requiredPermission={{ resource: "picking", action: "view" }} />
        </Route>
        <Route path="/picking/logs">
          <ProtectedRoute component={PickingPage} requiredPermission={{ resource: "picking", action: "view_logs" }} />
        </Route>
        <Route path="/picking/metrics">
          <ProtectedRoute component={PickingPage} requiredPermission={{ resource: "picking", action: "view_metrics" }} />
        </Route>
        <Route path="/picking/settings">
          <ProtectedRoute component={PickingPage} requiredPermission={{ resource: "picking", action: "manage_settings" }} />
        </Route>
        <Route path="/pick-priority">
          <ProtectedRoute component={PickPriority} requiredPermission={{ resource: "settings", action: "view" }} />
        </Route>
        <Route path="/packing">
          <StaffAccessNotice denied />
        </Route>
        <Route path="/order-history">
          <ProtectedRoute component={OrderHistory} requiredPermission={{ resource: "orders", action: "view" }} />
        </Route>
        <Route path="/warehouse/locations">
          <ProtectedRoute component={WarehousePage} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/warehouse/packaging">
          <ProtectedRoute component={WarehousePage} requiredPermission={{ resource: "settings", action: "view" }} />
        </Route>
        <Route path="/warehouse">
          <ProtectedRoute component={WarehousePage} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/pick-zones">
          <ProtectedRoute component={PickZones} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/warehouse/settings/:id">
          <ProtectedRoute component={WarehouseSettingsPage} requiredPermission={{ resource: "warehouse", action: "read" }} />
        </Route>
        <Route path="/warehouse/workflows/:id">
          <ProtectedRoute component={WorkConfigurationPage} requiredPermission={{ resource: "warehouse_work", action: "view" }} />
        </Route>
        <Route path="/assembly">
          <ProtectedRoute component={AssemblyWorkPage} requiredPermission={{ resource: "warehouse_work", action: "assembly" }} />
        </Route>
        <Route path="/integrations">
          <ProtectedRoute component={Integrations} requiredPermission={{ resource: "settings", action: "edit" }} />
        </Route>
        <Route path="/users">
          <ProtectedRoute component={Users} requiredPermission={{ resource: "users", action: "view" }} />
        </Route>
        <Route path="/roles">
          <ProtectedRoute component={Roles} requiredPermission={{ resource: "roles", action: "view" }} />
        </Route>
        <Route path="/sync-log">
          <ProtectedRoute component={SyncLogPage} requiredPermission={{ resource: "channels", action: "view" }} />
        </Route>
        <Route path="/oms/orders">
          <ProtectedRoute component={OmsOrders} requiredPermission={{ resource: "orders", action: "view" }} />
        </Route>
        <Route path="/order-edits">
          <ProtectedRoute component={OrderEdits} requiredPermission={{ resource: "orders", action: "edit" }} />
        </Route>
        <Route path="/oms/flow-monitor">
          <ProtectedRoute component={FlowMonitor} requiredPermission={{ resource: "operations", action: "view" }} />
        </Route>
        <Route path="/channels/shopify">
          <ProtectedRoute component={ShopifyChannelPage} anyOfPermissions={[{ resource: "channels", action: "view" }, { resource: "shopify", action: "view" }]} />
        </Route>
        <Route path="/channels/ebay">
          <ProtectedRoute component={EbayChannelPage} requiredPermission={{ resource: "channels", action: "view" }} />
        </Route>
        <Route path={/^\/channels\/walmart\/[1-9]\d*(?:\/listings\/bulk)?$/}>
          {hasPermission("channels", "view") ? null : <StaffAccessNotice denied />}
        </Route>
        <Route path="/channels/inventory">
          <ProtectedRoute
            component={ChannelInventory}
            requiredPermission={{ resource: "inventory_planning", action: "view" }}
          />
        </Route>
        {/* Bookmark compatibility: the page formerly named Inventory Exposure. */}
        <Route path="/channels/inventory-exposure">
          <Redirect to="/channels/inventory" replace />
        </Route>
        <Route path="/channels">
          <ProtectedRoute component={ChannelsPage} requiredPermission={{ resource: "channels", action: "view" }} />
        </Route>
        <Route path="/channels/reserves">
          <ProtectedRoute component={ChannelsPage} requiredPermission={{ resource: "channels", action: "view" }} />
        </Route>
        <Route path="/product-lines">
          <ProtectedRoute component={ProductLines} requiredPermission={{ resource: "channels", action: "view" }} />
        </Route>
        <Route path="/shipping-groups">
          <ProtectedRoute component={ShippingGroups} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/channel-allocation">
          <ProtectedRoute component={ChannelAllocation} requiredPermission={{ resource: "channels", action: "view" }} />
        </Route>
        <Route path="/catalog">
          <ProtectedRoute component={CatalogPage} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/catalog/variants">
          <ProtectedRoute component={CatalogPage} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/products/:id">
          <ProtectedRoute component={ProductDetail} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/shipping">
          <ProtectedRoute component={Orders} requiredPermission={{ resource: "orders", action: "view" }} />
        </Route>
        <Route path="/outbound-shipments/:id/order">
          <ProtectedRoute component={ShipmentOrderContext} allOfPermissions={[{ resource: "shipments", action: "view" }, { resource: "shipments", action: "view_order_context" }]} />
        </Route>
        <Route path="/outbound-shipments">
          <ProtectedRoute component={OutboundShipments} requiredPermission={{ resource: "shipments", action: "view" }} />
        </Route>
        <Route path="/enterprise"><Redirect to="/" /></Route>
        <Route path="/demand-planner">
          <ProtectedRoute component={DemandPlanner} requiredPermission={{ resource: "purchasing", action: "view" }} />
        </Route>
        {/* New-PO editor routes (Spec A). MUST be registered before
            /purchase-orders/:id so wouter does not match 'new' as an :id. */}
        <Route path="/purchase-orders/new">
          <ProtectedRoute component={PurchaseOrderEdit} requiredPermission={PURCHASING_READ_PERMISSION} allOfPermissions={[{ resource: "purchasing", action: "create" }]} />
        </Route>
        <Route path="/purchase-orders/:id/edit">
          <ProtectedRoute component={PurchaseOrderEdit} requiredPermission={PURCHASING_READ_PERMISSION} allOfPermissions={[{ resource: "purchasing", action: "edit" }]} />
        </Route>
        <Route path="/purchase-orders/:id">
          {(params) => <ProtectedRoute key={params.id} component={PurchaseOrderDetail} requiredPermission={PURCHASING_READ_PERMISSION} />}
        </Route>
        <Route path="/purchase-orders">
          <ProtectedRoute component={PurchaseOrders} requiredPermission={PURCHASING_READ_PERMISSION} />
        </Route>
        <Route path="/receiving">
          <ProtectedRoute component={Receiving} anyOfPermissions={RECEIVING_READ_PERMISSIONS} />
        </Route>
        <Route path="/suppliers">
          <ProtectedRoute component={Suppliers} requiredPermission={{ resource: "purchasing", action: "view" }} />
        </Route>
        {/* Legacy escape hatch: always the old page, flag-independent. MUST be
            registered before /reorder-analysis (wouter matches in order). */}
        <Route path="/reorder-analysis/legacy">
          <ProtectedRoute component={PurchasingView} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/reorder-analysis">
          <ProtectedRoute component={ReorderAnalysisRoute} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        {/* Automation page (design surface 03): mode/policy settings +
            recommendation review queue + auto-draft runs. */}
        <Route path="/procurement/automation">
          <ProtectedRoute component={ProcurementAutomation} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        {/* Run report page (design surface 04): read-only auto-draft run
            reports, decision history, and forecast accuracy. */}
        <Route path="/procurement/runs">
          <ProtectedRoute component={ProcurementRuns} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        {/* RFQ workbench (design surface 05): read-only tracking of quote
            requests created from the Order Builder + the sourcing
            requirement queue. */}
        <Route path="/procurement/rfqs">
          <ProtectedRoute component={ProcurementRfqs} anyOfPermissions={[{ resource: "purchasing", action: "view" }, { resource: "inventory", action: "view" }]} />
        </Route>
        <Route path="/replenishment">
          <ProtectedRoute component={Replenishment} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/returns/cases">
          <ProtectedRoute component={ReturnCases} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/returns/receiving">
          <ProtectedRoute component={Returns} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/returns/label-settings">
          <ProtectedRoute component={ReturnLabelSettings} requiredPermission={{ resource: "settings", action: "view" }} />
        </Route>
        <Route path="/returns">
          <Redirect to="/returns/cases" />
        </Route>
        <Route path="/return-policies">
          <ProtectedRoute component={ReturnPolicies} requiredPermission={{ resource: "settings", action: "view" }} />
        </Route>
        <Route path="/shipments/:id">
          {(params) => <ProtectedRoute key={params.id} component={InboundShipmentDetail} requiredPermission={PURCHASING_READ_PERMISSION} />}
        </Route>
        <Route path="/shipments">
          <ProtectedRoute component={InboundShipments} requiredPermission={PURCHASING_READ_PERMISSION} />
        </Route>
        <Route path="/inventory/costs">
          <ProtectedRoute component={CostDashboard} requiredPermission={{ resource: "inventory", action: "view" }} />
        </Route>
        <Route path="/inventory/history">
          <ProtectedRoute component={InventoryHistory} requiredPermission={{ resource: "inventory", action: "audit" }} />
        </Route>
        <Route path="/ap">
          <ProtectedRoute component={APDashboard} requiredPermission={PURCHASING_READ_PERMISSION} />
        </Route>
        <Route path="/ap-invoices/:id">
          {(params) => <ProtectedRoute key={params.id} component={APInvoiceDetail} requiredPermission={PURCHASING_READ_PERMISSION} />}
        </Route>
        <Route path="/ap-invoices">
          <ProtectedRoute component={APInvoices} requiredPermission={PURCHASING_READ_PERMISSION} />
        </Route>
        <Route path="/supplier-returns/:id">
          {(params) => <ProtectedRoute key={params.id} component={SupplierReturns} requiredPermission={PURCHASING_READ_PERMISSION} />}
        </Route>
        <Route path="/supplier-returns">
          <ProtectedRoute component={SupplierReturns} requiredPermission={PURCHASING_READ_PERMISSION} />
        </Route>
        <Route path="/supplier-credits/:id">
          {(params) => <ProtectedRoute key={params.id} component={SupplierCredits} requiredPermission={PURCHASING_READ_PERMISSION} />}
        </Route>
        <Route path="/supplier-credits">
          <ProtectedRoute component={SupplierCredits} requiredPermission={PURCHASING_READ_PERMISSION} />
        </Route>
        <Route path="/ap-payments">
          <ProtectedRoute component={APPayments} requiredPermission={PURCHASING_READ_PERMISSION} />
        </Route>
        {/* Redirects for old procurement URLs */}
        <Route path="/purchasing/catalog"><Redirect to="/reorder-analysis" /></Route>
        <Route path="/purchasing/:id"><Redirect to="/purchase-orders/:id" /></Route>
        <Route path="/purchasing">
          <ProtectedRoute component={PurchasingDashboard} allOfPermissions={PURCHASING_DASHBOARD_READ_PERMISSIONS} />
        </Route>
        {/* Spec A: procurement settings page. MUST be registered before
            /settings so wouter does not fall through to the general page. */}
        <Route path="/settings/procurement/promise-safety">
          <ProtectedRoute
            component={ProcurementPromiseSafetySettings}
            requiredPermission={{ resource: "inventory_planning", action: "view" }}
          />
        </Route>
        <Route path="/settings/procurement">
          <ProtectedRoute component={ProcurementSettings} anyOfPermissions={[{ resource: "purchasing", action: "view" }, { resource: "settings", action: "edit" }]} />
        </Route>
        <Route path="/shipping-settings">
          <ProtectedRoute component={ShippingSettings} requiredPermission={{ resource: "settings", action: "view" }} />
        </Route>
        <Route path="/shipping-service-levels/:id">
          <ProtectedRoute component={ShippingServiceLevelDetail} requiredPermission={{ resource: "settings", action: "view" }} />
        </Route>
        <Route path="/shipping-service-levels">
          <ProtectedRoute component={ShippingServiceLevels} requiredPermission={{ resource: "settings", action: "view" }} />
        </Route>
        <Route path="/settings">
          <ProtectedRoute component={Settings} requiredPermission={{ resource: "settings", action: "view" }} />
        </Route>
        <Route path="/notification-preferences">
          <ProtectedRoute component={NotificationPreferences} requiredPermission={{ resource: "settings", action: "view" }} />
        </Route>
        {/* Redirects for old URLs */}
        <Route path="/products"><Redirect to="/catalog" /></Route>
        <Route path="/variants"><Redirect to="/catalog/variants" /></Route>
        <Route path="/warehouses"><Redirect to="/warehouse" /></Route>
        <Route component={NotFound} />
      </Switch>
      </React.Suspense>
    </Layout>
  );
}

function StaffPWAUpdatePrompt() {
  const [location] = useLocation();
  // Existing workers also bypass these paths, but direct portal visits should
  // not install Echelon's offline worker in the first place.
  return isCustomerReturnPortalPath(location) ? null : <PWAUpdatePrompt />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SettingsProvider>
          <TooltipProvider>
            <Toaster />
            <StaffPWAUpdatePrompt />
            <React.Suspense fallback={<RouteSuspenseFallback fullScreen />}>
              <Router />
            </React.Suspense>
          </TooltipProvider>
        </SettingsProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
