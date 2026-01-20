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
import Locations from "@/pages/Locations";
import Integrations from "@/pages/Integrations";
import Users from "@/pages/Users";
import Roles from "@/pages/Roles";
import Login from "@/pages/Login";
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
        <Route path="/locations">
          <ProtectedRoute component={Locations} allowedRoles={["admin", "lead"]} />
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
        <Route path="/shipping">
          <ProtectedRoute component={Orders} allowedRoles={["admin", "lead"]} />
        </Route>
        <Route path="/purchasing">
          <ProtectedRoute component={Inventory} allowedRoles={["admin", "lead"]} />
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
