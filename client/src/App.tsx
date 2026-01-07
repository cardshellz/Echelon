import React from "react";
import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Layout from "@/components/layout/AppShell";
import Dashboard from "@/pages/Dashboard";
import Inventory from "@/pages/Inventory";
import Orders from "@/pages/Orders";
import Dropship from "@/pages/Dropship";
import Picking from "@/pages/Picking";
import Integrations from "@/pages/Integrations";
import Login from "@/pages/Login";
import NotFound from "@/pages/not-found";

function Router() {
  const [location] = useLocation();

  if (location === "/login") {
    return <Login />;
  }

  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/inventory" component={Inventory} />
        <Route path="/orders" component={Orders} />
        <Route path="/dropship" component={Dropship} />
        <Route path="/picking" component={Picking} />
        <Route path="/integrations" component={Integrations} />
        
        {/* Placeholders for routes we haven't built deep yet, re-using Inventory/Orders style for consistency if clicked */}
        <Route path="/shipping" component={Orders} />
        <Route path="/purchasing" component={Inventory} />
        
        {/* Fallback to 404 */}
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
