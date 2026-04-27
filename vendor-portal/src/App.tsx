import React from "react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { Switch, Route } from "wouter";
import LoginPage from "./pages/auth/LoginPage";
import RegisterPage from "./pages/auth/RegisterPage";
import DashboardPage from "./pages/DashboardPage";

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Switch>
        <Route path="/login" component={LoginPage} />
        <Route path="/register" component={RegisterPage} />
        <Route path="/" component={DashboardPage} />
        <Route>404 Not Found</Route>
      </Switch>
    </QueryClientProvider>
  );
}

export default App;
