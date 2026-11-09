import React, { useState, useEffect, useMemo } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
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
  RotateCcw,
  Ship,
  Receipt,
  CreditCard,
  DollarSign,
  Tag,
  Crown,
  Map as MapIcon,
  ArrowUpDown,
  PackageCheck,
  TrendingUp,
  Route as RouteIcon,
  GitBranch,
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
import { PURCHASING_DASHBOARD_READ_PERMISSIONS, PURCHASING_READ_PERMISSION, RECEIVING_READ_PERMISSIONS } from "@/lib/procurement-access";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { NotificationBell } from "@/components/NotificationBell";
import { PageDataHealth } from "@/components/page-data-health";
import { CUSTOMER_RETURN_PORTAL_PATH } from "@shared/returns/customer-return-portal-paths";

// --- Navigation types ---

type NavPermission = { resource: string; action: string };
type NavSystemRole = "admin" | "lead" | "picker";
type NavLink = {
  anyOfPermissions?: NavPermission[];
  allOfPermissions?: NavPermission[];
  label: string;
  icon: LucideIcon;
  href: string;
  roles?: NavSystemRole[];
  requiredPermission?: NavPermission;
};
type NavGroup = {
  label: string;
  icon: LucideIcon;
  children: NavLink[];
  roles?: NavSystemRole[];
  requiredPermission?: NavPermission;
};
type NavEntry = NavLink | NavGroup;

function isNavGroup(entry: NavEntry): entry is NavGroup {
  return 'children' in entry;
}

function navPath(href: string): string {
  const [path] = href.split(/[?#]/, 1);
  return path || "/";
}

function navHrefHasQueryOrHash(href: string): boolean {
  return href.includes("?") || href.includes("#");
}

function navHrefBelongsToLocation(pathname: string, href: string): boolean {
  const hrefPath = navPath(href);
  return pathname === hrefPath || (hrefPath !== "/" && pathname.startsWith(`${hrefPath}/`));
}

/** Sidebar links to a tab of the one-route Dropship admin page. */
const DROPSHIP_TAB_HREF_PREFIX = "/dropship?tab=";

/** One query parameter of an href or of the current location, or null when absent. */
function navHrefQueryParam(href: string, name: string): string | null {
  const queryStart = href.indexOf("?");
  if (queryStart < 0) return null;
  const hashStart = href.indexOf("#", queryStart);
  const query = href.slice(queryStart + 1, hashStart < 0 ? undefined : hashStart);
  return new URLSearchParams(query).get(name);
}

function isNavHrefActive(pathname: string, currentHref: string, href: string): boolean {
  if (href === "/dropship?tab=overview" && pathname === "/dropship" && currentHref === "/dropship") {
    return true;
  }

  // A Dropship tab writes its own query string (Program finance keeps its
  // period, vendor and open rows in the URL), so its link matches on the
  // path and the `tab` param only, not on the whole href.
  if (href.startsWith(DROPSHIP_TAB_HREF_PREFIX)) {
    return pathname === "/dropship" && navHrefQueryParam(currentHref, "tab") === navHrefQueryParam(href, "tab");
  }

  if (navHrefHasQueryOrHash(href)) {
    return currentHref === href;
  }

  return navHrefBelongsToLocation(pathname, href);
}

// --- Navigation structure ---

// Reorder Engine flag wiring (design spec §10 rev 1): Procurement keeps ONE
// entry for the reorder surface. When the `useNewReorderCockpit` procurement
// setting is on, that entry reads "Reorder Engine"; off (or on any settings
// load error) it stays "Reorder Analysis". Same href and icon either way —
// the route-level switch lives in App.tsx (ReorderAnalysisRoute).
const REORDER_ANALYSIS_HREF = "/reorder-analysis";
const REORDER_ENGINE_NAV_LABEL = "Reorder Engine";

const navStructure: NavEntry[] = [
  { label: "Dashboard", icon: LayoutDashboard, href: "/", requiredPermission: { resource: "inventory", action: "view" } },
  { label: "Operations Control Tower", icon: BarChart3, href: "/oms/flow-monitor", requiredPermission: { resource: "operations", action: "view" } },
  {
    label: "Procurement",
    icon: ShoppingBag,

    children: [
      { label: "Dashboard", icon: LayoutDashboard, href: "/purchasing", allOfPermissions: PURCHASING_DASHBOARD_READ_PERMISSIONS },
      { label: "Purchase Orders", icon: FileText, href: "/purchase-orders", anyOfPermissions: [PURCHASING_READ_PERMISSION] },
      { label: "Reorder Analysis", icon: BarChart3, href: REORDER_ANALYSIS_HREF, requiredPermission: { resource: "inventory", action: "view" } },
      { label: "Demand Planner", icon: TrendingUp, href: "/demand-planner", requiredPermission: PURCHASING_READ_PERMISSION },
      { label: "Receiving", icon: Truck, href: "/receiving", anyOfPermissions: RECEIVING_READ_PERMISSIONS },
      { label: "Shipments", icon: Ship, href: "/shipments", anyOfPermissions: [PURCHASING_READ_PERMISSION] },
      { label: "Suppliers", icon: Building2, href: "/suppliers", requiredPermission: PURCHASING_READ_PERMISSION },
    ],
  },
  {
    label: "Accounts Payable",
    icon: DollarSign,

    children: [
      { label: "AP Dashboard", icon: BarChart3, href: "/ap", requiredPermission: PURCHASING_READ_PERMISSION },
      { label: "Invoices", icon: Receipt, href: "/ap-invoices", anyOfPermissions: [PURCHASING_READ_PERMISSION] },
      { label: "Payments", icon: CreditCard, href: "/ap-payments", requiredPermission: PURCHASING_READ_PERMISSION },
      { label: "Supplier Credits", icon: Receipt, href: "/supplier-credits", requiredPermission: PURCHASING_READ_PERMISSION },
      { label: "Supplier Returns", icon: Receipt, href: "/supplier-returns", requiredPermission: PURCHASING_READ_PERMISSION },
    ],
  },
  {
    label: "Inventory",
    icon: Box,

    children: [
      { label: "Stock Levels", icon: Box, href: "/inventory", requiredPermission: { resource: "inventory", action: "view" } },
      { label: "Builds", icon: PackageCheck, href: "/inventory/builds", requiredPermission: { resource: "inventory", action: "view" } },
      {
        label: "Supply & Transformations",
        icon: GitBranch,
        href: "/inventory/supply-transformations",
        requiredPermission: { resource: "inventory_planning", action: "view" },
      },
      {
        label: "Inventory Cutover",
        icon: Shield,
        href: "/inventory/cutover",
        requiredPermission: { resource: "inventory_planning", action: "view" },
      },
      { label: "Warehouses", icon: Building2, href: "/warehouse", requiredPermission: { resource: "inventory", action: "view" } },
      { label: "Pick Zones", icon: MapIcon, href: "/pick-zones", requiredPermission: { resource: "inventory", action: "view" } },
      { label: "Slotting Setup", icon: MapPin, href: "/slotting-setup", requiredPermission: { resource: "inventory", action: "view" } },
      { label: "Cycle Counts", icon: ClipboardList, href: "/cycle-counts", requiredPermission: { resource: "inventory", action: "view" } },
      { label: "Transfers", icon: ArrowLeftRight, href: "/transfers", requiredPermission: { resource: "inventory", action: "view" } },
      { label: "Replenishment", icon: RefreshCw, href: "/replenishment", requiredPermission: { resource: "inventory", action: "view" } },
      { label: "History", icon: History, href: "/inventory/history", requiredPermission: { resource: "inventory", action: "audit" } },
      { label: "Cost Dashboard", icon: DollarSign, href: "/inventory/costs", requiredPermission: { resource: "inventory", action: "view" } },
    ],
  },
  {
    label: "Orders (OMS)",
    icon: Globe,

    children: [
      { label: "Orders", icon: Globe, href: "/oms/orders", requiredPermission: { resource: "orders", action: "view" } },
      { label: "Order editor pilot", icon: FileText, href: "/order-edits", requiredPermission: { resource: "orders", action: "edit" } },
      { label: "Order History", icon: History, href: "/order-history", requiredPermission: { resource: "orders", action: "view" } },
    ],
  },
  {
    label: "Returns",
    icon: RotateCcw,

    children: [
      { label: "Cases", icon: ClipboardList, href: "/returns/cases", requiredPermission: { resource: "inventory", action: "view" } },
      { label: "Customer portal", icon: Store, href: CUSTOMER_RETURN_PORTAL_PATH, requiredPermission: { resource: "settings", action: "edit" } },
      { label: "Policies", icon: FileText, href: "/return-policies", requiredPermission: { resource: "settings", action: "view" } },
      { label: "Receiving", icon: PackageCheck, href: "/returns/receiving", requiredPermission: { resource: "inventory", action: "view" } },
    ],
  },
  {
    label: "Warehouse (WMS)",
    icon: ShoppingCart,
    // Preserve these legacy membership-gated routes until their owning WMS slice
    // migrates both server/page admission and navigation together.
    children: [
      { label: "Orders", icon: ShoppingCart, href: "/orders", requiredPermission: { resource: "orders", action: "view" } },
      { label: "Picking", icon: ClipboardList, href: "/picking", requiredPermission: { resource: "picking", action: "view" } },
      { label: "Assembly work", icon: PackageCheck, href: "/assembly", requiredPermission: { resource: "warehouse_work", action: "assembly" } },
      { label: "Pick Priority", icon: ArrowUpDown, href: "/pick-priority", requiredPermission: { resource: "settings", action: "view" } },

    ],
  },
  {
    label: "Shipping",
    icon: Truck,

    children: [
      { label: "Shipments", icon: Truck, href: "/outbound-shipments", requiredPermission: { resource: "shipments", action: "view" } },
      { label: "Shipping Groups", icon: Layers, href: "/shipping-groups", requiredPermission: { resource: "inventory", action: "view" } },
      { label: "Service Levels", icon: RouteIcon, href: "/shipping-service-levels", requiredPermission: { resource: "settings", action: "view" } },
      { label: "Settings", icon: Package, href: "/shipping-settings", requiredPermission: { resource: "settings", action: "view" } },
    ],
  },
  {
    label: "Catalog & Channels",
    icon: Store,

    children: [
      { label: "Catalog", icon: Package, href: "/catalog", requiredPermission: { resource: "inventory", action: "view" } },
      { label: "Product Lines", icon: Tag, href: "/product-lines", requiredPermission: { resource: "channels", action: "view" } },
      { label: "Channels", icon: Store, href: "/channels", requiredPermission: { resource: "channels", action: "view" } },
      {
        label: "Channel Inventory",
        icon: GitBranch,
        href: "/channels/inventory",
        requiredPermission: { resource: "inventory_planning", action: "view" },
      },
      { label: "Allocation", icon: Layers, href: "/channel-allocation", requiredPermission: { resource: "channels", action: "view" } },
      { label: "Sync Log", icon: History, href: "/sync-log", requiredPermission: { resource: "channels", action: "view" } },
      { label: "Subscriptions", icon: Crown, href: "/subscriptions", requiredPermission: { resource: "shellz", action: "admin" } },
    ],
  },
  {
    label: "Dropship",
    icon: Globe,
    requiredPermission: { resource: "dropship", action: "view" },
    children: [
      { label: "Overview", icon: LayoutDashboard, href: "/dropship?tab=overview" },
      { label: "Launch Readiness", icon: Shield, href: "/dropship?tab=dogfood" },
      { label: "Catalog Exposure", icon: Package, href: "/dropship?tab=catalog" },
      { label: "Shipping Config", icon: Truck, href: "/dropship?tab=shipping" },
      { label: "Store Connections", icon: Store, href: "/dropship?tab=stores" },
      { label: "Order Intake", icon: ClipboardList, href: "/dropship?tab=order-intake" },
      { label: "Listing Pushes", icon: Tag, href: "/dropship?tab=listing-pushes" },
      { label: "Tracking Pushes", icon: Truck, href: "/dropship?tab=tracking-pushes" },
      { label: "Wallet Ops", icon: CreditCard, href: "/dropship?tab=wallet-ops" },
      { label: "Wallet Policy", icon: DollarSign, href: "/dropship?tab=wallet-policy" },
      {
        label: "Program finance",
        icon: Receipt,
        href: "/dropship?tab=finance",
        requiredPermission: { resource: "dropship", action: "manage_operations" },
      },
      { label: "Cost Changes", icon: TrendingUp, href: "/dropship?tab=cost-changes" },
      { label: "Notifications", icon: Bell, href: "/dropship?tab=notifications" },
      { label: "Audit", icon: History, href: "/dropship?tab=audit" },
    ],
  },
  {
    label: "Vendors",
    icon: Users,

    children: [
      { label: "All Vendors", icon: Users, href: "/vendors", requiredPermission: { resource: "dropship", action: "view" } },
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
  const search = useSearch();
  const locationPath = navPath(location);
  const currentHref = search ? `${locationPath}?${search}` : locationPath;
  const { user, assignedRoles, logout, hasPermission, hasSystemRole } = useAuth();
  const hasAssignedAccess = !!user && assignedRoles.length > 0;
  const [logoutError, setLogoutError] = useState<string | null>(null);

  // Reorder Engine flag (see REORDER_ENGINE_NAV_LABEL above). Same query key
  // as ReorderAnalysisRoute in App.tsx so React Query dedupes the request.
  // Only fetched for roles that can see the Reorder Analysis link — the endpoint
  // is gated by requirePermission("purchasing", "view") and the label is
  // invisible to everyone else anyway. Fail-safe: undefined/error → legacy label.
  type ProcurementSettings = { useNewReorderCockpit?: boolean; [key: string]: unknown };
  const canSeeReorderLink = hasAssignedAccess && hasPermission("purchasing", "view");
  const { data: procurementSettings } = useQuery<ProcurementSettings>({
    queryKey: ["/api/settings/procurement"],
    retry: false,
    enabled: canSeeReorderLink,
  });
  const useNewReorderCockpit = procurementSettings?.useNewReorderCockpit === true;

  // navStructure is static; apply the flag-conditional relabel as a derived
  // view so the base structure (and the flag-off render) stays byte-identical.
  const navEntries = useMemo<NavEntry[]>(() => {
    if (!useNewReorderCockpit) return navStructure;
    return navStructure.map((entry) => {
      if (!isNavGroup(entry)) return entry;
      const children = entry.children.map((child) =>
        child.href === REORDER_ANALYSIS_HREF
          ? { ...child, label: REORDER_ENGINE_NAV_LABEL }
          : child,
      );
      return { ...entry, children };
    });
  }, [useNewReorderCockpit]);

  // Find which group contains the active route
  const getActiveGroupLabel = (pathname: string): string | null => {
    for (const entry of navStructure) {
      if (!isNavGroup(entry)) continue;
      for (const child of entry.children) {
        if (navHrefBelongsToLocation(pathname, child.href)) return entry.label;
      }
    }
    return null;
  };

  const [expandedGroup, setExpandedGroup] = useState<string | null>(
    () => getActiveGroupLabel(locationPath)
  );

  // Auto-expand group when navigating to a page in a different group
  useEffect(() => {
    const activeLabel = getActiveGroupLabel(locationPath);
    if (activeLabel) {
      setExpandedGroup(activeLabel);
    }
  }, [locationPath]);

  // Verified grants govern named capabilities. Unmapped surfaces retain their
  // assigned system-role requirement, never the compatibility users.role label.
  const isVisible = (roles?: NavSystemRole[], permission?: NavPermission) => {
    if (!hasAssignedAccess) return false;
    if (permission) return hasPermission(permission.resource, permission.action);
    if (!roles) return true;
    return roles.some(role => hasSystemRole(role));
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
    setLogoutError(null);
    try {
      await logout();
      window.location.href = "/login";
    } catch {
      setLogoutError("Sign out could not be verified. Try again.");
    }
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
          {navEntries.map((entry) => {
            // Top-level role check
            // Standalone link (Dashboard)
            if (!isNavGroup(entry)) {
              if (!isVisible(entry.roles, entry.requiredPermission)) return null;
              const isActive = isNavHrefActive(locationPath, currentHref, entry.href);
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

            // Explicit child access takes precedence; unconfigured children inherit
            // their parent. Preserve that existing fallback for unrelated modules.
            const parentVisible = isVisible(entry.roles, entry.requiredPermission);
            const visibleChildren = entry.children.filter((child) => hasAssignedAccess && (
              child.allOfPermissions
                ? child.allOfPermissions.every(permission => hasPermission(permission.resource, permission.action))
                : child.anyOfPermissions
                  ? child.anyOfPermissions.some(permission => hasPermission(permission.resource, permission.action))
                  : child.requiredPermission
                    ? isVisible(child.roles, child.requiredPermission)
                    : child.roles
                      ? isVisible(child.roles)
                      : parentVisible));
            if (visibleChildren.length === 0) return null;

            const GroupIcon = entry.icon;
            const isOpen = expandedGroup === entry.label;
            const hasActiveChild = visibleChildren.some(child =>
              navHrefBelongsToLocation(locationPath, child.href)
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
                      const isActive = isNavHrefActive(locationPath, currentHref, child.href);
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
              <span className="text-xs text-sidebar-foreground/50 truncate" data-testid="sidebar-assigned-roles">{assignedRoles.length ? assignedRoles.map(role => role.name).join(", ") : "No assigned roles"}</span>
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
        {logoutError && <p role="alert" className="text-xs text-destructive mt-2">{logoutError}</p>}
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
  const { user, assignedRoles, hasPermission, hasSystemRole, logout } = useAuth();
  const hasAssignedAccess = !!user && assignedRoles.length > 0;
  const canEditSettings = hasPermission("settings", "edit");
  const canViewSettings = hasPermission("settings", "view");
  const canViewProcurementSettings = hasPermission("purchasing", "view") || hasPermission("settings", "edit");
  const canViewUsers = hasPermission("users", "view");
  const canViewRoles = hasPermission("roles", "view");
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const handleLogout = async () => {
    setLogoutError(null);
    try {
      await logout();
      window.location.href = "/login";
    } catch {
      setLogoutError("Sign out could not be verified. Try again.");
    }
  };

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
              <Button variant="ghost" size="icon" aria-label="Open navigation" className="-ml-2 min-h-[44px] min-w-[44px]" onClick={() => setMobileOpen(true)}>
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
            <NotificationBell />
            {hasAssignedAccess && (canEditSettings || canViewSettings || canViewProcurementSettings || canViewUsers || canViewRoles) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="text-muted-foreground min-h-[44px] min-w-[44px]" data-testid="button-settings-menu">
                    <Settings size={18} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuLabel>Settings</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {canViewSettings && <DropdownMenuItem asChild data-testid="link-general-settings">
                    <Link href="/settings" className="w-full cursor-pointer">
                      <Cog className="mr-2 h-4 w-4" />
                      General Settings
                    </Link>
                  </DropdownMenuItem>}
                  {canViewProcurementSettings && <DropdownMenuItem asChild data-testid="link-procurement-settings">
                    <Link href="/settings/procurement" className="w-full cursor-pointer">
                      <ShoppingBag className="mr-2 h-4 w-4" />
                      Procurement
                    </Link>
                  </DropdownMenuItem>}
                  {canViewSettings && <DropdownMenuItem asChild data-testid="link-shipping-settings">
                    <Link href="/shipping-settings" className="w-full cursor-pointer">
                      <Package className="mr-2 h-4 w-4" />
                      Shipping
                    </Link>
                  </DropdownMenuItem>}
                  {canEditSettings && <DropdownMenuItem asChild data-testid="link-integrations">
                    <Link href="/integrations" className="w-full cursor-pointer">
                      <Cable className="mr-2 h-4 w-4" />
                      Integrations
                    </Link>
                  </DropdownMenuItem>}
                  {canViewSettings && <DropdownMenuItem asChild>
                    <Link href="/notification-preferences" className="w-full cursor-pointer">
                      <Bell className="mr-2 h-4 w-4" />
                      Notifications
                    </Link>
                  </DropdownMenuItem>}
                  {(canViewUsers || canViewRoles) && <><DropdownMenuSeparator /><DropdownMenuLabel>Administration</DropdownMenuLabel></>}
                  {canViewUsers && <DropdownMenuItem asChild data-testid="link-user-management">
                    <Link href="/users" className="w-full cursor-pointer">
                      <Users className="mr-2 h-4 w-4" />
                      User Management
                    </Link>
                  </DropdownMenuItem>}
                  {canViewRoles && <DropdownMenuItem asChild data-testid="link-roles-permissions">
                    <Link href="/roles" className="w-full cursor-pointer">
                      <Shield className="mr-2 h-4 w-4" />
                      Roles & Permissions
                    </Link>
                  </DropdownMenuItem>}
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
                <DropdownMenuItem asChild><a href="/staff/password">Change password</a></DropdownMenuItem>
                <DropdownMenuItem onClick={handleLogout}>Log out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {logoutError && <p role="alert" className="text-xs text-destructive">{logoutError}</p>}
          </div>
        </header>

        <main
          className="min-h-0 flex-1 overflow-auto bg-muted/20"
          data-app-scroll-container
        >
          <PageDataHealth />
          {children}
        </main>
      </div>
    </div>
  );
}
