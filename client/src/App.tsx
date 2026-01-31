import React from "react";
import { Switch, Route, useLocation, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SettingsProvider } from "@/lib/settings";
import { AuthProvider, useAuth } from "@/lib/auth";
import { PWAUpdatePrompt } from "@/components/PWAUpdatePrompt";
import Layout from "@/components/layout/AppShell";
import Dashboard from "@/pages/Dashboard";
import Inventory from "@/pages/Inventory";
import Orders from "@/pages/Orders";
import Dropship from "@/pages/Dropship";
import Picking from "@/pages/Picking";
import PickingLogs from "@/pages/PickingLogs";
import PickingMetrics from "@/pages/PickingMetrics";
import OrderHistory from "@/pages/OrderHistory";
import WarehouseLocations from "@/pages/WarehouseLocations";
import Warehouses from "@/pages/Warehouses";
import Integrations from "@/pages/Integrations";
import Users from "@/pages/Users";
import Roles from "@/pages/Roles";
import Channels from "@/pages/Channels";
import Reserves from "@/pages/Reserves";
import Products from "@/pages/Products";
import ProductDetail from "@/pages/ProductDetail";
import Variants from "@/pages/Variants";
import CycleCounts from "@/pages/CycleCounts";
import ProductCatalog from "@/pages/ProductCatalog";
import Receiving from "@/pages/Receiving";
import InventoryHistory from "@/pages/InventoryHistory";
import Replenishment from "@/pages/Replenishment";
import Login from "@/pages/Login";
import Settings from "@/pages/Settings";
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

function Router() {
  const [location] = useLocation();
  const { user, isLoading } = useAuth();

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
        <Route path="/orders">
          <ProtectedRoute component={Orders} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/dropship">
          <ProtectedRoute component={Dropship} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/picking" component={Picking} />
        <Route path="/picking/logs">
          <ProtectedRoute component={PickingLogs} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/picking/metrics">
          <ProtectedRoute component={PickingMetrics} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/order-history">
          <ProtectedRoute component={OrderHistory} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/warehouse/locations">
          <ProtectedRoute component={WarehouseLocations} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/warehouses">
          <ProtectedRoute component={Warehouses} allowedRoles={["admin", "lead"]} />
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
        <Route path="/channels">
          <ProtectedRoute component={Channels} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/channels/reserves">
          <ProtectedRoute component={Reserves} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/products">
          <ProtectedRoute component={Products} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/products/:id">
          <ProtectedRoute component={ProductDetail} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/variants">
          <ProtectedRoute component={Variants} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/shipping">
          <ProtectedRoute component={Orders} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/purchasing">
          <ProtectedRoute component={Inventory} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/receiving">
          <ProtectedRoute component={Receiving} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/replenishment">
          <ProtectedRoute component={Replenishment} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/inventory/history">
          <ProtectedRoute component={InventoryHistory} allowedRoles={["admin"]} />
        </Route>
        <Route path="/purchasing/catalog">
          <ProtectedRoute component={ProductCatalog} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/settings">
          <ProtectedRoute component={Settings} allowedRoles={["admin"]} />
        </Route>
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
