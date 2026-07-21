import type { InsertVendor, Vendor } from "@shared/schema";
import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { persistAuditEvent } from "../../infrastructure/auditLogger";

type VendorStorage = {
  getVendorById(id: number, executor?: any): Promise<Vendor | undefined>;
  getVendorByCode(code: string, executor?: any): Promise<Vendor | undefined>;
  createVendor(data: InsertVendor, executor?: any): Promise<Vendor>;
  updateVendor(id: number, updates: Partial<InsertVendor>, executor?: any): Promise<Vendor | null>;
};

type VendorDatabase = Pick<typeof defaultDb, "transaction">;

const VENDOR_FIELDS = new Set([
  "code",
  "name",
  "contactName",
  "email",
  "phone",
  "address",
  "notes",
  "active",
  "paymentTermsDays",
  "paymentTermsType",
  "currency",
  "taxId",
  "accountNumber",
  "website",
  "defaultLeadTimeDays",
  "minimumOrderCents",
  "freeFreightThresholdCents",
  "vendorType",
  "shipFromAddress",
  "country",
  "rating",
  "defaultIncoterms",
]);

const STRING_LIMITS: Record<string, number | undefined> = {
  code: 20,
  name: undefined,
  contactName: undefined,
  email: 255,
  phone: 50,
  address: undefined,
  notes: undefined,
  paymentTermsType: 20,
  currency: 3,
  taxId: 50,
  accountNumber: 50,
  website: undefined,
  vendorType: 20,
  shipFromAddress: undefined,
  country: 50,
  defaultIncoterms: 10,
};

export class VendorServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "VendorServiceError";
  }
}

function positiveId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new VendorServiceError("Vendor id must be a positive safe integer");
  }
  return parsed;
}

function actorIdentity(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new VendorServiceError("Authenticated actor is required", 401);
  }
  return value.trim();
}

function normalizeVendorInput(
  input: Record<string, unknown>,
  mode: "create" | "update",
): InsertVendor | Partial<InsertVendor> {
  const rejectedFields = Object.keys(input).filter((field) => !VENDOR_FIELDS.has(field));
  if (rejectedFields.length > 0) {
    throw new VendorServiceError("Vendor mutation contains unsupported fields", 400, {
      code: "INVALID_VENDOR_FIELDS",
      rejectedFields,
    });
  }
  if (mode === "update" && Object.keys(input).length === 0) {
    throw new VendorServiceError("Vendor update requires at least one field");
  }

  const normalized: Record<string, unknown> = {};
  for (const [field, maxLength] of Object.entries(STRING_LIMITS)) {
    if (!(field in input)) continue;
    const value = input[field];
    if (value === null || value === "") {
      normalized[field] = null;
      continue;
    }
    if (typeof value !== "string") {
      throw new VendorServiceError(`${field} must be a string or null`);
    }
    const text = value.trim();
    if (!text && (field === "code" || field === "name")) {
      throw new VendorServiceError(`${field} is required`);
    }
    if (maxLength !== undefined && text.length > maxLength) {
      throw new VendorServiceError(`${field} cannot exceed ${maxLength} characters`);
    }
    normalized[field] = text || null;
  }

  if (mode === "create" && (!normalized.code || !normalized.name)) {
    throw new VendorServiceError("Vendor code and name are required");
  }
  if (typeof normalized.code === "string") normalized.code = normalized.code.toUpperCase();
  if (typeof normalized.currency === "string") normalized.currency = normalized.currency.toUpperCase();
  if (typeof normalized.defaultIncoterms === "string") {
    normalized.defaultIncoterms = normalized.defaultIncoterms.toUpperCase();
  }
  if (typeof normalized.email === "string") normalized.email = normalized.email.toLowerCase();

  for (const field of [
    "paymentTermsDays",
    "defaultLeadTimeDays",
    "minimumOrderCents",
    "freeFreightThresholdCents",
  ]) {
    if (!(field in input)) continue;
    if (input[field] === null || input[field] === "") {
      normalized[field] = null;
      continue;
    }
    const value = Number(input[field]);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new VendorServiceError(`${field} must be a non-negative safe integer or null`);
    }
    normalized[field] = value;
  }

  if ("active" in input) {
    const active = Number(input.active);
    if (!Number.isInteger(active) || (active !== 0 && active !== 1)) {
      throw new VendorServiceError("active must be 0 or 1");
    }
    normalized.active = active;
  }
  if ("rating" in input) {
    if (input.rating === null || input.rating === "") {
      normalized.rating = null;
    } else {
      const rating = Number(input.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw new VendorServiceError("rating must be an integer from 1 to 5 or null");
      }
      normalized.rating = rating;
    }
  }

  return normalized as InsertVendor | Partial<InsertVendor>;
}

export class VendorService {
  constructor(
    private readonly database: VendorDatabase,
    private readonly storage: VendorStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: Record<string, unknown>, rawActor: unknown): Promise<Vendor> {
    const actor = actorIdentity(rawActor);
    const data = normalizeVendorInput(input, "create") as InsertVendor;
    try {
      return await this.database.transaction(async (tx) => {
        const existing = await this.storage.getVendorByCode(data.code, tx);
        if (existing) {
          throw new VendorServiceError("Vendor code already exists", 409, { vendorId: existing.id });
        }
        const vendor = await this.storage.createVendor(data, tx);
        await persistAuditEvent(tx, {
          actor,
          action: "procurement.vendor.create",
          target: `procurement.vendor:${vendor.id}`,
          changes: { before: null, after: vendor },
        }, { timestamp: this.now(), emitStructuredLog: false });
        return vendor;
      });
    } catch (error: any) {
      if (error instanceof VendorServiceError) throw error;
      if (error?.code === "23505" || error?.cause?.code === "23505") {
        throw new VendorServiceError("Vendor code already exists", 409);
      }
      throw error;
    }
  }

  async update(idInput: unknown, input: Record<string, unknown>, rawActor: unknown): Promise<Vendor> {
    const id = positiveId(idInput);
    const actor = actorIdentity(rawActor);
    const updates = normalizeVendorInput(input, "update") as Partial<InsertVendor>;

    try {
      return await this.database.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM procurement.vendors WHERE id = ${id} FOR UPDATE`);
        const before = await this.storage.getVendorById(id, tx);
        if (!before) throw new VendorServiceError("Vendor not found", 404);

        if (updates.code && updates.code !== before.code) {
          const conflict = await this.storage.getVendorByCode(updates.code, tx);
          if (conflict && conflict.id !== id) {
            throw new VendorServiceError("Vendor code already exists", 409, { vendorId: conflict.id });
          }
        }

        const vendor = await this.storage.updateVendor(id, updates, tx);
        if (!vendor) throw new VendorServiceError("Vendor changed during update", 409);
        await persistAuditEvent(tx, {
          actor,
          action: "procurement.vendor.update",
          target: `procurement.vendor:${id}`,
          changes: { before, after: vendor },
        }, { timestamp: this.now(), emitStructuredLog: false });
        return vendor;
      });
    } catch (error: any) {
      if (error instanceof VendorServiceError) throw error;
      if (error?.code === "23505" || error?.cause?.code === "23505") {
        throw new VendorServiceError("Vendor code already exists", 409);
      }
      throw error;
    }
  }

  async deactivate(idInput: unknown, rawActor: unknown): Promise<Vendor> {
    const id = positiveId(idInput);
    const actor = actorIdentity(rawActor);
    return await this.database.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM procurement.vendors WHERE id = ${id} FOR UPDATE`);
      const before = await this.storage.getVendorById(id, tx);
      if (!before) throw new VendorServiceError("Vendor not found", 404);
      if (before.active === 0) return before;

      const vendor = await this.storage.updateVendor(id, { active: 0 }, tx);
      if (!vendor) throw new VendorServiceError("Vendor changed during deactivation", 409);
      await persistAuditEvent(tx, {
        actor,
        action: "procurement.vendor.deactivate",
        target: `procurement.vendor:${id}`,
        changes: { before, after: vendor },
      }, { timestamp: this.now(), emitStructuredLog: false });
      return vendor;
    });
  }
}

export function createVendorService(
  database: VendorDatabase,
  storage: VendorStorage,
): VendorService {
  return new VendorService(database, storage);
}
