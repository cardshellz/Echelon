import { db } from "../../db";
import { eq, and, desc, gte, inArray, isNull, or, sql } from "drizzle-orm";
import {
  notifications,
  notificationTypes,
  notificationPreferences,
  users,
  authUserRoles,
  type NotificationType,
  type NotificationPreference,
} from "@shared/schema";
import { broadcastToUser } from "../../websocket";

const NOTIFICATION_PREFS_ADVISORY_LOCK_NAMESPACE = 918_440;
const DEFAULT_DEDUPE_WINDOW_SECONDS = 300;
const MAX_DEDUPE_WINDOW_SECONDS = 86_400;

export class NotificationPreferenceInputError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "NotificationPreferenceInputError";
  }
}

export interface NotifyPayload {
  title: string;
  message?: string;
  data?: Record<string, unknown>;
  dedupeKey?: string;
  dedupeWindowSeconds?: number;
}

/**
 * Deterministically picks the canonical preference row when legacy duplicate rows exist
 * for the same `(notificationTypeId, userId)` or `(notificationTypeId, roleId)`.
 * Chooses the row with the latest `updatedAt` timestamp and highest `id` tie-breaker.
 */
export function pickCanonicalPreferenceRow<
  T extends { id: number; updatedAt?: Date | string | null },
>(rows: readonly T[]): T | undefined {
  if (rows.length === 0) return undefined;
  let best = rows[0];
  let bestUpdatedMs = toTimestampMs(best.updatedAt);
  for (let index = 1; index < rows.length; index += 1) {
    const candidate = rows[index];
    const candidateMs = toTimestampMs(candidate.updatedAt);
    if (candidateMs > bestUpdatedMs || (candidateMs === bestUpdatedMs && candidate.id > best.id)) {
      best = candidate;
      bestUpdatedMs = candidateMs;
    }
  }
  return best;
}

function toTimestampMs(value: Date | string | null | undefined): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

/**
 * Single canonical preference resolver shared by `notify()` and `getPreferencesForUser()`.
 * - Explicit user override (`true` or `false`) always takes precedence over role defaults.
 * - Otherwise, enabled when ANY assigned role has an enabled default.
 * - Otherwise, disabled (`false`).
 */
export function resolveEffectiveNotificationPreference(input: {
  userOverrideEnabled: boolean | null;
  roleIds: Iterable<number>;
  enabledRoleIds: ReadonlySet<number>;
}): { enabled: boolean; isOverride: boolean } {
  if (input.userOverrideEnabled !== null) {
    return {
      enabled: input.userOverrideEnabled,
      isOverride: true,
    };
  }
  for (const roleId of input.roleIds) {
    if (input.enabledRoleIds.has(roleId)) {
      return {
        enabled: true,
        isOverride: false,
      };
    }
  }
  return {
    enabled: false,
    isOverride: false,
  };
}

/**
 * Clamp pagination options to safe bounded integers (`limit: 1..100`, `offset: >= 0`).
 */
export function normalizeNotificationPageOptions(opts?: {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}): { unreadOnly: boolean; limit: number; offset: number } {
  const rawLimit = opts?.limit;
  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100)
      : 50;
  const rawOffset = opts?.offset;
  const offset =
    typeof rawOffset === "number" && Number.isFinite(rawOffset)
      ? Math.max(Math.trunc(rawOffset), 0)
      : 0;
  return {
    unreadOnly: Boolean(opts?.unreadOnly),
    limit,
    offset,
  };
}

function buildPreferenceIndexesForType(allPrefs: readonly NotificationPreference[]): {
  userOverrides: Map<string, boolean>;
  enabledRoleIds: Set<number>;
} {
  const userRows = new Map<string, NotificationPreference[]>();
  const roleRows = new Map<number, NotificationPreference[]>();

  for (const pref of allPrefs) {
    if (pref.userId && pref.roleId === null) {
      const bucket = userRows.get(pref.userId) ?? [];
      bucket.push(pref);
      userRows.set(pref.userId, bucket);
    } else if (pref.roleId !== null && pref.userId === null) {
      const bucket = roleRows.get(pref.roleId) ?? [];
      bucket.push(pref);
      roleRows.set(pref.roleId, bucket);
    }
  }

  const userOverrides = new Map<string, boolean>();
  for (const [userId, rows] of userRows.entries()) {
    const canonical = pickCanonicalPreferenceRow(rows);
    if (canonical) {
      userOverrides.set(userId, canonical.enabled === 1);
    }
  }

  const enabledRoleIds = new Set<number>();
  for (const [roleId, rows] of roleRows.entries()) {
    const canonical = pickCanonicalPreferenceRow(rows);
    if (canonical && canonical.enabled === 1) {
      enabledRoleIds.add(roleId);
    }
  }

  return { userOverrides, enabledRoleIds };
}

/**
 * Resolve recipient user IDs from active user-role join rows and preference rows
 * without depending on SQL join row order (`PLAT-02`).
 */
export function resolveNotificationRecipients(
  activeUserRoleRows: readonly { userId: string; roleId: number | null }[],
  allPrefsForType: readonly NotificationPreference[],
): string[] {
  const rolesByUser = new Map<string, Set<number>>();
  for (const row of activeUserRoleRows) {
    let roleSet = rolesByUser.get(row.userId);
    if (!roleSet) {
      roleSet = new Set<number>();
      rolesByUser.set(row.userId, roleSet);
    }
    if (typeof row.roleId === "number") {
      roleSet.add(row.roleId);
    }
  }

  const { userOverrides, enabledRoleIds } = buildPreferenceIndexesForType(allPrefsForType);
  const recipients: string[] = [];

  for (const [userId, roleIds] of rolesByUser.entries()) {
    const decision = resolveEffectiveNotificationPreference({
      userOverrideEnabled: userOverrides.has(userId) ? userOverrides.get(userId)! : null,
      roleIds,
      enabledRoleIds,
    });
    if (decision.enabled) {
      recipients.push(userId);
    }
  }

  return recipients;
}

/**
 * Send a notification to all users whose preferences (role default or user override) enable it.
 */
export async function notify(
  typeKey: string,
  payload: NotifyPayload,
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

  let recipients = resolveNotificationRecipients(activeUsers, allPrefs);
  if (recipients.length === 0) return;

  const trimmedDedupeKey = payload.dedupeKey?.trim() || null;
  if (trimmedDedupeKey) {
    const rawWindow = payload.dedupeWindowSeconds ?? DEFAULT_DEDUPE_WINDOW_SECONDS;
    const windowSeconds =
      typeof rawWindow === "number" && Number.isFinite(rawWindow)
        ? Math.min(Math.max(Math.trunc(rawWindow), 1), MAX_DEDUPE_WINDOW_SECONDS)
        : DEFAULT_DEDUPE_WINDOW_SECONDS;
    const cutoff = new Date(Date.now() - windowSeconds * 1_000);
    const recentDuplicates = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(
        and(
          eq(notifications.notificationTypeId, nt.id),
          inArray(notifications.userId, recipients),
          gte(notifications.createdAt, cutoff),
          sql`${notifications.data}->>'dedupeKey' = ${trimmedDedupeKey}`,
        ),
      );
    const suppressedUsers = new Set(recentDuplicates.map((row) => row.userId));
    recipients = recipients.filter((userId) => !suppressedUsers.has(userId));
    if (recipients.length === 0) return;
  }

  const persistedData =
    trimmedDedupeKey !== null
      ? { ...(payload.data ?? {}), dedupeKey: trimmedDedupeKey }
      : payload.data ?? null;

  // Batch insert notifications
  const rows = recipients.map((userId) => ({
    userId,
    notificationTypeId: nt.id,
    title: payload.title,
    message: payload.message ?? null,
    data: persistedData,
  }));

  const inserted = await db.insert(notifications).values(rows).returning();

  // Push real-time hint via WebSocket — transport errors must never fail durable persistence
  for (const n of inserted) {
    try {
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
    } catch (wsError) {
      console.warn(`[Notifications] WebSocket hint failed for user ${n.userId}`, wsError);
    }
  }

  console.log(
    `[Notifications] Sent "${typeKey}" to ${recipients.length} user(s)`
  );
}

/**
 * Get notifications for a user (newest first with deterministic id tie-breaker).
 */
export async function getUserNotifications(
  userId: string,
  opts: { unreadOnly?: boolean; limit?: number; offset?: number } = {}
) {
  const normalized = normalizeNotificationPageOptions(opts);
  const conditions = [eq(notifications.userId, userId)];
  if (normalized.unreadOnly) {
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
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(normalized.limit)
    .offset(normalized.offset);

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
 * Uses the exact same canonical resolver as `notify()` (`PLAT-02`).
 */
export async function getPreferencesForUser(userId: string) {
  const types = await db
    .select()
    .from(notificationTypes)
    .orderBy(notificationTypes.category, notificationTypes.label);

  const userRoles = await db
    .select({ roleId: authUserRoles.roleId })
    .from(authUserRoles)
    .where(eq(authUserRoles.userId, userId));
  const roleIds = userRoles.map((r) => r.roleId);

  const prefFilter =
    roleIds.length > 0
      ? or(
          and(eq(notificationPreferences.userId, userId), isNull(notificationPreferences.roleId)),
          and(isNull(notificationPreferences.userId), inArray(notificationPreferences.roleId, roleIds)),
        )
      : and(eq(notificationPreferences.userId, userId), isNull(notificationPreferences.roleId));

  const relevantPrefs = await db
    .select()
    .from(notificationPreferences)
    .where(prefFilter);

  const prefsByType = new Map<number, NotificationPreference[]>();
  for (const pref of relevantPrefs) {
    const bucket = prefsByType.get(pref.notificationTypeId) ?? [];
    bucket.push(pref);
    prefsByType.set(pref.notificationTypeId, bucket);
  }

  return types.map((nt) => {
    const typePrefs = prefsByType.get(nt.id) ?? [];
    const { userOverrides, enabledRoleIds } = buildPreferenceIndexesForType(typePrefs);
    const decision = resolveEffectiveNotificationPreference({
      userOverrideEnabled: userOverrides.has(userId) ? userOverrides.get(userId)! : null,
      roleIds,
      enabledRoleIds,
    });

    return {
      ...nt,
      enabled: decision.enabled,
      isOverride: decision.isOverride,
    };
  });
}

/**
 * Set a user-specific preference override atomically under a per-user transactional
 * advisory lock (`PLAT-03`), deduplicating any legacy duplicate user-override rows.
 */
export async function setUserPreference(
  userId: string,
  notificationTypeId: number,
  enabled: boolean
) {
  if (!Number.isSafeInteger(notificationTypeId) || notificationTypeId <= 0 || notificationTypeId > 2_147_483_647) {
    throw new NotificationPreferenceInputError(
      "Valid notification type id is required",
      400,
      "INVALID_NOTIFICATION_TYPE_ID",
    );
  }

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${NOTIFICATION_PREFS_ADVISORY_LOCK_NAMESPACE}, hashtext(${userId}))`,
    );

    const [typeExists] = await tx
      .select({ id: notificationTypes.id })
      .from(notificationTypes)
      .where(eq(notificationTypes.id, notificationTypeId))
      .limit(1);

    if (!typeExists) {
      throw new NotificationPreferenceInputError(
        "Notification type not found",
        404,
        "NOTIFICATION_TYPE_NOT_FOUND",
      );
    }

    const existing = await tx
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.notificationTypeId, notificationTypeId),
          eq(notificationPreferences.userId, userId),
          isNull(notificationPreferences.roleId),
        ),
      )
      .orderBy(desc(notificationPreferences.updatedAt), desc(notificationPreferences.id));

    const now = new Date();
    const encodedEnabled = enabled ? 1 : 0;

    if (existing.length > 0) {
      const canonical = pickCanonicalPreferenceRow(existing)!;
      await tx
        .update(notificationPreferences)
        .set({ enabled: encodedEnabled, updatedAt: now })
        .where(eq(notificationPreferences.id, canonical.id));

      const duplicateIds = existing
        .filter((row) => row.id !== canonical.id)
        .map((row) => row.id);
      if (duplicateIds.length > 0) {
        await tx
          .delete(notificationPreferences)
          .where(inArray(notificationPreferences.id, duplicateIds));
      }
    } else {
      await tx.insert(notificationPreferences).values({
        notificationTypeId,
        roleId: null,
        userId,
        enabled: encodedEnabled,
        updatedAt: now,
      });
    }
  });
}

/**
 * Reset a user's overrides back to role defaults atomically under the same per-user
 * transactional advisory lock (`PLAT-03`).
 */
export async function resetUserPreferences(userId: string) {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${NOTIFICATION_PREFS_ADVISORY_LOCK_NAMESPACE}, hashtext(${userId}))`,
    );
    await tx
      .delete(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, userId),
          isNull(notificationPreferences.roleId),
        ),
      );
  });
}

/**
 * List all notification types (for admin settings).
 */
export async function getAllNotificationTypes(): Promise<NotificationType[]> {
  return await db.select().from(notificationTypes).orderBy(notificationTypes.category, notificationTypes.label);
}
