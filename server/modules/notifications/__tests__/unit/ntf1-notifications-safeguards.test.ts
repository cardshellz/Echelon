import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationPreference } from "@shared/schema";

const mocks = vi.hoisted(() => ({
  broadcastToUser: vi.fn(),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("../../../../db", () => ({ db: mocks.db }));
vi.mock("../../../../websocket", () => ({ broadcastToUser: mocks.broadcastToUser }));

import {
  getPreferencesForUser,
  getUserNotifications,
  normalizeNotificationPageOptions,
  NotificationPreferenceInputError,
  notify,
  pickCanonicalPreferenceRow,
  resetUserPreferences,
  resolveEffectiveNotificationPreference,
  resolveNotificationRecipients,
  setUserPreference,
} from "../../notifications.service";

function makePref(overrides: Partial<NotificationPreference> & { id: number; notificationTypeId: number }): NotificationPreference {
  return {
    id: overrides.id,
    notificationTypeId: overrides.notificationTypeId,
    roleId: overrides.roleId ?? null,
    userId: overrides.userId ?? null,
    enabled: overrides.enabled ?? 1,
    createdAt: overrides.createdAt ?? new Date("2026-11-01T00:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-11-01T00:00:00Z"),
  };
}

describe("NTF-1 Priority 14 Notifications safeguards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("PLAT-02: canonical multi-role preference resolution", () => {
    it("resolves identical recipients regardless of joined role row order", () => {
      const prefs: NotificationPreference[] = [
        makePref({ id: 1, notificationTypeId: 10, roleId: 100, enabled: 0 }), // role 100 disabled
        makePref({ id: 2, notificationTypeId: 10, roleId: 200, enabled: 1 }), // role 200 enabled
      ];

      const disabledFirst = [
        { userId: "multi-role-user", roleId: 100 },
        { userId: "multi-role-user", roleId: 200 },
      ];
      const enabledFirst = [
        { userId: "multi-role-user", roleId: 200 },
        { userId: "multi-role-user", roleId: 100 },
      ];

      expect(resolveNotificationRecipients(disabledFirst, prefs)).toEqual(["multi-role-user"]);
      expect(resolveNotificationRecipients(enabledFirst, prefs)).toEqual(["multi-role-user"]);
    });

    it("honors explicit user false/true overrides over role defaults and defaults to off", () => {
      const prefs: NotificationPreference[] = [
        makePref({ id: 1, notificationTypeId: 10, roleId: 200, enabled: 1 }),
        makePref({ id: 2, notificationTypeId: 10, userId: "opted-out", enabled: 0 }),
        makePref({ id: 3, notificationTypeId: 10, userId: "opted-in", enabled: 1 }),
      ];

      const rows = [
        { userId: "opted-out", roleId: 200 },
        { userId: "opted-in", roleId: null },
        { userId: "no-roles", roleId: null },
      ];

      expect(resolveNotificationRecipients(rows, prefs)).toEqual(["opted-in"]);
      expect(
        resolveEffectiveNotificationPreference({
          userOverrideEnabled: false,
          roleIds: [200],
          enabledRoleIds: new Set([200]),
        }),
      ).toEqual({ enabled: false, isOverride: true });
    });

    it("picks the newest updatedAt (then highest id) when legacy duplicate preference rows exist", () => {
      const older = makePref({
        id: 5,
        notificationTypeId: 10,
        userId: "u1",
        enabled: 1,
        updatedAt: new Date("2026-11-01T00:00:00Z"),
      });
      const newerDisabled = makePref({
        id: 4,
        notificationTypeId: 10,
        userId: "u1",
        enabled: 0,
        updatedAt: new Date("2026-11-02T00:00:00Z"),
      });

      expect(pickCanonicalPreferenceRow([older, newerDisabled])?.id).toBe(4);
      expect(pickCanonicalPreferenceRow([newerDisabled, older])?.id).toBe(4);
      expect(resolveNotificationRecipients([{ userId: "u1", roleId: null }], [older, newerDisabled])).toEqual([]);
      expect(resolveNotificationRecipients([{ userId: "u1", roleId: null }], [newerDisabled, older])).toEqual([]);
    });

    it("agrees 100% between getPreferencesForUser() and notify() across role permutations", async () => {
      const nt = {
        id: 10,
        key: "po_exception",
        label: "PO Exception",
        description: null,
        category: "procurement",
        createdAt: new Date("2026-11-01T00:00:00Z"),
      };
      const prefs: NotificationPreference[] = [
        makePref({ id: 1, notificationTypeId: 10, roleId: 100, enabled: 0 }),
        makePref({ id: 2, notificationTypeId: 10, roleId: 200, enabled: 1 }),
      ];

      // 1) getPreferencesForUser("u-multi") with roles [100, 200]
      mocks.db.select
        .mockReturnValueOnce({
          from: () => ({ orderBy: vi.fn().mockResolvedValue([nt]) }),
        })
        .mockReturnValueOnce({
          from: () => ({ where: vi.fn().mockResolvedValue([{ roleId: 100 }, { roleId: 200 }]) }),
        })
        .mockReturnValueOnce({
          from: () => ({ where: vi.fn().mockResolvedValue(prefs) }),
        });

      const displayed = await getPreferencesForUser("u-multi");
      expect(displayed).toEqual([
        expect.objectContaining({ id: 10, enabled: true, isOverride: false }),
      ]);

      // 2) notify("po_exception", ...) when SQL join returns disabled role 100 FIRST
      const insertValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: 77,
            userId: "u-multi",
            notificationTypeId: 10,
            title: "Alert",
            message: null,
            data: null,
            read: 0,
            createdAt: new Date("2026-11-12T00:00:00Z"),
          },
        ]),
      });
      mocks.db.insert.mockReturnValueOnce({ values: insertValues });
      mocks.db.select
        .mockReturnValueOnce({
          from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([nt]) }) }),
        })
        .mockReturnValueOnce({
          from: () => ({
            leftJoin: () => ({
              where: vi.fn().mockResolvedValue([
                { userId: "u-multi", roleId: 100 },
                { userId: "u-multi", roleId: 200 },
              ]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({ where: vi.fn().mockResolvedValue(prefs) }),
        });

      await notify("po_exception", { title: "Alert" });
      expect(insertValues).toHaveBeenCalledWith([
        expect.objectContaining({ userId: "u-multi", notificationTypeId: 10, title: "Alert" }),
      ]);
    });
  });

  describe("PLAT-03: serialized preference upsert & duplicate self-healing", () => {
    it("acquires per-user transactional advisory lock, updates canonical row, and deletes legacy duplicates", async () => {
      const executeCalls: unknown[] = [];
      const updatedRows: Array<{ setArg: unknown }> = [];
      const deletedCalls: number[] = [];

      const existingDuplicates: NotificationPreference[] = [
        makePref({
          id: 91,
          notificationTypeId: 7,
          userId: "user-a",
          enabled: 0,
          updatedAt: new Date("2026-11-10T00:00:00Z"),
        }),
        makePref({
          id: 84,
          notificationTypeId: 7,
          userId: "user-a",
          enabled: 1,
          updatedAt: new Date("2026-11-05T00:00:00Z"),
        }),
      ];

      mocks.db.transaction.mockImplementationOnce(async (callback: (tx: any) => Promise<void>) => {
        const tx = {
          execute: vi.fn(async (query: unknown) => {
            executeCalls.push(query);
          }),
          select: vi.fn()
            .mockReturnValueOnce({
              from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([{ id: 7 }]) }) }),
            })
            .mockReturnValueOnce({
              from: () => ({
                where: () => ({ orderBy: vi.fn().mockResolvedValue(existingDuplicates) }),
              }),
            }),
          update: vi.fn(() => ({
            set: (setArg: unknown) => {
              updatedRows.push({ setArg });
              return { where: vi.fn().mockResolvedValue(undefined) };
            },
          })),
          delete: vi.fn(() => ({
            where: vi.fn(async () => {
              deletedCalls.push(1);
            }),
          })),
          insert: vi.fn(),
        };
        await callback(tx);
      });

      await setUserPreference("user-a", 7, true);

      expect(executeCalls).toHaveLength(1);
      expect(updatedRows).toHaveLength(1);
      expect(updatedRows[0].setArg).toMatchObject({ enabled: 1 });
      expect(deletedCalls).toHaveLength(1);
    });

    it("rejects unknown notification type inside transaction with 404 NotificationPreferenceInputError", async () => {
      mocks.db.transaction.mockImplementationOnce(async (callback: (tx: any) => Promise<void>) => {
        const tx = {
          execute: vi.fn().mockResolvedValue(undefined),
          select: vi.fn().mockReturnValueOnce({
            from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([]) }) }),
          }),
        };
        await callback(tx);
      });

      const expectedError: Partial<NotificationPreferenceInputError> = {
        statusCode: 404,
        code: "NOTIFICATION_TYPE_NOT_FOUND",
      };
      await expect(setUserPreference("user-a", 9999, false)).rejects.toMatchObject(expectedError);
    });

    it("serializes resetUserPreferences under the same transactional advisory lock", async () => {
      const execute = vi.fn().mockResolvedValue(undefined);
      const deleteWhere = vi.fn().mockResolvedValue(undefined);

      mocks.db.transaction.mockImplementationOnce(async (callback: (tx: any) => Promise<void>) => {
        await callback({
          execute,
          delete: () => ({ where: deleteWhere }),
        });
      });

      await resetUserPreferences("user-a");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(deleteWhere).toHaveBeenCalledTimes(1);
    });
  });

  describe("PW-02: dedupeKey suppression, WebSocket fault isolation, and pagination clamping", () => {
    it("isolates WebSocket broadcast exceptions after durable notification insert and suppresses dedupeKey duplicates", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const nt = {
          id: 12,
          key: "replenishment_failed",
          label: "Replenishment Failed",
          description: null,
          category: "replenishment",
          createdAt: new Date("2026-11-01T00:00:00Z"),
        };

        mocks.db.select
          .mockReturnValueOnce({
            from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([nt]) }) }),
          })
          .mockReturnValueOnce({
            from: () => ({
              leftJoin: () => ({
                where: vi.fn().mockResolvedValue([
                  { userId: "already-notified", roleId: 1 },
                  { userId: "ws-throws-user", roleId: 1 },
                  { userId: "ws-ok-user", roleId: 1 },
                ]),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: () => ({
              where: vi.fn().mockResolvedValue([makePref({ id: 1, notificationTypeId: 12, roleId: 1, enabled: 1 })]),
            }),
          })
          .mockReturnValueOnce({
            from: () => ({
              where: vi.fn().mockResolvedValue([{ userId: "already-notified" }]),
            }),
          });

        const insertValues = vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            {
              id: 501,
              userId: "ws-throws-user",
              notificationTypeId: 12,
              title: "Replen failed",
              message: null,
              data: { taskId: 9, dedupeKey: "replen:9" },
              read: 0,
              createdAt: new Date("2026-11-12T00:00:00Z"),
            },
            {
              id: 502,
              userId: "ws-ok-user",
              notificationTypeId: 12,
              title: "Replen failed",
              message: null,
              data: { taskId: 9, dedupeKey: "replen:9" },
              read: 0,
              createdAt: new Date("2026-11-12T00:00:00Z"),
            },
          ]),
        });
        mocks.db.insert.mockReturnValueOnce({ values: insertValues });

        mocks.broadcastToUser
          .mockImplementationOnce(() => {
            throw new Error("socket closed mid-frame");
          })
          .mockImplementationOnce(() => {});

        await expect(
          notify("replenishment_failed", {
            title: "Replen failed",
            data: { taskId: 9 },
            dedupeKey: "replen:9",
            dedupeWindowSeconds: 600,
          }),
        ).resolves.toBeUndefined();

        expect(insertValues).toHaveBeenCalledWith([
          expect.objectContaining({
            userId: "ws-throws-user",
            data: { taskId: 9, dedupeKey: "replen:9" },
          }),
          expect.objectContaining({
            userId: "ws-ok-user",
            data: { taskId: 9, dedupeKey: "replen:9" },
          }),
        ]);
        expect(mocks.broadcastToUser).toHaveBeenCalledTimes(2);
      } finally {
        warnSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    it("clamps notification pagination options and applies deterministic ordering", async () => {
      expect(normalizeNotificationPageOptions({ limit: -20, offset: -5 })).toEqual({
        unreadOnly: false,
        limit: 1,
        offset: 0,
      });
      expect(normalizeNotificationPageOptions({ unreadOnly: true, limit: 999, offset: 12 })).toEqual({
        unreadOnly: true,
        limit: 100,
        offset: 12,
      });

      const offsetFn = vi.fn().mockResolvedValue([]);
      const limitFn = vi.fn().mockReturnValue({ offset: offsetFn });
      const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
      mocks.db.select.mockReturnValueOnce({
        from: () => ({
          innerJoin: () => ({
            where: () => ({ orderBy: orderByFn }),
          }),
        }),
      });

      await getUserNotifications("user-1", { limit: -3, offset: -9 });
      expect(orderByFn).toHaveBeenCalledTimes(1);
      expect(orderByFn.mock.calls[0]).toHaveLength(2); // createdAt DESC, id DESC
      expect(limitFn).toHaveBeenCalledWith(1);
      expect(offsetFn).toHaveBeenCalledWith(0);
    });
  });

  describe("PLAT-10: zero reverse dependency from notifications to procurement", () => {
    it("keeps every source file in server/modules/notifications free of procurement imports", () => {
      const notificationsDir = resolve(process.cwd(), "server/modules/notifications");
      const sourceFiles = readdirSync(notificationsDir).filter((file) => file.endsWith(".ts"));
      expect(sourceFiles.length).toBeGreaterThan(0);

      for (const file of sourceFiles) {
        const content = readFileSync(resolve(notificationsDir, file), "utf8");
        expect(content, `${file} must not import from procurement`).not.toMatch(/procurement/);
      }
    });
  });
});
