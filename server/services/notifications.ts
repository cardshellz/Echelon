import { db } from "../db";
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import {
  notifications,
  notificationTypes,
  notificationPreferences,
  users,
  authUserRoles,
  type Notification,
  type NotificationType,
  type NotificationPreference,
} from "@shared/schema";
import { broadcastToUser } from "../websocket";

/**
 * Send a notification to all users whose preferences (role default or user override) enable it.
 */
export async function notify(
  typeKey: string,
  payload: { title: string; message?: string; data?: Record<string, unknown> }
) {
  // Look up the notification type
  const [nt] = await db
    .select()
    .from(notificationTypes)
    .where(eq(notificationTypes.key, typeKey))
    .limit(1);

  if (!nt) {
    console.warn(`[Notifications] Unknown notification type: ${typeKey}`);
    return;
  }

  // Get all active users with their role assignments
  const activeUsers = await db
    .select({
      userId: users.id,
      roleId: authUserRoles.roleId,
    })
    .from(users)
    .leftJoin(authUserRoles, eq(authUserRoles.userId, users.id))
    .where(eq(users.active, 1));

  // Get all preferences for this notification type
  const allPrefs = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.notificationTypeId, nt.id));

  // Index preferences for fast lookup
  const userPrefs = new Map<string, NotificationPreference>();
  const rolePrefs = new Map<number, NotificationPreference>();
  for (const pref of allPrefs) {
    if (pref.userId) {
      userPrefs.set(pref.userId, pref);
    } else if (pref.roleId) {
      rolePrefs.set(pref.roleId, pref);
    }
  }

  // Determine recipients
  const recipients: string[] = [];
  const seen = new Set<string>();

  for (const row of activeUsers) {
    if (seen.has(row.userId)) continue;
    seen.add(row.userId);

    // Check user-level override first
    const userPref = userPrefs.get(row.userId);
    if (userPref) {
      if (userPref.enabled === 1) recipients.push(row.userId);
      continue;
    }

    // Fall back to role default
    if (row.roleId) {
      const rolePref = rolePrefs.get(row.roleId);
      if (rolePref && rolePref.enabled === 1) {
        recipients.push(row.userId);
      }
    }
    // No preference at all → default off
  }

  if (recipients.length === 0) return;

  // Batch insert notifications
  const rows = recipients.map((userId) => ({
    userId,
    notificationTypeId: nt.id,
    title: payload.title,
    message: payload.message ?? null,
    data: payload.data ?? null,
  }));

  const inserted = await db.insert(notifications).values(rows).returning();

  // Push real-time via WebSocket
  for (const n of inserted) {
    broadcastToUser(n.userId, {
      type: "notification",
      notification: {
        id: n.id,
        title: n.title,
        message: n.message,
        data: n.data,
        category: nt.category,
        typeKey: nt.key,
        createdAt: n.createdAt,
      },
    });
  }

  console.log(
    `[Notifications] Sent "${typeKey}" to ${recipients.length} user(s)`
  );
}

/**
 * Get notifications for a user (newest first).
 */
export async function getUserNotifications(
  userId: string,
  opts: { unreadOnly?: boolean; limit?: number; offset?: number } = {}
) {
  const conditions = [eq(notifications.userId, userId)];
  if (opts.unreadOnly) {
    conditions.push(eq(notifications.read, 0));
  }

  const rows = await db
    .select({
      id: notifications.id,
      title: notifications.title,
      message: notifications.message,
      data: notifications.data,
      read: notifications.read,
      createdAt: notifications.createdAt,
      typeKey: notificationTypes.key,
      category: notificationTypes.category,
      typeLabel: notificationTypes.label,
    })
    .from(notifications)
    .innerJoin(
      notificationTypes,
      eq(notifications.notificationTypeId, notificationTypes.id)
    )
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);

  return rows;
}

/**
 * Get unread notification count for badge.
 */
export async function getUnreadCount(userId: string): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.read, 0)));

  return result?.count ?? 0;
}

/**
 * Mark a single notification as read.
 */
export async function markRead(notificationId: number, userId: string) {
  await db
    .update(notifications)
    .set({ read: 1 })
    .where(
      and(eq(notifications.id, notificationId), eq(notifications.userId, userId))
    );
}

/**
 * Mark all notifications as read for a user.
 */
export async function markAllRead(userId: string) {
  await db
    .update(notifications)
    .set({ read: 1 })
    .where(and(eq(notifications.userId, userId), eq(notifications.read, 0)));
}

/**
 * Get merged preferences for a user: user overrides take priority over role defaults.
 */
export async function getPreferencesForUser(userId: string) {
  // Get all notification types
  const types = await db.select().from(notificationTypes).orderBy(notificationTypes.category, notificationTypes.label);

  // Get user's role IDs
  const userRoles = await db
    .select({ roleId: authUserRoles.roleId })
    .from(authUserRoles)
    .where(eq(authUserRoles.userId, userId));
  const roleIds = userRoles.map((r) => r.roleId);

  // Get all relevant preferences
  const allPrefs = await db.select().from(notificationPreferences);

  // Build merged view
  return types.map((nt) => {
    // Check for user override
    const userPref = allPrefs.find(
      (p) => p.notificationTypeId === nt.id && p.userId === userId
    );
    if (userPref) {
      return {
        ...nt,
        enabled: userPref.enabled === 1,
        isOverride: true,
      };
    }

    // Check role defaults (enabled if ANY of user's roles has it enabled)
    const rolePref = allPrefs.find(
      (p) =>
        p.notificationTypeId === nt.id &&
        p.userId === null &&
        p.roleId !== null &&
        roleIds.includes(p.roleId) &&
        p.enabled === 1
    );

    return {
      ...nt,
      enabled: !!rolePref,
      isOverride: false,
    };
  });
}

/**
 * Set a user-specific preference override.
 */
export async function setUserPreference(
  userId: string,
  notificationTypeId: number,
  enabled: boolean
) {
  // Upsert: insert or update
  const existing = await db
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.notificationTypeId, notificationTypeId),
        eq(notificationPreferences.userId, userId),
        isNull(notificationPreferences.roleId)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(notificationPreferences)
      .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
      .where(eq(notificationPreferences.id, existing[0].id));
  } else {
    await db.insert(notificationPreferences).values({
      notificationTypeId,
      roleId: null,
      userId,
      enabled: enabled ? 1 : 0,
    });
  }
}

/**
 * Reset a user's overrides back to role defaults (delete user-level prefs).
 */
export async function resetUserPreferences(userId: string) {
  await db
    .delete(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));
}
