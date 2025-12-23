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
  Globe
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

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

type NavItem = 
  | { type: 'link'; label: string; icon: LucideIcon; href: string }
  | { type: 'separator'; label: string };

const Sidebar = ({ collapsed, onToggle }: SidebarProps) => {
  const [location] = useLocation();

  const navItems: NavItem[] = [
    { type: 'link', label: "Dashboard", icon: LayoutDashboard, href: "/" },
    { type: "separator", label: "Operations" },
    { type: 'link', label: "Inventory (WMS)", icon: Package, href: "/inventory" },
    { type: 'link', label: "Orders (OMS)", icon: ShoppingCart, href: "/orders" },
    { type: 'link', label: "Picking & Packing", icon: ClipboardList, href: "/picking" },
    { type: 'link', label: "Shipping", icon: Truck, href: "/shipping" },
    { type: "separator", label: "Dropship & Integrations" },
    { type: 'link', label: "Dropship Network", icon: Globe, href: "/dropship" },
    { type: "separator", label: "Management" },
    { type: 'link', label: "Purchase Orders", icon: Box, href: "/purchasing" },
    { type: 'link', label: "Vendors", icon: Users, href: "/vendors" },
    { type: 'link', label: "Analytics", icon: BarChart3, href: "/analytics" },
  ];

  return (
    <div 
      className={cn(
        "flex flex-col bg-sidebar text-sidebar-foreground transition-all duration-300 ease-in-out border-r border-sidebar-border z-20",
        collapsed ? "w-16" : "w-64"
      )}
    >
      <div className="h-14 flex items-center px-4 border-b border-sidebar-border/50 shrink-0">
        <div className={cn("font-bold text-lg tracking-tight flex items-center gap-2 overflow-hidden", collapsed ? "w-0 opacity-0" : "w-auto opacity-100 transition-opacity")}>
          <div className="bg-primary/20 p-1.5 rounded-md text-primary">
            <Box size={20} />
          </div>
          <span>Nexus<span className="text-sidebar-foreground/60">WMS</span></span>
        </div>
        {collapsed && (
          <div className="mx-auto bg-primary/20 p-1.5 rounded-md text-primary">
            <Box size={20} />
          </div>
        )}
      </div>

      <ScrollArea className="flex-1 py-4">
        <nav className="space-y-1 px-2">
          {navItems.map((item, index) => {
            if (item.type === "separator") {
              if (collapsed) return <Separator key={index} className="my-4 bg-sidebar-border/50" />;
              return (
                <div key={index} className="px-3 py-2 mt-4 mb-1 text-xs font-medium text-sidebar-foreground/50 uppercase tracking-wider">
                  {item.label}
                </div>
              );
            }
            
            const isActive = location === item.href;
            const Icon = item.icon;
            
            return (
              <Link key={index} href={item.href}>
                <a className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium",
                  isActive 
                    ? "bg-sidebar-primary text-sidebar-primary-foreground" 
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  collapsed && "justify-center px-2"
                )}>
                  <Icon size={20} className={cn(collapsed && "mx-auto")} />
                  {!collapsed && <span>{item.label}</span>}
                </a>
              </Link>
            );
          })}
        </nav>
      </ScrollArea>

      <div className="p-4 border-t border-sidebar-border/50">
        {!collapsed && (
          <div className="flex items-center gap-3 mb-4 px-2">
            <Avatar className="h-8 w-8 border border-sidebar-border">
              <AvatarImage src="https://github.com/shadcn.png" />
              <AvatarFallback>JD</AvatarFallback>
            </Avatar>
            <div className="flex flex-col overflow-hidden">
              <span className="text-sm font-medium truncate">John Doe</span>
              <span className="text-xs text-sidebar-foreground/50 truncate">Warehouse Mgr</span>
            </div>
          </div>
        )}
        <Button 
          variant="ghost" 
          size="sm" 
          className={cn(
            "w-full flex items-center text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent",
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

  return (
    <div className="flex h-screen bg-background overflow-hidden font-sans">
      <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
      
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b bg-card px-6 flex items-center justify-between gap-4 shrink-0 z-10">
          <div className="flex items-center gap-4 flex-1 max-w-xl">
            <div className="relative w-full max-w-md">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input 
                placeholder="Search SKUs, Orders, POs..." 
                className="pl-9 bg-secondary/50 border-transparent focus-visible:bg-background focus-visible:border-input transition-all h-9" 
              />
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="text-muted-foreground relative">
              <Bell size={18} />
              <span className="absolute top-2 right-2.5 w-2 h-2 bg-destructive rounded-full border-2 border-card"></span>
            </Button>
            <Button variant="ghost" size="icon" className="text-muted-foreground">
              <Settings size={18} />
            </Button>
            <Separator orientation="vertical" className="h-6 mx-2" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-2">
                  <span className="text-sm font-medium hidden sm:inline-block">Acme Corp.</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Organization</DropdownMenuLabel>
                <DropdownMenuItem>Settings</DropdownMenuItem>
                <DropdownMenuItem>Billing</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>Log out</DropdownMenuItem>
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
