import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { useEffect, useRef } from "react";

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
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);

  const query = useQuery<{ count: number }>({
    queryKey: ["/api/notifications/unread-count"],
    queryFn: async () => {
      const res = await fetch("/api/notifications/unread-count");
      if (!res.ok) throw new Error("Failed to fetch unread count");
      return res.json();
    },
    refetchInterval: 30_000,
    enabled: !!user,
  });

  // WebSocket connection for real-time pushes
  useEffect(() => {
    if (!user) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      // Authenticate the connection
      ws.send(JSON.stringify({ type: "auth", userId: user.id }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "notification") {
          // Invalidate both count and list
          queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
          queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
        }
      } catch {}
    };

    ws.onerror = () => {};
    ws.onclose = () => {};

    wsRef.current = ws;

    return () => {
      ws.close();
    };
  }, [user?.id, queryClient]);

  return query.data?.count ?? 0;
}

/**
 * Hook for the notification list.
 */
export function useNotifications(opts?: { unreadOnly?: boolean; limit?: number }) {
  const { user } = useAuth();
  const params = new URLSearchParams();
  if (opts?.unreadOnly) params.set("unreadOnly", "true");
  if (opts?.limit) params.set("limit", String(opts.limit));

  return useQuery<NotificationItem[]>({
    queryKey: ["/api/notifications", opts?.unreadOnly, opts?.limit],
    queryFn: async () => {
      const res = await fetch(`/api/notifications?${params}`);
      if (!res.ok) throw new Error("Failed to fetch notifications");
      return res.json();
    },
    enabled: !!user,
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
  const { user } = useAuth();
  return useQuery<NotificationPreference[]>({
    queryKey: ["/api/notification-preferences"],
    queryFn: async () => {
      const res = await fetch("/api/notification-preferences");
      if (!res.ok) throw new Error("Failed to fetch preferences");
      return res.json();
    },
    enabled: !!user,
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
