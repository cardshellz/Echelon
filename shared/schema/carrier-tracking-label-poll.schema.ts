import {
  bigint,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import {
  carrierTrackingEvents,
  shippingProviderLabels,
} from "./fulfillment.schema";
import { wmsSchema } from "./orders.schema";

export const carrierTrackingLabelPolls = wmsSchema.table("carrier_tracking_label_polls", {
  shippingProviderLabelId: bigint("shipping_provider_label_id", { mode: "number" })
    .primaryKey()
    .references(() => shippingProviderLabels.id, { onDelete: "restrict" }),
  pollStatus: varchar("poll_status", { length: 30 }).notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  consecutiveFailureCount: integer("consecutive_failure_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  lastEventId: bigint("last_event_id", { mode: "number" })
    .references(() => carrierTrackingEvents.id, { onDelete: "restrict" }),
  leaseOwner: varchar("lease_owner", { length: 200 }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastErrorCode: varchar("last_error_code", { length: 100 }),
  lastErrorMessage: text("last_error_message"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_carrier_tracking_label_polls_due")
    .on(table.nextAttemptAt, table.leaseExpiresAt, table.shippingProviderLabelId),
  index("idx_carrier_tracking_label_polls_status")
    .on(table.pollStatus, table.updatedAt),
]);

export const carrierTrackingLabelPollAttempts = wmsSchema.table(
  "carrier_tracking_label_poll_attempts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    shippingProviderLabelId: bigint("shipping_provider_label_id", { mode: "number" })
      .notNull()
      .references(() => carrierTrackingLabelPolls.shippingProviderLabelId, {
        onDelete: "restrict",
      }),
    attemptNumber: integer("attempt_number").notNull(),
    attemptOutcome: varchar("attempt_outcome", { length: 30 }).notNull(),
    httpStatus: integer("http_status"),
    carrierTrackingEventId: bigint("carrier_tracking_event_id", { mode: "number" })
      .references(() => carrierTrackingEvents.id, { onDelete: "restrict" }),
    dispatchEvidence: varchar("dispatch_evidence", { length: 30 }),
    errorCode: varchar("error_code", { length: 100 }),
    errorMessage: text("error_message"),
    requestEvidence: jsonb("request_evidence").notNull(),
    responseEvidence: jsonb("response_evidence").notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_carrier_tracking_label_poll_attempt_number")
      .on(table.shippingProviderLabelId, table.attemptNumber),
    index("idx_carrier_tracking_label_poll_attempts_label")
      .on(table.shippingProviderLabelId, table.attemptNumber),
  ],
);
