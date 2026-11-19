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
import { loadChunkWithRetry } from "@/lib/chunk-loading";
import NotFound from "@/pages/not-found";
import {
  CUSTOMER_RETURN_PORTAL_PATH,
  CUSTOMER_RETURN_PORTAL_ACCESS_PATH,
  CUSTOMER_RETURN_PORTAL_LEGACY_PATH,
  isCustomerReturnPortalPath,
} from "@shared/returns/customer-return-portal-paths";

// Every lazy page carries its own Suspense boundary. With only one boundary
// around the whole <Switch>, a route change whose chunk is still loading does
// not commit: React keeps the previous page mounted (hidden behind the
// fallback). Going back before the chunk arrives then re-shows that page
// without remounting it, so its on-mount reads never run again and it shows
// stale data (a paid purchase order still reading as unpaid, for example).
// A per-page boundary lets the route change commit at once: the old page
// unmounts and the new page shows the fallback while its chunk loads.
// React.lazy keeps a failed import for good, so every chunk loads through
// loadChunkWithRetry: a page opened while offline loads once the connection
// is back instead of staying broken until a full reload.
function lazyWithRetry<T extends React.ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  return React.lazy(() => loadChunkWithRetry(load));
}

function lazyPage<T extends React.ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): T {
  const LazyComponent = lazyWithRetry(load);
  function LazyPage(props: React.ComponentProps<T>) {
    return (
      <React.Suspense fallback={<RouteSuspenseFallback />}>
        <LazyComponent {...props} />
      </React.Suspense>
    );
  }
  // Typed as the page itself, so every call site type-checks exactly as it
  // did when the page was imported directly.
  return LazyPage as unknown as T;
}

const Layout = lazyWithRetry(() => import("@/components/layout/AppShell"));
const Login = lazyPage(() => import("@/pages/Login"));

const VendorLayout = lazyWithRetry(() => import("@/components/vendor/VendorLayout"));
const VendorLogin = lazyPage(() => import("@/pages/vendor/VendorLogin"));
const VendorRegister = lazyPage(() => import("@/pages/vendor/VendorRegister"));
const VendorDashboard = lazyPage(() => import("@/pages/vendor/VendorDashboard"));
const VendorProducts = lazyPage(() => import("@/pages/vendor/VendorProducts"));
const VendorOrders = lazyPage(() => import("@/pages/vendor/VendorOrders"));
const VendorWallet = lazyPage(() => import("@/pages/vendor/VendorWallet"));
const VendorSettings = lazyPage(() => import("@/pages/vendor/VendorSettings"));
const DropshipPortalAuth = lazyPage(() => import("@/pages/dropship/DropshipPortalAuth"));
const DropshipPortalPrivacy = lazyPage(() => import("@/pages/dropship/DropshipPortalPrivacy"));
const DropshipPortalDashboard = lazyPage(() => import("@/pages/dropship/DropshipPortalDashboard"));
const DropshipPortalHome = lazyPage(() => import("@/pages/dropship/DropshipPortalHome"));
const DropshipPortalCatalog = lazyPage(() => import("@/pages/dropship/DropshipPortalCatalog"));
const DropshipPortalNotifications = lazyPage(() => import("@/pages/dropship/DropshipPortalNotifications"));
const DropshipPortalCostChanges = lazyPage(() => import("@/pages/dropship/DropshipPortalCostChanges"));
const DropshipPortalOnboarding = lazyPage(() => import("@/pages/dropship/DropshipPortalOnboarding"));
const DropshipPortalOrders = lazyPage(() => import("@/pages/dropship/DropshipPortalOrders"));
const DropshipPortalReturns = lazyPage(() => import("@/pages/dropship/DropshipPortalReturns"));
const DropshipPortalSettings = lazyPage(() => import("@/pages/dropship/DropshipPortalSettings"));
const DropshipPortalWallet = lazyPage(() => import("@/pages/dropship/DropshipPortalWallet"));
const Dashboard = lazyPage(() => import("@/pages/Dashboard"));
const Inventory = lazyPage(() => import("@/pages/Inventory"));
const Builds = lazyPage(() => import("@/pages/Builds"));
const SupplyTransformations = lazyPage(() => import("@/pages/SupplyTransformations"));
const InventoryCutover = lazyPage(() => import("@/pages/InventoryCutover"));
const ProcurementPromiseSafetySettings = lazyPage(() => import("@/pages/ProcurementPromiseSafetySettings"));
const ChannelInventory = lazyPage(() => import("@/pages/ChannelInventory"));
const BuildRecipeCreate = lazyPage(() => import("@/pages/BuildRecipeCreate"));
const Orders = lazyPage(() => import("@/pages/Orders"));
const Dropship = lazyPage(() => import("@/pages/Dropship"));
const Subscriptions = lazyPage(() => import("@/pages/Subscriptions"));
const PickingPage = lazyPage(() => import("@/pages/PickingPage"));
const PickPriority = lazyPage(() => import("@/pages/PickPriority"));
const OrderHistory = lazyPage(() => import("@/pages/OrderHistory"));
const WarehousePage = lazyPage(() => import("@/pages/WarehousePage"));
const PickZones = lazyPage(() => import("@/pages/PickZones"));
const WarehouseSettingsPage = lazyPage(() => import("@/pages/WarehouseSettingsPage"));
const WorkConfigurationPage = lazyPage(() => import("@/pages/warehouse-work/WorkConfigurationPage"));
const AssemblyWorkPage = lazyPage(() => import("@/pages/warehouse-work/AssemblyWorkPage"));
const Integrations = lazyPage(() => import("@/pages/Integrations"));
const Users = lazyPage(() => import("@/pages/Users"));
const Roles = lazyPage(() => import("@/pages/Roles"));
const ChannelsPage = lazyPage(() => import("@/pages/ChannelsPage"));
const CatalogPage = lazyPage(() => import("@/pages/CatalogPage"));
const ProductDetail = lazyPage(() => import("@/pages/ProductDetail"));
const CycleCounts = lazyPage(() => import("@/pages/CycleCounts"));
const Transfers = lazyPage(() => import("@/pages/Transfers"));
const Suppliers = lazyPage(() => import("@/pages/Suppliers"));
const PurchasingView = lazyPage(() => import("@/pages/PurchasingView"));
const ReorderEngine = lazyPage(() => import("@/pages/ReorderEngine"));
const ProcurementAutomation = lazyPage(() => import("@/pages/ProcurementAutomation"));
const ProcurementRuns = lazyPage(() => import("@/pages/ProcurementRuns"));
const ProcurementRfqs = lazyPage(() => import("@/pages/ProcurementRfqs"));
const Receiving = lazyPage(() => import("@/pages/Receiving"));
const InventoryHistory = lazyPage(() => import("@/pages/InventoryHistory"));
const Replenishment = lazyPage(() => import("@/pages/Replenishment"));
const SlottingSetup = lazyPage(() => import("@/pages/SlottingSetup"));
const ChannelAllocation = lazyPage(() => import("@/pages/ChannelAllocation"));
const ProductLines = lazyPage(() => import("@/pages/ProductLines"));
const ShippingGroups = lazyPage(() => import("@/pages/ShippingGroups"));
const PurchaseOrders = lazyPage(() => import("@/pages/PurchaseOrders"));
const PurchaseOrderDetail = lazyPage(() => import("@/pages/PurchaseOrderDetail"));
const PurchaseOrderEdit = lazyPage(() => import("@/pages/PurchaseOrderEdit"));
const PurchasingDashboard = lazyPage(() => import("@/pages/PurchasingDashboard"));
const Returns = lazyPage(() => import("@/pages/Returns"));
const ReturnLabelSettings = lazyPage(() => import("@/pages/ReturnLabelSettings"));
const ReturnCases = lazyPage(() => import("@/pages/ReturnCases"));
const ReturnPolicies = lazyPage(() => import("@/pages/ReturnPolicies"));
const CustomerReturnPortalPreview = lazyPage(() => import("@/pages/CustomerReturnPortalPreview"));
const CustomerReturnCustomerPortal = lazyPage(() => import("@/pages/CustomerReturnCustomerPortal"));
const CustomerReturnPortalAccess = lazyPage(() => import("@/pages/CustomerReturnPortalAccess"));
const InboundShipments = lazyPage(() => import("@/pages/InboundShipments"));
const OutboundShipments = lazyPage(() => import("@/pages/OutboundShipments"));
const ShipmentOrderContext = lazyPage(() => import("@/pages/ShipmentOrderContext"));
const InboundShipmentDetail = lazyPage(() => import("@/pages/InboundShipmentDetail"));
const CostDashboard = lazyPage(() => import("@/pages/CostDashboard"));
const APDashboard = lazyPage(() => import("@/pages/APDashboard"));
const APInvoices = lazyPage(() => import("@/pages/APInvoices"));
const APInvoiceDetail = lazyPage(() => import("@/pages/APInvoiceDetail"));
const APPayments = lazyPage(() => import("@/pages/APPayments"));
const SupplierCredits = lazyPage(() => import("@/pages/SupplierCredits"));
const SupplierReturns = lazyPage(() => import("@/pages/SupplierReturns"));
const StaffPasswordChange = lazyWithRetry(() =>
  import("@/components/identity/StaffPasswordChange").then((m) => ({ default: m.StaffPasswordChange })),
);
const Settings = lazyPage(() => import("@/pages/Settings"));
const ProcurementSettings = lazyPage(() => import("@/pages/ProcurementSettings"));
const ShippingSettings = lazyPage(() => import("@/pages/ShippingSettings"));
const ShippingServiceLevels = lazyPage(() => import("@/pages/ShippingServiceLevels"));
const ShippingServiceLevelDetail = lazyPage(() => import("@/pages/ShippingServiceLevelDetail"));
const NotificationPreferences = lazyPage(() => import("@/pages/NotificationPreferences"));
const EbayChannelPage = lazyPage(() => import("@/pages/EbayChannelPage"));
const WalmartChannelRouteHost = lazyWithRetry(() =>
  import("@/pages/WalmartChannelPage").then((m) => ({ default: m.WalmartChannelRouteHost })),
);
const ShopifyChannelPage = lazyPage(() => import("@/pages/ShopifyChannelPage"));
const SyncLogPage = lazyPage(() => import("@/pages/SyncLogPage"));
const OmsOrders = lazyPage(() => import("@/pages/OmsOrders"));
const OrderEdits = lazyPage(() => import("@/pages/OrderEdits"));
const FlowMonitor = lazyPage(() => import("@/pages/FlowMonitor"));
const VendorList = lazyPage(() => import("@/pages/VendorList"));
const VendorDetail = lazyPage(() => import("@/pages/VendorDetail"));
const DemandPlanner = lazyPage(() => import("@/pages/DemandPlanner"));

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
