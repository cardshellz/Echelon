import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  Bell,
  Boxes,
  ClipboardList,
  LayoutDashboard,
  ListChecks,
  LogOut,
  RotateCcw,
  Settings,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { dropshipPortalPath, useDropshipAuth } from "@/lib/dropship-auth";
import { isOnboardingVendor } from "@/lib/dropship-onboarding";
import { fetchJson, type DropshipOnboardingState } from "@/lib/dropship-ops-surface";

const ONBOARDING_QUERY_KEY = ["/api/dropship/onboarding/state"] as const;
const ONBOARDING_NAV_HREF = "/onboarding";

const navItems = [
  { label: "Onboarding", href: ONBOARDING_NAV_HREF, icon: <ListChecks className="h-4 w-4" /> },
  { label: "Dashboard", href: "/dashboard", icon: <LayoutDashboard className="h-4 w-4" /> },
  { label: "Catalog", href: "/catalog", icon: <Boxes className="h-4 w-4" /> },
  { label: "Orders", href: "/orders", icon: <ClipboardList className="h-4 w-4" /> },
  { label: "Wallet", href: "/wallet", icon: <Wallet className="h-4 w-4" /> },
  { label: "Returns", href: "/returns", icon: <RotateCcw className="h-4 w-4" /> },
  { label: "Settings", href: "/settings", icon: <Settings className="h-4 w-4" /> },
  { label: "Alerts", href: "/notifications", icon: <Bell className="h-4 w-4" /> },
];

export function DropshipPortalShell({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { principal, logout } = useDropshipAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  // The same query every portal page runs, so it is served from the cache.
  const onboardingQuery = useQuery<DropshipOnboardingState>({
    queryKey: [...ONBOARDING_QUERY_KEY],
    queryFn: () => fetchJson<DropshipOnboardingState>(ONBOARDING_QUERY_KEY[0]),
    enabled: !!principal,
  });
  // Onboarding is a one-time page. Once the vendor is past it (active, paused,
  // lapsed) the item goes and the Dashboard is home; the route itself stays
  // reachable, because it hosts the store connection panel.
  const showOnboarding = onboardingQuery.data ? isOnboardingVendor(onboardingQuery.data.vendor.status) : false;
  const visibleNavItems = navItems.filter((item) => item.href !== ONBOARDING_NAV_HREF || showOnboarding);

  async function signOut() {
    setLoggingOut(true);
    try {
      await logout();
      setLocation(dropshipPortalPath("/login"));
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex min-h-16 w-full max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[#C060E0] text-white">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <div className="text-base font-semibold">Card Shellz .ops</div>
              <div className="text-xs text-zinc-500">Dropship portal</div>
            </div>
          </div>
          <Button variant="outline" size="sm" className="gap-2" disabled={loggingOut} onClick={signOut}>
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
        <nav className="mx-auto flex w-full max-w-7xl gap-1 overflow-x-auto px-4 pb-3 sm:px-6" data-testid="portal-nav">
          {visibleNavItems.map((item) => {
            const href = dropshipPortalPath(item.href);
            const active = location === href || location === item.href || location.endsWith(item.href);
            return (
              <Button
                key={item.href}
                type="button"
                variant={active ? "outline" : "ghost"}
                size="sm"
                className={active
                  ? "h-9 shrink-0 gap-2 border-[#C060E0]/30 bg-[#C060E0]/10 text-[#8c35aa] hover:bg-[#C060E0]/15"
                  : "h-9 shrink-0 gap-2"}
                onClick={() => setLocation(href)}
              >
                {item.icon}
                {item.label}
              </Button>
            );
          })}
        </nav>
      </header>
      {children}
      <footer className="mx-auto w-full max-w-7xl px-4 py-6 text-xs text-zinc-500 sm:px-6">
        <Link href={dropshipPortalPath("/privacy")} className="underline hover:text-zinc-700" data-testid="portal-privacy-link">Privacy policy</Link>
      </footer>
    </main>
  );
}
