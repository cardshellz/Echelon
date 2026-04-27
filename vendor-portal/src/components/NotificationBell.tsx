import { useState } from "react";
import { Bell, Check, CheckCheck, Package, Truck, AlertTriangle, Layers, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  useUnreadCount,
  useNotifications,
  useMarkRead,
  useMarkAllRead,
  type NotificationItem,
} from "@/hooks/use-notifications";

const categoryIcons: Record<string, typeof Bell> = {
  replenishment: Layers,
  receiving: Truck,
  picking: ShoppingCart,
  inventory: AlertTriangle,
};

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function NotificationRow({
  item,
  onRead,
}: {
  item: NotificationItem;
  onRead: (id: number) => void;
}) {
  const Icon = categoryIcons[item.category] ?? Bell;
  const isUnread = item.read === 0;

  return (
    <button
      className={cn(
        "w-full text-left px-3 py-2.5 flex gap-3 items-start hover:bg-muted/50 transition-colors border-b last:border-b-0",
        isUnread && "bg-primary/5"
      )}
      onClick={() => {
        if (isUnread) onRead(item.id);
      }}
    >
      <div
        className={cn(
          "mt-0.5 p-1.5 rounded-md shrink-0",
          isUnread
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground"
        )}
      >
        <Icon size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <p
          className={cn(
            "text-sm leading-tight truncate",
            isUnread ? "font-medium" : "text-muted-foreground"
          )}
        >
          {item.title}
        </p>
        {item.message && (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
            {item.message}
          </p>
        )}
        <p className="text-xs text-muted-foreground/70 mt-1">
          {timeAgo(item.createdAt)}
        </p>
      </div>
      {isUnread && (
        <div className="mt-1.5 w-2 h-2 rounded-full bg-primary shrink-0" />
      )}
    </button>
  );
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const unreadCount = useUnreadCount();
  const { data: items = [] } = useNotifications({ limit: 30 });
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground relative min-h-[44px] min-w-[44px]"
        >
          <Bell size={18} />
          {unreadCount > 0 && (
            <span className="absolute top-1.5 right-1.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center bg-destructive text-destructive-foreground text-[10px] font-bold rounded-full border-2 border-card">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[360px] p-0"
        sideOffset={8}
      >
        <div className="flex items-center justify-between px-3 py-2.5 border-b">
          <h3 className="font-semibold text-sm">Notifications</h3>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => markAllRead.mutate()}
              disabled={markAllRead.isPending}
            >
              <CheckCheck size={14} />
              Mark all read
            </Button>
          )}
        </div>

        <ScrollArea className="max-h-[400px]">
          {items.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No notifications yet
            </div>
          ) : (
            items.map((item) => (
              <NotificationRow
                key={item.id}
                item={item}
                onRead={(id) => markRead.mutate(id)}
              />
            ))
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
