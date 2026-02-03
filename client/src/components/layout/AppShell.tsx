import React, { useState } from "react";
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
  RefreshCw
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

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  mobile?: boolean;
  onClose?: () => void;
}

type NavItem = 
  | { type: 'link'; label: string; icon: LucideIcon; href: string; roles?: string[] }
  | { type: 'separator'; label: string; roles?: string[] };

const SidebarContent = ({ collapsed, mobile, onClose }: { collapsed: boolean, mobile?: boolean, onClose?: () => void }) => {
  const [location] = useLocation();
  const { user, logout } = useAuth();

  const allNavItems: NavItem[] = [
    { type: 'link', label: "Dashboard", icon: LayoutDashboard, href: "/", roles: ["admin", "lead"] },
    { type: "separator", label: "Catalog", roles: ["admin", "lead"] },
    { type: 'link', label: "Products", icon: Package, href: "/products", roles: ["admin", "lead"] },
    { type: 'link', label: "Variants", icon: Layers, href: "/variants", roles: ["admin", "lead"] },
    { type: "separator", label: "Warehouse", roles: ["admin", "lead"] },
    { type: 'link', label: "Inventory (WMS)", icon: Box, href: "/inventory", roles: ["admin", "lead"] },
    { type: 'link', label: "Cycle Counts", icon: ClipboardList, href: "/cycle-counts", roles: ["admin", "lead"] },
    { type: 'link', label: "Bin Locations", icon: MapPin, href: "/warehouse/locations", roles: ["admin", "lead"] },
    { type: 'link', label: "Replenishment", icon: RefreshCw, href: "/replenishment", roles: ["admin", "lead"] },
    { type: 'link', label: "Warehouses", icon: Building2, href: "/warehouses", roles: ["admin", "lead"] },
    { type: "separator", label: "Purchasing", roles: ["admin", "lead"] },
    { type: 'link', label: "Receiving", icon: Truck, href: "/receiving", roles: ["admin", "lead"] },
    { type: 'link', label: "Product Catalog", icon: Layers, href: "/purchasing/catalog", roles: ["admin", "lead"] },
    { type: 'link', label: "Purchase Orders", icon: ShoppingBag, href: "/purchasing", roles: ["admin", "lead"] },
    { type: "separator", label: "Orders", roles: ["admin", "lead"] },
    { type: 'link', label: "Orders (OMS)", icon: ShoppingCart, href: "/orders", roles: ["admin", "lead"] },
    { type: 'link', label: "Order History", icon: History, href: "/order-history", roles: ["admin", "lead"] },
    { type: "separator", label: "Fulfillment" },
    { type: 'link', label: "Picking Queue", icon: ClipboardList, href: "/picking" },
    { type: 'link', label: "Picking Logs", icon: FileText, href: "/picking/logs", roles: ["admin", "lead"] },
    { type: 'link', label: "Picking Metrics", icon: BarChart3, href: "/picking/metrics", roles: ["admin", "lead"] },
    { type: 'link', label: "Inventory History", icon: History, href: "/inventory/history", roles: ["admin"] },
    { type: 'link', label: "Shipping", icon: Truck, href: "/shipping", roles: ["admin", "lead"] },
    { type: "separator", label: "Sales Channels", roles: ["admin", "lead"] },
    { type: 'link', label: "Channels", icon: Store, href: "/channels", roles: ["admin", "lead"] },
    { type: 'link', label: "Channel Reserves", icon: Package, href: "/channels/reserves", roles: ["admin", "lead"] },
    { type: 'link', label: "Dropship Network", icon: Globe, href: "/dropship", roles: ["admin", "lead"] },
  ];
  
  const navItems = allNavItems.filter(item => {
    if (!item.roles) return true;
    return user && item.roles.includes(user.role);
  });
  
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

      <ScrollArea className="flex-1 py-4">
        <nav className="space-y-1 px-2">
          {navItems.map((item, index) => {
            if (item.type === "separator") {
              if (collapsed && !mobile) return <Separator key={index} className="my-4 bg-sidebar-border/50" />;
              return (
                <div key={index} className="px-3 py-2 mt-4 mb-1 text-xs font-medium text-sidebar-foreground/50 uppercase tracking-wider">
                  {item.label}
                </div>
              );
            }
            
            const isActive = location === item.href;
            const Icon = item.icon;
            
            return (
              <Link 
                key={index} 
                href={item.href}
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
                {(!collapsed || mobile) && <span>{item.label}</span>}
              </Link>
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
      <SidebarContent collapsed={collapsed} />
      
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
