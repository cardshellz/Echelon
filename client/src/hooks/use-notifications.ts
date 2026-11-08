import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { useEffect, useRef } from "react";

const NOTIFICATION_RECONNECT_INITIAL_MS = 1_000;
const NOTIFICATION_RECONNECT_MAX_MS = 30_000;
const NOTIFICATION_CONNECTION_STABLE_MS = 30_000;

// Types matching the backend response
export interface NotificationItem {
  id: number;
  title: string;
  message: string | null;
  data: Record<string, unknown> | null;
  read: number;
  createdAt: string;
  typeKey: string;
  category: string;
  typeLabel: string;
}

export interface NotificationPreference {
  id: number;
  key: string;
  label: string;
  description: string | null;
  category: string;
  enabled: boolean;
  isOverride: boolean;
}

/**
 * Hook for the unread notification count (badge).
 * Polls every 30s and also refreshes on WebSocket messages.
 */
export function useUnreadCount() {
  const { user, assignedRoles, accessStatus, refetch } = useAuth();
  const hasStaffAccess = !!user && accessStatus === "authenticated" && assignedRoles.length > 0;
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);

  const query = useQuery<{ count: number }>({
    queryKey: ["/api/notifications/unread-count"],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/notifications/unread-count", { signal });
      if (!res.ok) throw new Error("Failed to fetch unread count");
      return res.json();
    },
    refetchInterval: 30_000,
    enabled: hasStaffAccess,
  });

  // WebSocket connection for real-time pushes
  useEffect(() => {
    if (!hasStaffAccess) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    let disposed = false;
    let revoked = false;
    let retryDelay = NOTIFICATION_RECONNECT_INITIAL_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const reloadNotifications = () => {
      // Pushes are hints. The persisted list/count recover events missed during
      // a disconnect, an authority outage, or the server's bounded queue overflow.
      void queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    };
    const scheduleReconnect = () => {
      if (disposed || revoked || reconnectTimer !== undefined) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, NOTIFICATION_RECONNECT_MAX_MS);
    };

    const connect = () => {
      if (disposed || revoked) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        // Construction can fail before the browser provides close/error events.
        reloadNotifications();
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;
      let openedAt: number | undefined;
      const isCurrent = () => !disposed && wsRef.current === ws;
      ws.onopen = () => {
        if (!isCurrent()) return;
        openedAt = Date.now();
        reloadNotifications();
      };
      ws.onmessage = (event) => {
        if (!isCurrent()) return;
        try {
          const msg: unknown = JSON.parse(event.data);
          if (msg && typeof msg === "object" && "type" in msg && msg.type === "authority:updated") {
            void refetch();
            reloadNotifications();
          } else if (msg && typeof msg === "object" && "type" in msg && msg.type === "notification") {
            reloadNotifications();
          }
        } catch {
          // A malformed hint cannot replace authoritative notification data.
          reloadNotifications();
        }
      };
      ws.onerror = () => {
        if (isCurrent()) reloadNotifications();
        // Browsers follow a transport error with close; only close schedules retry.
      };
      ws.onclose = async (event) => {
        if (!isCurrent()) return;
        wsRef.current = null;
        reloadNotifications();
        if (event.code === 1008) {
          revoked = true;
          await refetch();
          return;
        }
        // A rejected HTTP upgrade is exposed as 1006, not its 401/403 status.
        // Refresh authority before retrying so a revoked session cannot loop.
        if (event.code === 1006) await refetch();
        if (openedAt !== undefined && Date.now() - openedAt >= NOTIFICATION_CONNECTION_STABLE_MS) {
          retryDelay = NOTIFICATION_RECONNECT_INITIAL_MS;
        }
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [user?.id, hasStaffAccess, queryClient, refetch]);

  return hasStaffAccess ? query.data?.count ?? 0 : 0;
}

/**
 * Hook for the notification list.
 */
export function useNotifications(opts?: { unreadOnly?: boolean; limit?: number }) {
  const { user, assignedRoles, accessStatus } = useAuth();
  const hasStaffAccess = !!user && accessStatus === "authenticated" && assignedRoles.length > 0;
  const params = new URLSearchParams();
  if (opts?.unreadOnly) params.set("unreadOnly", "true");
  if (opts?.limit) params.set("limit", String(opts.limit));

  return useQuery<NotificationItem[]>({
    queryKey: ["/api/notifications", opts?.unreadOnly, opts?.limit],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/notifications?${params}`, { signal });
      if (!res.ok) throw new Error("Failed to fetch notifications");
      return res.json();
    },
    enabled: hasStaffAccess,
  });
}

/**
 * Mark a single notification as read.
 */
export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/notifications/${id}/read`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to mark as read");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
    },
  });
}

/**
 * Mark all notifications as read.
 */
export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/notifications/read-all", { method: "POST" });
      if (!res.ok) throw new Error("Failed to mark all as read");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
    },
  });
}

/**
 * Hook for notification preferences.
 */
export function useNotificationPreferences() {
  const { user, assignedRoles, accessStatus } = useAuth();
  const hasStaffAccess = !!user && accessStatus === "authenticated" && assignedRoles.length > 0;
  return useQuery<NotificationPreference[]>({
    queryKey: ["/api/notification-preferences"],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/notification-preferences", { signal });
      if (!res.ok) throw new Error("Failed to fetch preferences");
      return res.json();
    },
    enabled: hasStaffAccess,
  });
}

/**
 * Set a notification preference override.
 */
export function useSetPreference() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ typeId, enabled }: { typeId: number; enabled: boolean }) => {
      const res = await fetch(`/api/notification-preferences/${typeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error("Failed to update preference");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notification-preferences"] });
    },
  });
}

/**
 * Reset preferences to role defaults.
 */
export function useResetPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/notification-preferences", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to reset preferences");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notification-preferences"] });
    },
  });
}
