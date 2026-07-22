import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { persistAuditEvent } from "../../infrastructure/auditLogger";
import { products, productVariants } from "@shared/schema/catalog.schema";
import {
  demandEvents,
  demandEventLines,
  type DemandEvent,
  type DemandEventConfidence,
  type DemandEventStatus,
  type DemandEventType,
} from "@shared/schema/procurement.schema";

type DemandEventDb = Pick<typeof db, "select" | "insert" | "update" | "delete">;

export class DemandEventError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "DemandEventError";
  }
}

export interface DemandEventHeaderInput {
  name: string;
  eventType: DemandEventType;
  startDate: string;
  endDate: string | null;
  status: DemandEventStatus;
  notes: string | null;
}

export interface DemandEventLineInput {
  productId: number;
  productVariantId: number | null;
  expectedPieces: number;
  confidence: DemandEventConfidence;
  notes: string | null;
}

export interface DemandEventWriteInput {
  event: DemandEventHeaderInput;
  lines: DemandEventLineInput[];
}

export interface DemandEventWriteOptions {
  actorId: string;
  expectedUpdatedAt?: string;
  now?: Date;
}

export interface DemandEventSummary extends DemandEvent {
  lineCount: number;
  totalExpectedPieces: number;
}

export interface DemandEventLineDetail {
  id: number;
  demandEventId: number;
  productId: number;
  productVariantId: number | null;
  expectedPieces: number;
  confidence: DemandEventConfidence;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  productName: string;
  productSku: string | null;
  variantName: string | null;
  variantSku: string | null;
}

export interface DemandEventDetail extends DemandEvent {
  lines: DemandEventLineDetail[];
}

export interface ForwardDemandPolicy {
  horizonDays: number;
  confidenceWeights: Record<DemandEventConfidence, number>;
}

export interface ForwardDemandByProduct {
  productId: number;
  productName: string;
  productSku: string | null;
  totalExpectedPieces: number;
  weightedExpectedPieces: number;
  highConfidencePieces: number;
  mediumConfidencePieces: number;
  lowConfidencePieces: number;
  eventCount: number;
}

const STATUS_TRANSITIONS: Record<DemandEventStatus, readonly DemandEventStatus[]> = {
  planned: ["planned", "active", "cancelled"],
  active: ["active", "completed", "cancelled"],
  completed: ["completed"],
  cancelled: ["cancelled"],
};

function actor(options: DemandEventWriteOptions): string {
  const actorId = options.actorId.trim();
  if (!actorId) {
    throw new DemandEventError("DEMAND_EVENT_ACTOR_REQUIRED", "An authenticated operator is required", 401);
  }
  return `user:${actorId}`;
}

function parseCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DemandEventError("DEMAND_EVENT_INVALID_COUNT", "Demand event aggregate is outside the supported range", 500);
  }
  return parsed;
}

function assertDateWindow(startDate: string, endDate: string | null): void {
  if (endDate !== null && endDate < startDate) {
    throw new DemandEventError(
      "DEMAND_EVENT_INVALID_DATE_WINDOW",
      "End date must be on or after the start date",
      400,
    );
  }
}

export function assertDemandEventStatusTransition(
  current: DemandEventStatus,
  next: DemandEventStatus,
): void {
  if (!STATUS_TRANSITIONS[current].includes(next)) {
    throw new DemandEventError(
      "DEMAND_EVENT_INVALID_STATUS_TRANSITION",
      `Demand event status cannot change from ${current} to ${next}`,
      409,
    );
  }
}

export function validateDemandEventWriteInput(input: DemandEventWriteInput): void {
  assertDateWindow(input.event.startDate, input.event.endDate);
  if (input.lines.length === 0) {
    throw new DemandEventError(
      "DEMAND_EVENT_LINES_REQUIRED",
      "At least one product line is required",
      400,
    );
  }

  const seen = new Set<string>();
  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.expectedPieces) || line.expectedPieces <= 0) {
      throw new DemandEventError(
        "DEMAND_EVENT_INVALID_PIECES",
        "Expected pieces must be a positive whole number",
        400,
      );
    }
    const key = `${line.productId}:${line.productVariantId ?? 0}`;
    if (seen.has(key)) {
      throw new DemandEventError(
        "DEMAND_EVENT_DUPLICATE_LINE",
        "A product and SKU configuration may appear only once in a demand event",
        409,
      );
    }
    seen.add(key);
  }
}

async function validateCatalogReferences(client: DemandEventDb, lines: DemandEventLineInput[]): Promise<void> {
  const productIds = [...new Set(lines.map((line) => line.productId))];
  const productRows = await client
    .select({ id: products.id, isActive: products.isActive })
    .from(products)
    .where(inArray(products.id, productIds));
  const productMap = new Map(productRows.map((row) => [row.id, row]));

  for (const productId of productIds) {
    const product = productMap.get(productId);
    if (!product) {
      throw new DemandEventError("DEMAND_EVENT_PRODUCT_NOT_FOUND", `Product ${productId} does not exist`, 400);
    }
    if (!product.isActive) {
      throw new DemandEventError("DEMAND_EVENT_PRODUCT_INACTIVE", `Product ${productId} is inactive`, 409);
    }
  }

  const variantIds = [...new Set(
    lines
      .map((line) => line.productVariantId)
      .filter((variantId): variantId is number => variantId !== null),
  )];
  if (variantIds.length === 0) return;

  const variantRows = await client
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      isActive: productVariants.isActive,
    })
    .from(productVariants)
    .where(inArray(productVariants.id, variantIds));
  const variantMap = new Map(variantRows.map((row) => [row.id, row]));

  for (const line of lines) {
    if (line.productVariantId === null) continue;
    const variant = variantMap.get(line.productVariantId);
    if (!variant) {
      throw new DemandEventError(
        "DEMAND_EVENT_VARIANT_NOT_FOUND",
        `Product variant ${line.productVariantId} does not exist`,
        400,
      );
    }
    if (variant.productId !== line.productId) {
      throw new DemandEventError(
        "DEMAND_EVENT_VARIANT_PRODUCT_MISMATCH",
        `Product variant ${line.productVariantId} does not belong to product ${line.productId}`,
        409,
      );
    }
    if (!variant.isActive) {
      throw new DemandEventError(
        "DEMAND_EVENT_VARIANT_INACTIVE",
        `Product variant ${line.productVariantId} is inactive`,
        409,
      );
    }
  }
}

function eventSnapshot(event: DemandEvent, lines?: DemandEventLineInput[] | DemandEventLineDetail[]) {
  return {
    id: event.id,
    name: event.name,
    eventType: event.eventType,
    startDate: event.startDate,
    endDate: event.endDate,
    status: event.status,
    notes: event.notes,
    updatedAt: event.updatedAt,
    ...(lines ? { lines } : {}),
  };
}

export async function listDemandEvents(filters?: {
  status?: DemandEventStatus | DemandEventStatus[];
  limit?: number;
  offset?: number;
}): Promise<{ events: DemandEventSummary[]; total: number }> {
  const statusFilter = filters?.status;
  const statuses = statusFilter
    ? Array.isArray(statusFilter) ? statusFilter : [statusFilter]
    : null;
  const limit = Math.max(1, Math.min(filters?.limit ?? 50, 200));
  const offset = Math.max(0, filters?.offset ?? 0);

  const countResult = await db.execute(sql`
    SELECT COUNT(*)::int AS total
    FROM procurement.demand_events de
    ${statuses ? sql`WHERE de.status = ANY(${statuses})` : sql``}
  `);
  const total = parseCount(countResult.rows[0]?.total);

  const result = await db.execute(sql`
    SELECT
      de.id,
      de.name,
      de.event_type,
      de.start_date,
      de.end_date,
      de.status,
      de.notes,
      de.created_by,
      de.created_at,
      de.updated_at,
      COUNT(del.id)::int AS line_count,
      COALESCE(SUM(del.expected_pieces), 0)::bigint AS total_expected_pieces
    FROM procurement.demand_events de
    LEFT JOIN procurement.demand_event_lines del ON del.demand_event_id = de.id
    ${statuses ? sql`WHERE de.status = ANY(${statuses})` : sql``}
    GROUP BY de.id
    ORDER BY de.start_date ASC, de.id ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const events = result.rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    eventType: row.event_type as DemandEventType,
    startDate: String(row.start_date),
    endDate: row.end_date === null ? null : String(row.end_date),
    status: row.status as DemandEventStatus,
    notes: row.notes === null ? null : String(row.notes),
    createdBy: row.created_by === null ? null : String(row.created_by),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    lineCount: parseCount(row.line_count),
    totalExpectedPieces: parseCount(row.total_expected_pieces),
  }));

  return { events, total };
}

export async function getDemandEventById(id: number): Promise<DemandEventDetail | null> {
  const [event] = await db.select().from(demandEvents).where(eq(demandEvents.id, id));
  if (!event) return null;

  const rows = await db
    .select({
      id: demandEventLines.id,
      demandEventId: demandEventLines.demandEventId,
      productId: demandEventLines.productId,
      productVariantId: demandEventLines.productVariantId,
      expectedPieces: demandEventLines.expectedPieces,
      confidence: demandEventLines.confidence,
      notes: demandEventLines.notes,
      createdAt: demandEventLines.createdAt,
      updatedAt: demandEventLines.updatedAt,
      productName: products.name,
      productSku: products.sku,
      variantName: productVariants.name,
      variantSku: productVariants.sku,
    })
    .from(demandEventLines)
    .leftJoin(products, eq(products.id, demandEventLines.productId))
    .leftJoin(productVariants, eq(productVariants.id, demandEventLines.productVariantId))
    .where(eq(demandEventLines.demandEventId, id))
    .orderBy(demandEventLines.id);

  return {
    ...event,
    lines: rows.map((row) => ({
      ...row,
      productName: row.productName ?? `Unknown product ${row.productId}`,
      confidence: row.confidence as DemandEventConfidence,
    })),
  };
}

export async function createDemandEvent(
  input: DemandEventWriteInput,
  options: DemandEventWriteOptions,
): Promise<DemandEventDetail> {
  validateDemandEventWriteInput(input);
  const auditActor = actor(options);
  const now = options.now ?? new Date();

  const eventId = await db.transaction(async (tx) => {
    await validateCatalogReferences(tx, input.lines);
    const createdBy = options.actorId.trim();
    const [event] = await tx.insert(demandEvents).values({
      ...input.event,
      createdBy,
      createdAt: now,
      updatedAt: now,
    }).returning();

    const lines = await tx.insert(demandEventLines).values(input.lines.map((line) => ({
      ...line,
      demandEventId: event.id,
      createdAt: now,
      updatedAt: now,
    }))).returning();

    await persistAuditEvent(tx, {
      actor: auditActor,
      action: "demand_event.created",
      target: `demand_event:${event.id}`,
      changes: { before: null, after: eventSnapshot(event, lines as DemandEventLineInput[]) },
    }, { timestamp: now });
    return event.id;
  });

  const created = await getDemandEventById(eventId);
  if (!created) throw new DemandEventError("DEMAND_EVENT_CREATE_READ_FAILED", "Created demand event could not be read", 500);
  return created;
}

export async function updateDemandEvent(
  id: number,
  updates: Partial<DemandEventHeaderInput>,
  options: DemandEventWriteOptions,
): Promise<DemandEventDetail | null> {
  const auditActor = actor(options);
  const now = options.now ?? new Date();

  const updated = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(demandEvents).where(eq(demandEvents.id, id)).for("update");
    if (!current) return null;
    if (options.expectedUpdatedAt && current.updatedAt.toISOString() !== options.expectedUpdatedAt) {
      throw new DemandEventError("DEMAND_EVENT_VERSION_CONFLICT", "Demand event changed; reload before saving", 409);
    }
    if (updates.status !== undefined) {
      assertDemandEventStatusTransition(current.status as DemandEventStatus, updates.status);
    }
    assertDateWindow(
      updates.startDate ?? current.startDate,
      updates.endDate === undefined ? current.endDate : updates.endDate,
    );

    const [next] = await tx.update(demandEvents).set({ ...updates, updatedAt: now }).where(eq(demandEvents.id, id)).returning();
    await persistAuditEvent(tx, {
      actor: auditActor,
      action: "demand_event.updated",
      target: `demand_event:${id}`,
      changes: { before: eventSnapshot(current), after: eventSnapshot(next) },
    }, { timestamp: now });
    return next;
  });

  return updated ? getDemandEventById(id) : null;
}

export async function replaceDemandEvent(
  id: number,
  input: DemandEventWriteInput,
  options: DemandEventWriteOptions,
): Promise<DemandEventDetail | null> {
  validateDemandEventWriteInput(input);
  const auditActor = actor(options);
  const now = options.now ?? new Date();

  const updated = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(demandEvents).where(eq(demandEvents.id, id)).for("update");
    if (!current) return false;
    if (options.expectedUpdatedAt && current.updatedAt.toISOString() !== options.expectedUpdatedAt) {
      throw new DemandEventError("DEMAND_EVENT_VERSION_CONFLICT", "Demand event changed; reload before deleting", 409);
    }
    if (options.expectedUpdatedAt && current.updatedAt.toISOString() !== options.expectedUpdatedAt) {
      throw new DemandEventError("DEMAND_EVENT_VERSION_CONFLICT", "Demand event changed; reload before saving", 409);
    }
    assertDemandEventStatusTransition(current.status as DemandEventStatus, input.event.status);
    await validateCatalogReferences(tx, input.lines);

    const currentLines = await tx.select().from(demandEventLines).where(eq(demandEventLines.demandEventId, id));
    const [next] = await tx.update(demandEvents).set({ ...input.event, updatedAt: now }).where(eq(demandEvents.id, id)).returning();
    await tx.delete(demandEventLines).where(eq(demandEventLines.demandEventId, id));
    const nextLines = await tx.insert(demandEventLines).values(input.lines.map((line) => ({
      ...line,
      demandEventId: id,
      createdAt: now,
      updatedAt: now,
    }))).returning();

    await persistAuditEvent(tx, {
      actor: auditActor,
      action: "demand_event.replaced",
      target: `demand_event:${id}`,
      changes: {
        before: eventSnapshot(current, currentLines as DemandEventLineInput[]),
        after: eventSnapshot(next, nextLines as DemandEventLineInput[]),
      },
    }, { timestamp: now });
    return true;
  });

  return updated ? getDemandEventById(id) : null;
}

export async function deleteDemandEvent(id: number, options: DemandEventWriteOptions): Promise<boolean> {
  const auditActor = actor(options);
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(demandEvents).where(eq(demandEvents.id, id)).for("update");
    if (!current) return false;
    const lines = await tx.select().from(demandEventLines).where(eq(demandEventLines.demandEventId, id));
    await tx.delete(demandEvents).where(eq(demandEvents.id, id));
    await persistAuditEvent(tx, {
      actor: auditActor,
      action: "demand_event.deleted",
      target: `demand_event:${id}`,
      changes: { before: eventSnapshot(current, lines as DemandEventLineInput[]), after: null },
    }, { timestamp: now });
    return true;
  });
}

export async function addDemandEventLine(
  eventId: number,
  line: DemandEventLineInput,
  options: DemandEventWriteOptions,
): Promise<DemandEventLineDetail> {
  const existing = await getDemandEventById(eventId);
  if (!existing) throw new DemandEventError("DEMAND_EVENT_NOT_FOUND", "Demand event not found", 404);
  const replaced = await replaceDemandEvent(eventId, {
    event: {
      name: existing.name,
      eventType: existing.eventType as DemandEventType,
      startDate: existing.startDate,
      endDate: existing.endDate,
      status: existing.status as DemandEventStatus,
      notes: existing.notes,
    },
    lines: [...existing.lines.map(toLineInput), line],
  }, { ...options, expectedUpdatedAt: options.expectedUpdatedAt ?? existing.updatedAt.toISOString() });
  if (!replaced) throw new DemandEventError("DEMAND_EVENT_NOT_FOUND", "Demand event not found", 404);
  return replaced.lines[replaced.lines.length - 1];
}

export async function updateDemandEventLine(
  lineId: number,
  updates: Partial<Pick<DemandEventLineInput, "expectedPieces" | "confidence" | "notes">>,
  options: DemandEventWriteOptions,
): Promise<DemandEventLineDetail | null> {
  const [line] = await db.select().from(demandEventLines).where(eq(demandEventLines.id, lineId));
  if (!line) return null;
  const existing = await getDemandEventById(line.demandEventId);
  if (!existing) return null;
  const replaced = await replaceDemandEvent(line.demandEventId, {
    event: {
      name: existing.name,
      eventType: existing.eventType as DemandEventType,
      startDate: existing.startDate,
      endDate: existing.endDate,
      status: existing.status as DemandEventStatus,
      notes: existing.notes,
    },
    lines: existing.lines.map((item) => item.id === lineId ? { ...toLineInput(item), ...updates } : toLineInput(item)),
  }, { ...options, expectedUpdatedAt: options.expectedUpdatedAt ?? existing.updatedAt.toISOString() });
  return replaced?.lines.find((item) => item.productId === line.productId && item.productVariantId === line.productVariantId) ?? null;
}

export async function deleteDemandEventLine(
  lineId: number,
  options: DemandEventWriteOptions,
): Promise<boolean> {
  const [line] = await db.select().from(demandEventLines).where(eq(demandEventLines.id, lineId));
  if (!line) return false;
  const existing = await getDemandEventById(line.demandEventId);
  if (!existing) return false;
  await replaceDemandEvent(line.demandEventId, {
    event: {
      name: existing.name,
      eventType: existing.eventType as DemandEventType,
      startDate: existing.startDate,
      endDate: existing.endDate,
      status: existing.status as DemandEventStatus,
      notes: existing.notes,
    },
    lines: existing.lines.filter((item) => item.id !== lineId).map(toLineInput),
  }, { ...options, expectedUpdatedAt: options.expectedUpdatedAt ?? existing.updatedAt.toISOString() });
  return true;
}

function toLineInput(line: DemandEventLineDetail): DemandEventLineInput {
  return {
    productId: line.productId,
    productVariantId: line.productVariantId,
    expectedPieces: line.expectedPieces,
    confidence: line.confidence,
    notes: line.notes,
  };
}

export async function getForwardDemandByProduct(
  policy: ForwardDemandPolicy,
): Promise<Map<number, ForwardDemandByProduct>> {
  const horizonDays = Math.max(1, Math.min(365, policy.horizonDays));
  const weights = policy.confidenceWeights;
  for (const [confidence, weight] of Object.entries(weights)) {
    if (!Number.isSafeInteger(weight) || weight < 0 || weight > 100) {
      throw new DemandEventError(
        "DEMAND_EVENT_INVALID_CONFIDENCE_WEIGHT",
        `Configured ${confidence} confidence weight must be an integer between 0 and 100`,
        500,
      );
    }
  }
  const result = await db.execute(sql`
    SELECT
      del.product_id,
      p.name AS product_name,
      p.sku AS product_sku,
      SUM(del.expected_pieces)::bigint AS total_expected_pieces,
      SUM(CASE WHEN del.confidence = 'high' THEN del.expected_pieces ELSE 0 END)::bigint AS high_confidence_pieces,
      SUM(CASE WHEN del.confidence = 'medium' THEN del.expected_pieces ELSE 0 END)::bigint AS medium_confidence_pieces,
      SUM(CASE WHEN del.confidence = 'low' THEN del.expected_pieces ELSE 0 END)::bigint AS low_confidence_pieces,
      SUM(CASE del.confidence
        WHEN 'high' THEN CEIL(del.expected_pieces * ${weights.high} / 100.0)
        WHEN 'medium' THEN CEIL(del.expected_pieces * ${weights.medium} / 100.0)
        WHEN 'low' THEN CEIL(del.expected_pieces * ${weights.low} / 100.0)
        ELSE 0
      END)::bigint AS weighted_expected_pieces,
      COUNT(DISTINCT de.id)::int AS event_count
    FROM procurement.demand_event_lines del
    JOIN procurement.demand_events de ON de.id = del.demand_event_id
    JOIN catalog.products p ON p.id = del.product_id
    WHERE de.status IN ('planned', 'active')
      AND de.start_date <= CURRENT_DATE + MAKE_INTERVAL(days => ${horizonDays})
      AND (de.end_date IS NULL OR de.end_date >= CURRENT_DATE)
      AND p.is_active = true
    GROUP BY del.product_id, p.name, p.sku
  `);

  const map = new Map<number, ForwardDemandByProduct>();
  for (const row of result.rows) {
    const productId = Number(row.product_id);
    map.set(productId, {
      productId,
      productName: String(row.product_name),
      productSku: row.product_sku === null ? null : String(row.product_sku),
      totalExpectedPieces: parseCount(row.total_expected_pieces),
      weightedExpectedPieces: parseCount(row.weighted_expected_pieces),
      highConfidencePieces: parseCount(row.high_confidence_pieces),
      mediumConfidencePieces: parseCount(row.medium_confidence_pieces),
      lowConfidencePieces: parseCount(row.low_confidence_pieces),
      eventCount: parseCount(row.event_count),
    });
  }
  return map;
}
