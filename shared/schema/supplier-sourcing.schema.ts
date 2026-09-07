import { pgSchema, bigint, integer, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { vendorProducts } from "./procurement.schema";
import type { SupplierSourcingPolicy } from "../procurement/supplier-sourcing";

export const supplierSourcingRevisions = pgSchema("procurement").table("supplier_sourcing_revisions", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  vendorProductId: integer("vendor_product_id").notNull().references(() => vendorProducts.id, { onDelete: "restrict" }),
  revision: integer("revision").notNull(), idempotencyKey: uuid("idempotency_key").notNull(), requestHash: text("request_hash").notNull(),
  beforePolicy: jsonb("before_policy").$type<SupplierSourcingPolicy>(), policy: jsonb("policy").$type<SupplierSourcingPolicy>().notNull(),
  reason: text("reason").notNull(), recordedBy: text("recorded_by").notNull(), recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
}, (table) => [uniqueIndex("supplier_sourcing_mapping_revision_uidx").on(table.vendorProductId, table.revision), uniqueIndex("supplier_sourcing_mapping_idempotency_uidx").on(table.vendorProductId, table.idempotencyKey)]);
