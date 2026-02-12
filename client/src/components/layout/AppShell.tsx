import React, { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Package,
  ShoppingCart,
  Truck,
  Users,
  Settings,
  Menu,
  Search,
  Bell,
  Box,
  ClipboardList,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  LucideIcon,
  Globe,
  Cable,
  MapPin,
  LogOut,
  FileText,
  History,
  Shield,
  Store,
  Building2,
  Cog,
  ShoppingBag,
  Layers,
  RefreshCw,
  ArrowLeftRight,
  RotateCcw
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useIsMobile } from "@/hooks/use-mobile";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/lib/auth";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";

// --- Navigation types ---

type NavLink = { label: string; icon: LucideIcon; href: string; roles?: string[] };
type NavGroup = { label: string; icon: LucideIcon; children: NavLink[]; roles?: string[] };
type NavEntry = NavLink | NavGroup;

function isNavGroup(entry: NavEntry): entry is NavGroup {
  return 'children' in entry;
}

// --- Navigation structure ---

const navStructure: NavEntry[] = [
  { label: "Dashboard", icon: LayoutDashboard, href: "/", roles: ["admin", "lead"] },
  {
    label: "Inbound",
    icon: Truck,
    roles: ["admin", "lead"],
    children: [
      { label: "Purchase Orders", icon: ShoppingBag, href: "/purchasing" },
      { label: "Receiving", icon: Truck, href: "/receiving" },
      { label: "Supplier Catalog", icon: Layers, href: "/purchasing/catalog" },
    ],
  },
  {
    label: "Inventory",
    icon: Box,
    roles: ["admin", "lead"],
    children: [
      { label: "Stock Levels", icon: Box, href: "/inventory" },
      { label: "Warehouses", icon: Building2, href: "/warehouse" },
      { label: "Cycle Counts", icon: ClipboardList, href: "/cycle-counts" },
      { label: "Transfers", icon: ArrowLeftRight, href: "/transfers" },
      { label: "Replenishment", icon: RefreshCw, href: "/replenishment" },
      { label: "History", icon: History, href: "/inventory/history", roles: ["admin"] },
    ],
  },
  {
    label: "Orders & Fulfillment",
    icon: ShoppingCart,
    children: [
      { label: "Orders", icon: ShoppingCart, href: "/orders", roles: ["admin", "lead"] },
      { label: "Picking", icon: ClipboardList, href: "/picking" },
      { label: "Shipping", icon: Truck, href: "/shipping", roles: ["admin", "lead"] },
      { label: "Returns", icon: RotateCcw, href: "/returns", roles: ["admin", "lead"] },
      { label: "Order History", icon: History, href: "/order-history", roles: ["admin", "lead"] },
    ],
  },
  {
    label: "Catalog & Channels",
    icon: Store,
    roles: ["admin", "lead"],
    children: [
      { label: "Catalog", icon: Package, href: "/catalog" },
      { label: "Channels", icon: Store, href: "/channels" },
      { label: "Dropship Network", icon: Globe, href: "/dropship" },
    ],
  },
];

// --- Sidebar content ---

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  mobile?: boolean;
  onClose?: () => void;
}

const SidebarContent = ({ collapsed, mobile, onClose, onExpand }: {
  collapsed: boolean;
  mobile?: boolean;
  onClose?: () => void;
  onExpand?: () => void;
}) => {
  const [location] = useLocation();
  const { user, logout } = useAuth();

  // Find which group contains the active route
  const getActiveGroupLabel = (pathname: string): string | null => {
    for (const entry of navStructure) {
      if (!isNavGroup(entry)) continue;
      for (const child of entry.children) {
        if (pathname === child.href) return entry.label;
        if (child.href !== '/' && pathname.startsWith(child.href + '/')) return entry.label;
      }
    }
    return null;
  };

  const [expandedGroup, setExpandedGroup] = useState<string | null>(
    () => getActiveGroupLabel(location)
  );

  // Auto-expand group when navigating to a page in a different group
  useEffect(() => {
    const activeLabel = getActiveGroupLabel(location);
    if (activeLabel) {
      setExpandedGroup(activeLabel);
    }
  }, [location]);

  // Role-based filtering
  const isVisible = (roles?: string[]) => {
    if (!roles) return true;
    return user && roles.includes(user.role);
  };

  const handleGroupClick = (label: string) => {
    if (collapsed && !mobile) {
      onExpand?.();
      setExpandedGroup(label);
    } else {
      setExpandedGroup(prev => prev === label ? null : label);
    }
  };

  const handleLogout = async () => {
    await logout();
    window.location.href = "/login";
  };

  return (
    <div className="flex flex-col h-full">
      <div className="h-14 flex items-center px-4 border-b border-sidebar-border/50 shrink-0">
        <div className={cn("font-bold text-lg tracking-tight flex items-center gap-2 overflow-hidden", collapsed && !mobile ? "w-0 opacity-0" : "w-auto opacity-100 transition-opacity")}>
          <div className="bg-primary/20 p-1.5 rounded-md text-primary">
            <Box size={20} />
          </div>
          <span>Echelon</span>
        </div>
        {collapsed && !mobile && (
          <div className="mx-auto bg-primary/20 p-1.5 rounded-md text-primary">
            <Box size={20} />
          </div>
        )}
      </div>

      <ScrollArea className="flex-1 py-2">
        <nav className="space-y-0.5 px-2">
          {navStructure.map((entry) => {
            // Top-level role check
            if (!isVisible(entry.roles)) return null;

            // Standalone link (Dashboard)
            if (!isNavGroup(entry)) {
              const isActive = location === entry.href;
              const Icon = entry.icon;
              return (
                <Link
                  key={entry.href}
                  href={entry.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-md transition-colors text-sm font-medium min-h-[44px]",
                    isActive
                      ? "bg-sidebar-primary text-sidebar-primary-foreground"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    collapsed && !mobile && "justify-center px-2"
                  )}
                  onClick={mobile ? onClose : undefined}
                >
                  <Icon size={20} className={cn(collapsed && !mobile && "mx-auto")} />
                  {(!collapsed || mobile) && <span>{entry.label}</span>}
                </Link>
              );
            }

            // Group: filter children by role
            const visibleChildren = entry.children.filter(child => isVisible(child.roles));
            if (visibleChildren.length === 0) return null;

            const GroupIcon = entry.icon;
            const isOpen = expandedGroup === entry.label;
            const hasActiveChild = visibleChildren.some(child =>
              location === child.href || (child.href !== '/' && location.startsWith(child.href + '/'))
            );

            // Collapsed mode: show group icon only
            if (collapsed && !mobile) {
              return (
                <button
                  key={entry.label}
                  onClick={() => handleGroupClick(entry.label)}
                  className={cn(
                    "flex items-center justify-center w-full py-2.5 rounded-md transition-colors min-h-[44px]",
                    hasActiveChild
                      ? "bg-sidebar-primary text-sidebar-primary-foreground"
                      : "text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  )}
                  title={entry.label}
                >
                  <GroupIcon size={20} />
                </button>
              );
            }

            // Expanded mode: collapsible group
            return (
              <Collapsible
                key={entry.label}
                open={isOpen}
                onOpenChange={() => handleGroupClick(entry.label)}
              >
                <CollapsibleTrigger asChild>
                  <button
                    className={cn(
                      "flex items-center w-full gap-2.5 px-3 py-2 rounded-md transition-colors text-[11px] font-semibold uppercase tracking-wider mt-3 first:mt-0 min-h-[32px]",
                      hasActiveChild
                        ? "text-sidebar-foreground"
                        : "text-sidebar-foreground/40 hover:text-sidebar-foreground/70"
                    )}
                  >
                    <GroupIcon size={15} className="shrink-0" />
                    <span className="flex-1 text-left">{entry.label}</span>
                    <ChevronDown
                      size={13}
                      className={cn(
                        "shrink-0 transition-transform duration-200",
                        isOpen && "rotate-180"
                      )}
                    />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="relative ml-[22px] pl-2 border-l border-sidebar-border/30 space-y-0.5 pb-0.5">
                    {visibleChildren.map((child) => {
                      const isActive = location === child.href;
                      const ChildIcon = child.icon;
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          className={cn(
                            "flex items-center gap-2.5 px-2.5 py-2 rounded-md transition-colors text-sm font-medium min-h-[38px]",
                            isActive
                              ? "bg-sidebar-primary text-sidebar-primary-foreground"
                              : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                          )}
                          onClick={mobile ? onClose : undefined}
                        >
                          <ChildIcon size={16} className="shrink-0" />
                          <span>{child.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </nav>
      </ScrollArea>

      <div className="p-4 border-t border-sidebar-border/50">
        {(!collapsed || mobile) && user && (
          <div className="flex items-center gap-3 mb-4 px-2">
            <Avatar className="h-8 w-8 border border-sidebar-border">
              <AvatarFallback>{(user.displayName || user.username).slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="flex flex-col overflow-hidden">
              <span className="text-sm font-medium truncate">{user.displayName || user.username}</span>
              <span className="text-xs text-sidebar-foreground/50 truncate capitalize">{user.role}</span>
            </div>
          </div>
        )}
        <Button
          variant="ghost"
          onClick={handleLogout}
          className={cn(
            "w-full text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent min-h-[44px]",
            collapsed && !mobile ? "justify-center px-2" : "justify-start gap-2"
          )}
        >
          <LogOut size={16} />
          {(!collapsed || mobile) && <span>Log out</span>}
        </Button>
      </div>
    </div>
  );
};

const Sidebar = ({ collapsed, onToggle }: SidebarProps) => {
  return (
    <div
      className={cn(
        "hidden md:flex flex-col bg-sidebar text-sidebar-foreground transition-all duration-300 ease-in-out border-r border-sidebar-border z-20",
        collapsed ? "w-16" : "w-64"
      )}
    >
      <SidebarContent collapsed={collapsed} onExpand={() => { if (collapsed) onToggle(); }} />

      <div className="px-4 pb-4">
        <Button
          variant="ghost"
          className={cn(
            "w-full flex items-center text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent min-h-[44px]",
            collapsed ? "justify-center px-0" : "justify-start gap-3"
          )}
          onClick={onToggle}
        >
          {collapsed ? <ChevronRight size={18} /> : <><ChevronLeft size={18} /> <span>Collapse</span></>}
        </Button>
      </div>
    </div>
  );
};

export default function Layout({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const isMobile = useIsMobile();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  return (
    <div className="flex h-screen bg-background overflow-hidden font-sans">
      {/* Desktop Sidebar */}
      <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />

      {/* Mobile Sidebar (Sheet) */}
      {isMobile && (
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="p-0 bg-sidebar text-sidebar-foreground border-r-sidebar-border w-[80%] max-w-[300px]">
            <SheetTitle className="sr-only">Navigation Menu</SheetTitle>
            <SidebarContent collapsed={false} mobile onClose={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b bg-card px-4 md:px-6 flex items-center justify-between gap-4 shrink-0 z-10">
          <div className="flex items-center gap-4 flex-1">
            {isMobile && (
              <Button variant="ghost" size="icon" className="-ml-2 min-h-[44px] min-w-[44px]" onClick={() => setMobileOpen(true)}>
                <Menu className="h-5 w-5" />
              </Button>
            )}

            <div className="relative w-full max-w-md hidden md:block">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Search..."
                className="pl-9 bg-secondary/50 border-transparent focus-visible:bg-background focus-visible:border-input transition-all h-10"
              />
            </div>
            {isMobile && <span className="font-semibold text-lg">Echelon</span>}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="text-muted-foreground relative min-h-[44px] min-w-[44px]">
              <Bell size={18} />
              <span className="absolute top-2 right-2.5 w-2 h-2 bg-destructive rounded-full border-2 border-card"></span>
            </Button>
            {isAdmin && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="text-muted-foreground min-h-[44px] min-w-[44px]" data-testid="button-settings-menu">
                    <Settings size={18} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuLabel>Settings</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild data-testid="link-general-settings">
                    <Link href="/settings" className="w-full cursor-pointer">
                      <Cog className="mr-2 h-4 w-4" />
                      General Settings
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild data-testid="link-integrations">
                    <Link href="/integrations" className="w-full cursor-pointer">
                      <Cable className="mr-2 h-4 w-4" />
                      Integrations
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Administration</DropdownMenuLabel>
                  <DropdownMenuItem asChild data-testid="link-user-management">
                    <Link href="/users" className="w-full cursor-pointer">
                      <Users className="mr-2 h-4 w-4" />
                      User Management
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild data-testid="link-roles-permissions">
                    <Link href="/roles" className="w-full cursor-pointer">
                      <Shield className="mr-2 h-4 w-4" />
                      Roles & Permissions
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Separator orientation="vertical" className="h-6 mx-2 hidden md:block" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 px-0 md:px-3 min-h-[44px]">
                  <Avatar className="h-8 w-8 md:h-7 md:w-7 border border-sidebar-border">
                     <AvatarImage src="https://github.com/shadcn.png" />
                     <AvatarFallback>JD</AvatarFallback>
                  </Avatar>
                  <span className="text-sm font-medium hidden md:inline-block">Acme Corp.</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Organization</DropdownMenuLabel>
                <DropdownMenuItem>Settings</DropdownMenuItem>
                <DropdownMenuItem>Billing</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => {
                  fetch("/api/auth/logout", { method: "POST" }).then(() => {
                    window.location.href = "/login";
                  });
                }}>Log out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="flex-1 overflow-auto bg-muted/20">
          {children}
        </main>
      </div>
    </div>
  );
}
