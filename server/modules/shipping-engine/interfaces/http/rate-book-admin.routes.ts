/**
 * Pricing-program (rate book) administration.
 *
 * A program is created active with a stable machine code derived from its
 * name; "Used by" assignments are replace-all per book, with cross-book
 * conflicts rejected by the partial unique indexes on rate_book_assignments
 * and surfaced as actionable 409s. Retiring a program deactivates its
 * assignments in the same transaction so the affected channels stop
 * resolving rates immediately and deliberately.
 */

import type { Express, Response } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  shippingRateBookAssignments,
  shippingRateBooks,
  shippingRateTables,
  shippingZoneSets,
  warehouses,
} from "@shared/schema";
import { db } from "../../../../db";
import { requirePermission } from "../../../../routes/middleware";
import {
  findDuplicateAssignments,
  slugifyRateBookCode,
} from "../../domain/rate-book-admin";

const assignmentSchema = z.object({
  pricingChannel: z.string().trim().min(1).max(40).toLowerCase(),
  ratePurpose: z.string().trim().min(1).max(60).toLowerCase(),
  originWarehouseId: z.number().int().positive().nullable().default(null),
});

const createRateBookSchema = z.object({
  name: z.string().trim().min(1).max(160),
  assignments: z.array(assignmentSchema).max(20).default([]),
});

const updateRateBookSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  // Omitted = leave assignments unchanged; [] = deliberately clear them.
  assignments: z.array(assignmentSchema).max(20).optional(),
});

const bookIdSchema = z.coerce.number().int().positive();

type AssignmentInput = z.infer<typeof assignmentSchema>;

export function registerRateBookAdminRoutes(app: Express): void {
  app.post(
    "/api/shipping/admin/rate-books",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const parsed = createRateBookSchema.safeParse(req.body);
        if (!parsed.success) return sendInvalidInput(res, parsed.error.issues);
        const code = slugifyRateBookCode(parsed.data.name);
        if (code.length === 0) {
          throw new RateBookAdminError(
            400,
            "SHIPPING_ADMIN_RATE_BOOK_NAME_INVALID",
            "The program name must contain at least one letter or number.",
          );
        }
        assertNoDuplicateAssignments(parsed.data.assignments);
        await validateAssignmentWarehouses(parsed.data.assignments);

        const [existing] = await db.select({ id: shippingRateBooks.id })
          .from(shippingRateBooks)
          .where(eq(shippingRateBooks.code, code))
          .limit(1);
        if (existing) {
          throw new RateBookAdminError(
            409,
            "SHIPPING_ADMIN_RATE_BOOK_CODE_TAKEN",
            `A pricing program named "${parsed.data.name}" already exists. Choose a different name.`,
          );
        }

        // Rate books still carry a zone-set reference for transit
        // observability; operators never manage zones (migration 139), so a
        // new program silently reuses the active default zone set.
        const [zoneSet] = await db.select({ id: shippingZoneSets.id })
          .from(shippingZoneSets)
          .where(eq(shippingZoneSets.status, "active"))
          .orderBy(asc(shippingZoneSets.id))
          .limit(1);
        if (!zoneSet) {
          throw new RateBookAdminError(
            409,
            "SHIPPING_ADMIN_ZONE_SET_MISSING",
            "No active zone set exists to attach the program to. Run the shipping migrations first.",
          );
        }

        const created = await db.transaction(async (tx) => {
          const [book] = await tx.insert(shippingRateBooks).values({
            code,
            name: parsed.data.name,
            zoneSetId: zoneSet.id,
            status: "active",
            metadata: { source: "admin-ui", createdVia: "pricing-programs" },
          }).returning();
          if (parsed.data.assignments.length > 0) {
            await tx.insert(shippingRateBookAssignments).values(
              parsed.data.assignments.map((assignment) => ({
                rateBookId: book.id,
                pricingChannel: assignment.pricingChannel,
                ratePurpose: assignment.ratePurpose,
                originWarehouseId: assignment.originWarehouseId,
                isActive: true,
              })),
            );
          }
          return book;
        });
        return res.status(201).json({ rateBook: created });
      } catch (error) {
        return sendRateBookAdminError(res, error, "create pricing program");
      }
    },
  );

  app.put(
    "/api/shipping/admin/rate-books/:id",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const id = parseBookId(req.params.id);
        const parsed = updateRateBookSchema.safeParse(req.body);
        if (!parsed.success) return sendInvalidInput(res, parsed.error.issues);
        if (parsed.data.assignments) {
          assertNoDuplicateAssignments(parsed.data.assignments);
          await validateAssignmentWarehouses(parsed.data.assignments);
        }

        const [current] = await db.select().from(shippingRateBooks)
          .where(eq(shippingRateBooks.id, id)).limit(1);
        if (!current) throw notFoundError();
        if (current.status === "retired") {
          throw new RateBookAdminError(
            409,
            "SHIPPING_ADMIN_RATE_BOOK_RETIRED",
            "A retired pricing program cannot be edited.",
          );
        }

        const updated = await db.transaction(async (tx) => {
          const [book] = parsed.data.name === undefined
            ? [current]
            : await tx.update(shippingRateBooks)
                .set({ name: parsed.data.name, updatedAt: new Date() })
                .where(eq(shippingRateBooks.id, id))
                .returning();
          if (parsed.data.assignments) {
            await tx.delete(shippingRateBookAssignments)
              .where(eq(shippingRateBookAssignments.rateBookId, id));
            if (parsed.data.assignments.length > 0) {
              await tx.insert(shippingRateBookAssignments).values(
                parsed.data.assignments.map((assignment) => ({
                  rateBookId: id,
                  pricingChannel: assignment.pricingChannel,
                  ratePurpose: assignment.ratePurpose,
                  originWarehouseId: assignment.originWarehouseId,
                  isActive: true,
                })),
              );
            }
          }
          return book;
        });
        return res.json({ rateBook: updated });
      } catch (error) {
        return sendRateBookAdminError(res, error, "update pricing program");
      }
    },
  );

  app.post(
    "/api/shipping/admin/rate-books/:id/retire",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const id = parseBookId(req.params.id);
        const [current] = await db.select({ status: shippingRateBooks.status })
          .from(shippingRateBooks).where(eq(shippingRateBooks.id, id)).limit(1);
        if (!current) throw notFoundError();
        if (current.status === "retired") {
          throw new RateBookAdminError(
            409,
            "SHIPPING_ADMIN_RATE_BOOK_RETIRED",
            "This pricing program is already retired.",
          );
        }

        const retired = await db.transaction(async (tx) => {
          const [book] = await tx.update(shippingRateBooks)
            .set({ status: "retired", updatedAt: new Date() })
            .where(and(eq(shippingRateBooks.id, id), eq(shippingRateBooks.status, current.status)))
            .returning();
          if (!book) return null;
          // Channels pointed at this program stop resolving rates now; the
          // active rate tables stay readable for history but are retired so
          // they cannot be resurrected by a later assignment.
          await tx.update(shippingRateBookAssignments)
            .set({ isActive: false, updatedAt: new Date() })
            .where(eq(shippingRateBookAssignments.rateBookId, id));
          await tx.update(shippingRateTables)
            .set({ status: "retired", effectiveTo: new Date() })
            .where(and(
              eq(shippingRateTables.rateBookId, id),
              inArray(shippingRateTables.status, ["active", "superseded"]),
            ));
          return book;
        });
        if (!retired) {
          throw new RateBookAdminError(
            409,
            "SHIPPING_ADMIN_RATE_BOOK_CHANGED",
            "The program changed while retiring. Refresh and try again.",
          );
        }
        return res.json({ rateBook: retired });
      } catch (error) {
        return sendRateBookAdminError(res, error, "retire pricing program");
      }
    },
  );
}

function assertNoDuplicateAssignments(assignments: readonly AssignmentInput[]): void {
  const duplicates = findDuplicateAssignments(assignments);
  if (duplicates.length > 0) {
    throw new RateBookAdminError(
      400,
      "SHIPPING_ADMIN_ASSIGNMENT_DUPLICATE",
      "The same channel, purpose, and warehouse scope is listed more than once.",
      duplicates,
    );
  }
}

async function validateAssignmentWarehouses(
  assignments: readonly AssignmentInput[],
): Promise<void> {
  const requested = new Set(
    assignments.flatMap((assignment) =>
      assignment.originWarehouseId === null ? [] : [assignment.originWarehouseId]),
  );
  if (requested.size === 0) return;
  const activeWarehouses = await db.select({ id: warehouses.id })
    .from(warehouses).where(eq(warehouses.isActive, 1));
  const activeIds = new Set(activeWarehouses.map((warehouse) => warehouse.id));
  const invalid = [...requested].find((id) => !activeIds.has(id));
  if (invalid !== undefined) {
    throw new RateBookAdminError(
      400,
      "SHIPPING_ADMIN_WAREHOUSE_INVALID",
      `Warehouse ${invalid} is missing or inactive.`,
    );
  }
}

function parseBookId(value: string): number {
  const parsed = bookIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new RateBookAdminError(400, "SHIPPING_ADMIN_INVALID_INPUT", "A valid ID is required.");
  }
  return parsed.data;
}

function notFoundError(): RateBookAdminError {
  return new RateBookAdminError(404, "SHIPPING_ADMIN_RATE_BOOK_NOT_FOUND", "Pricing program not found.");
}

class RateBookAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
  }
}

function sendInvalidInput(res: Response, issues: z.ZodIssue[]): Response {
  return res.status(400).json({ error: { code: "SHIPPING_ADMIN_INVALID_INPUT", issues } });
}

function sendRateBookAdminError(res: Response, error: unknown, action: string): Response {
  if (error instanceof RateBookAdminError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  // Partial unique indexes on rate_book_assignments reject a channel/purpose
  // scope that another program already holds actively.
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
    return res.status(409).json({
      error: {
        code: "SHIPPING_ADMIN_ASSIGNMENT_TAKEN",
        message:
          "Another pricing program already serves one of these channel and purpose scopes. "
          + "Unassign it there first — exactly one program can price a scope at a time.",
      },
    });
  }
  console.error(`[RateBookAdminRoutes] Failed to ${action}:`, error);
  return res.status(500).json({
    error: { code: "SHIPPING_ADMIN_INTERNAL_ERROR", message: `Failed to ${action}.` },
  });
}
