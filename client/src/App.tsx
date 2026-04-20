import React from "react";
import { Switch, Route, useLocation, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SettingsProvider } from "@/lib/settings";
import { AuthProvider, useAuth } from "@/lib/auth";
import { VendorAuthProvider, useVendorAuth } from "@/lib/vendor-auth";
import { PWAUpdatePrompt } from "@/components/PWAUpdatePrompt";
import Layout from "@/components/layout/AppShell";
import VendorLayout from "@/components/vendor/VendorLayout";
import VendorLogin from "@/pages/vendor/VendorLogin";
import VendorRegister from "@/pages/vendor/VendorRegister";
import VendorDashboard from "@/pages/vendor/VendorDashboard";
import VendorProducts from "@/pages/vendor/VendorProducts";
import VendorOrders from "@/pages/vendor/VendorOrders";
import VendorWallet from "@/pages/vendor/VendorWallet";
import VendorSettings from "@/pages/vendor/VendorSettings";
import Dashboard from "@/pages/Dashboard";
import Inventory from "@/pages/Inventory";
import Orders from "@/pages/Orders";
import Dropship from "@/pages/Dropship";
import Subscriptions from "@/pages/Subscriptions";
import PickingPage from "@/pages/PickingPage";
import OrderHistory from "@/pages/OrderHistory";
import WarehousePage from "@/pages/WarehousePage";
import PickZones from "@/pages/PickZones";
import WarehouseSettingsPage from "@/pages/WarehouseSettingsPage";
import Integrations from "@/pages/Integrations";
import Users from "@/pages/Users";
import Roles from "@/pages/Roles";
import ChannelsPage from "@/pages/ChannelsPage";
import CatalogPage from "@/pages/CatalogPage";
import ProductDetail from "@/pages/ProductDetail";
import CycleCounts from "@/pages/CycleCounts";
import Transfers from "@/pages/Transfers";
import Suppliers from "@/pages/Suppliers";
import PurchasingView from "@/pages/PurchasingView";
import Receiving from "@/pages/Receiving";
import InventoryHistory from "@/pages/InventoryHistory";
import Replenishment from "@/pages/Replenishment";
import BinAssignments from "@/pages/BinAssignments";
import ChannelAllocation from "@/pages/ChannelAllocation";
import ProductLines from "@/pages/ProductLines";
import PurchaseOrders from "@/pages/PurchaseOrders";
import PurchaseOrderDetail from "@/pages/PurchaseOrderDetail";
import PurchasingDashboard from "@/pages/PurchasingDashboard";
import Returns from "@/pages/Returns";
import InboundShipments from "@/pages/InboundShipments";
import InboundShipmentDetail from "@/pages/InboundShipmentDetail";
import CostDashboard from "@/pages/CostDashboard";
import APDashboard from "@/pages/APDashboard";
import APInvoices from "@/pages/APInvoices";
import APInvoiceDetail from "@/pages/APInvoiceDetail";
import APPayments from "@/pages/APPayments";
import Login from "@/pages/Login";
import Settings from "@/pages/Settings";
import NotificationPreferences from "@/pages/NotificationPreferences";
import EbayChannelPage from "@/pages/EbayChannelPage";
import ShopifyChannelPage from "@/pages/ShopifyChannelPage";
import SyncLogPage from "@/pages/SyncLogPage";
import OmsOrders from "@/pages/OmsOrders";
import VendorList from "@/pages/VendorList";
import VendorDetail from "@/pages/VendorDetail";
import NotFound from "@/pages/not-found";

function ProtectedRoute({ 
  component: Component, 
  allowedRoles 
}: { 
  component: React.ComponentType; 
  allowedRoles?: string[];
}) {
  const { user, isLoading } = useAuth();
  
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }
  
  if (!user) {
    return <Redirect to="/login" />;
  }
  
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <Redirect to="/picking" />;
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

function Router() {
  const [location] = useLocation();
  const { user, isLoading } = useAuth();

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
  
  if (!user) {
    return <Redirect to="/login" />;
  }

  const isPickerOnly = user.role === "picker";

  return (
    <Layout>
      <Switch>
        <Route path="/">
          {isPickerOnly ? <Redirect to="/picking" /> : <Dashboard />}
        </Route>
        <Route path="/inventory">
          <ProtectedRoute component={Inventory} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/cycle-counts">
          <ProtectedRoute component={CycleCounts} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/bin-assignments">
          <ProtectedRoute component={BinAssignments} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/transfers">
          <ProtectedRoute component={Transfers} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/orders">
          <ProtectedRoute component={Orders} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/dropship">
          <ProtectedRoute component={Dropship} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/subscriptions">
          <ProtectedRoute component={Subscriptions} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/vendors/:id">
          <ProtectedRoute component={VendorDetail} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/vendors">
          <ProtectedRoute component={VendorList} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/picking" component={PickingPage} />
        <Route path="/picking/logs" component={PickingPage} />
        <Route path="/picking/metrics" component={PickingPage} />
        <Route path="/picking/settings" component={PickingPage} />
        <Route path="/order-history">
          <ProtectedRoute component={OrderHistory} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/warehouse/locations">
          <ProtectedRoute component={WarehousePage} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/warehouse">
          <ProtectedRoute component={WarehousePage} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/pick-zones">
          <ProtectedRoute component={PickZones} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/warehouse/settings/:id">
          <ProtectedRoute component={WarehouseSettingsPage} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/integrations">
          <ProtectedRoute component={Integrations} allowedRoles={["admin"]} />
        </Route>
        <Route path="/users">
          <ProtectedRoute component={Users} allowedRoles={["admin"]} />
        </Route>
        <Route path="/roles">
          <ProtectedRoute component={Roles} allowedRoles={["admin"]} />
        </Route>
        <Route path="/sync-log">
          <ProtectedRoute component={SyncLogPage} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/oms/orders">
          <ProtectedRoute component={OmsOrders} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/channels/shopify">
          <ProtectedRoute component={ShopifyChannelPage} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/channels/ebay">
          <ProtectedRoute component={EbayChannelPage} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/channels">
          <ProtectedRoute component={ChannelsPage} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/channels/reserves">
          <ProtectedRoute component={ChannelsPage} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/product-lines">
          <ProtectedRoute component={ProductLines} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/channel-allocation">
          <ProtectedRoute component={ChannelAllocation} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/catalog">
          <ProtectedRoute component={CatalogPage} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/catalog/variants">
          <ProtectedRoute component={CatalogPage} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/products/:id">
          <ProtectedRoute component={ProductDetail} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/shipping">
          <ProtectedRoute component={Orders} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/purchase-orders/:id">
          <ProtectedRoute component={PurchaseOrderDetail} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/purchase-orders">
          <ProtectedRoute component={PurchaseOrders} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/receiving">
          <ProtectedRoute component={Receiving} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/suppliers">
          <ProtectedRoute component={Suppliers} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/reorder-analysis">
          <ProtectedRoute component={PurchasingView} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/replenishment">
          <ProtectedRoute component={Replenishment} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/returns">
          <ProtectedRoute component={Returns} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/shipments/:id">
          <ProtectedRoute component={InboundShipmentDetail} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/shipments">
          <ProtectedRoute component={InboundShipments} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/inventory/costs">
          <ProtectedRoute component={CostDashboard} allowedRoles={["admin"]} />
        </Route>
        <Route path="/inventory/history">
          <ProtectedRoute component={InventoryHistory} allowedRoles={["admin"]} />
        </Route>
        <Route path="/ap">
          <ProtectedRoute component={APDashboard} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/ap-invoices/:id">
          <ProtectedRoute component={APInvoiceDetail} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/ap-invoices">
          <ProtectedRoute component={APInvoices} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/ap-payments">
          <ProtectedRoute component={APPayments} allowedRoles={["admin", "lead"]} />
        </Route>
        {/* Redirects for old procurement URLs */}
        <Route path="/purchasing/catalog"><Redirect to="/reorder-analysis" /></Route>
        <Route path="/purchasing/:id"><Redirect to="/purchase-orders/:id" /></Route>
        <Route path="/purchasing">
          <ProtectedRoute component={PurchasingDashboard} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/settings">
          <ProtectedRoute component={Settings} allowedRoles={["admin"]} />
        </Route>
        <Route path="/notification-preferences" component={NotificationPreferences} />
        {/* Redirects for old URLs */}
        <Route path="/products"><Redirect to="/catalog" /></Route>
        <Route path="/variants"><Redirect to="/catalog/variants" /></Route>
        <Route path="/warehouses"><Redirect to="/warehouse" /></Route>
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SettingsProvider>
          <TooltipProvider>
            <Toaster />
            <PWAUpdatePrompt />
            <Router />
          </TooltipProvider>
        </SettingsProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
