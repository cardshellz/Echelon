import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Package,
  ShoppingCart,
  Wallet,
  Settings,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useVendorAuth } from "@/lib/vendor-auth";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";

const navItems = [
  { label: "Dashboard", icon: LayoutDashboard, href: "/vendor/dashboard" },
  { label: "Products", icon: Package, href: "/vendor/products" },
  { label: "Orders", icon: ShoppingCart, href: "/vendor/orders" },
  { label: "Wallet", icon: Wallet, href: "/vendor/wallet" },
  { label: "Settings", icon: Settings, href: "/vendor/settings" },
];

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function NavLink({
  item,
  active,
  onClick,
}: {
  item: (typeof navItems)[0];
  active: boolean;
  onClick?: () => void;
}) {
  return (
    <Link href={item.href}>
      <button
        onClick={onClick}
        className={cn(
          "flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors min-h-[44px] w-full text-left",
          active
            ? "bg-red-600/10 text-red-600 dark:text-red-400"
            : "text-muted-foreground hover:text-foreground hover:bg-accent"
        )}
      >
        <item.icon className="h-5 w-5 shrink-0" />
        {item.label}
      </button>
    </Link>
  );
}

export default function VendorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [location] = useLocation();
  const { vendor, logout } = useVendorAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top Nav */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center justify-between h-16 px-4 max-w-7xl mx-auto">
          {/* Left: Logo + Mobile menu */}
          <div className="flex items-center gap-3">
            {/* Mobile hamburger */}
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="md:hidden min-h-[44px] min-w-[44px]"
                >
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 p-0">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <div className="flex flex-col h-full">
                  <div className="flex items-center gap-3 p-4 border-b">
                    <div className="h-8 w-8 bg-red-600 rounded-lg flex items-center justify-center">
                      <span className="text-white font-bold text-sm">CS</span>
                    </div>
                    <span className="font-semibold text-lg">Vendor Portal</span>
                  </div>
                  <nav className="flex-1 p-3 space-y-1">
                    {navItems.map((item) => (
                      <NavLink
                        key={item.href}
                        item={item}
                        active={location === item.href || location.startsWith(item.href + "/")}
                        onClick={() => setMobileOpen(false)}
                      />
                    ))}
                  </nav>
                  {vendor && (
                    <div className="p-4 border-t space-y-3">
                      <div className="text-sm">
                        <div className="font-medium">{vendor.name}</div>
                        <div className="text-muted-foreground text-xs">
                          {vendor.company_name || vendor.email}
                        </div>
                      </div>
                      <div className="text-sm font-medium text-green-600 dark:text-green-400">
                        Balance: {formatCents(vendor.wallet_balance_cents)}
                      </div>
                      <Button
                        variant="ghost"
                        className="w-full justify-start gap-2 text-destructive min-h-[44px]"
                        onClick={logout}
                      >
                        <LogOut className="h-4 w-4" />
                        Sign Out
                      </Button>
                    </div>
                  )}
                </div>
              </SheetContent>
            </Sheet>

            {/* Logo */}
            <Link href="/vendor/dashboard">
              <div className="flex items-center gap-2 cursor-pointer">
                <div className="h-8 w-8 bg-red-600 rounded-lg flex items-center justify-center">
                  <span className="text-white font-bold text-sm">CS</span>
                </div>
                <span className="font-semibold text-lg hidden sm:inline">
                  Card Shellz <span className="text-muted-foreground font-normal">Vendor Portal</span>
                </span>
              </div>
            </Link>
          </div>

          {/* Center: Desktop nav */}
          <nav className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              const active =
                location === item.href || location.startsWith(item.href + "/");
              return (
                <Link key={item.href} href={item.href}>
                  <button
                    className={cn(
                      "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors min-h-[44px]",
                      active
                        ? "bg-red-600/10 text-red-600 dark:text-red-400"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent"
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </button>
                </Link>
              );
            })}
          </nav>

          {/* Right: Balance + Logout */}
          <div className="flex items-center gap-3">
            {vendor && (
              <>
                <div className="hidden sm:block text-right">
                  <div className="text-xs text-muted-foreground">Balance</div>
                  <div className="text-sm font-semibold text-green-600 dark:text-green-400">
                    {formatCents(vendor.wallet_balance_cents)}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="min-h-[44px] min-w-[44px]"
                  onClick={logout}
                  title="Sign Out"
                >
                  <LogOut className="h-5 w-5" />
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 py-6">{children}</main>

      {/* Footer */}
      <footer className="border-t py-4 text-center text-xs text-muted-foreground">
        Powered by{" "}
        <a
          href="https://www.cardshellz.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-red-600 hover:underline"
        >
          Card Shellz
        </a>{" "}
        · Veteran-Owned · 🇺🇸
      </footer>
    </div>
  );
}
