import { z } from "zod";

export const inboundTrackingProviderSchema = z.enum(["searates", "shipstation"]);
export const inboundTrackingReferenceTypeSchema = z.enum(["container", "bill_of_lading", "booking", "parcel"]);
const id = z.number().int().positive().max(2_147_483_647);
const instant = z.string().datetime({ offset: true });
const text = z.string().max(500);
export const inboundTrackingIdentitySchema = z.object({
  provider: inboundTrackingProviderSchema,
  referenceType: inboundTrackingReferenceTypeSchema,
  reference: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).transform((value) => value.toUpperCase()),
  carrierCode: z.string().trim().max(100).regex(/^[a-zA-Z0-9_]*$/),
}).strict().superRefine((value, context) => {
  if (value.provider === "shipstation" && (value.referenceType !== "parcel" || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(value.carrierCode))) {
    context.addIssue({ code: "custom", message: "Parcel tracking requires a ShipStation carrier code and parcel reference." });
  }
  if (value.provider === "searates" && (value.referenceType === "parcel" || !/^(?:[A-Z]{4}|auto)?$/.test(value.carrierCode))) {
    context.addIssue({ code: "custom", message: "Ocean tracking requires a container, bill of lading or booking reference and an optional four-letter SCAC." });
  }
  if (value.referenceType === "container" && !/^[A-Z]{4}\d{7}$/.test(value.reference)) {
    context.addIssue({ code: "custom", message: "Container number must contain four letters followed by seven digits." });
  }
});
export type InboundTrackingIdentity = z.infer<typeof inboundTrackingIdentitySchema>;
export const inboundTrackingConfigSchema = z.object({
  identity: inboundTrackingIdentitySchema,
  enabled: z.boolean(),
  includeVesselPosition: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.identity.provider !== "searates" && value.includeVesselPosition) context.addIssue({ code: "custom", message: "Vessel position is available for ocean tracking only." });
});
export type InboundTrackingConfig = z.infer<typeof inboundTrackingConfigSchema>;
export const saveInboundTrackingSchema = z.object({
  requestKey: z.string().uuid(), referenceId: id.nullable(), expectedRevision: z.number().int().nonnegative(), config: inboundTrackingConfigSchema,
}).strict();
export type SaveInboundTracking = z.infer<typeof saveInboundTrackingSchema>;
export const refreshInboundTrackingSchema = z.object({ requestKey: z.string().uuid() }).strict();
export const inboundTrackingEventSchema = z.object({
  key: text, container: text.nullable(), sequence: z.number().int().nonnegative(),
  description: text, code: text.nullable(), dateText: text.nullable(), occurredAt: instant.nullable(),
  timezone: text.nullable(), actual: z.boolean().nullable(), location: text.nullable(), vessel: text.nullable(), voyage: text.nullable(),
  source: z.enum(["carrier", "provider_calculated", "unknown"]), mirrored: z.boolean(),
}).strict();
export const inboundTrackingSnapshotSchema = z.object({
  version: z.literal(1), provider: inboundTrackingProviderSchema, reference: text,
  status: text, statusSource: z.enum(["carrier", "provider_calculated", "unknown"]),
  sourceUpdatedAt: instant.nullable(), latestActualEventAt: instant.nullable(),
  fromCache: z.boolean().nullable(), carrierName: text.nullable(),
  arrival: z.object({ kind: z.enum(["port", "carrier_destination"]), dateText: text, occurredAt: instant.nullable(), timezone: text.nullable(), location: text.nullable(), actual: z.boolean().nullable() }).strict().nullable(),
  vesselPosition: z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180), observedAt: instant, vessel: text.nullable() }).strict().nullable(),
  positionStatus: text.nullable(), events: z.array(inboundTrackingEventSchema).max(1_000),
}).strict();
export type InboundTrackingSnapshot = z.infer<typeof inboundTrackingSnapshotSchema>;
export type InboundTrackingEvent = z.infer<typeof inboundTrackingEventSchema>;
export const inboundTrackingReferenceSchema = z.object({
  id, revision: z.number().int().positive(), config: inboundTrackingConfigSchema,
  lastAttemptAt: instant.nullable(), lastSuccessAt: instant.nullable(), nextPollAt: instant.nullable(),
  failureCount: z.number().int().nonnegative(), lastErrorCode: text.nullable(), lastErrorMessage: text.nullable(),
  leaseUntil: instant.nullable(), reviewRequired: z.boolean(), current: inboundTrackingSnapshotSchema.nullable(),
}).strict();
export type InboundTrackingReference = z.infer<typeof inboundTrackingReferenceSchema>;
export const inboundTrackingViewSchema = z.object({
  pollingEnabled: z.boolean(), providers: z.array(z.object({ provider: inboundTrackingProviderSchema, configured: z.boolean(), setup: text }).strict()),
  references: z.array(inboundTrackingReferenceSchema).max(20),
}).strict();
export type InboundTrackingView = z.infer<typeof inboundTrackingViewSchema>;
export const inboundTrackingHistorySchema = z.object({
  observations: z.array(z.object({ id: z.string().regex(/^\d+$/), observedAt: instant, snapshot: inboundTrackingSnapshotSchema }).strict()).max(25),
  attempts: z.array(z.object({ startedAt: instant, completedAt: instant, outcome: text, errorCode: text.nullable(), message: text.nullable() }).strict()).max(25),
  changes: z.array(z.object({ revision: z.number().int().positive(), actorId: text, recordedAt: instant, before: inboundTrackingConfigSchema.nullable(), after: inboundTrackingConfigSchema }).strict()).max(25),
  nextObservationCursor: z.string().regex(/^\d+$/).nullable(),
}).strict();
export type InboundTrackingHistory = z.infer<typeof inboundTrackingHistorySchema>;

export const inboundTrackingCommandResultSchema = z.object({ referenceId: id, revision: z.number().int().positive(), queued: z.boolean() }).strict();
