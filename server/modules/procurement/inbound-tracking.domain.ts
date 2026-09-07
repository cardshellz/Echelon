import { createHash } from "node:crypto";
import { z } from "zod";
import { inboundTrackingSnapshotSchema, type InboundTrackingEvent, type InboundTrackingIdentity, type InboundTrackingSnapshot } from "@shared/procurement/inbound-tracking";

export class InboundTrackingError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = "InboundTrackingError"; }
}
export class InboundTrackingProviderError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly retryAfterMs: number | null = null) { super(message); this.name = "InboundTrackingProviderError"; }
}
const providerText = z.string().max(500);
const optionalText = providerText.nullish();
const providerId = z.number().int().nonnegative();
const dateTextSchema = z.string().max(50);

/** Local carrier dates retain their literal value and timezone; no server-local timezone is inferred. */
export function trackingDate(value: string | null | undefined, knownUtc = false): { dateText: string | null; instant: string | null } {
  if (!value) return { dateText: null, instant: null };
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (!match) throw new InboundTrackingProviderError("INVALID_RESPONSE", "Provider returned an invalid tracking date.", false);
  const [, year, month, day, hour, minute, second, fraction = "", offset = ""] = match;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    throw new InboundTrackingProviderError("INVALID_RESPONSE", "Provider returned an invalid calendar date.", false);
  }
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction}${offset || (knownUtc ? "Z" : "")}`;
  if (!offset && !knownUtc) return { dateText: value, instant: null };
  const milliseconds = Date.parse(iso);
  if (!Number.isFinite(milliseconds)) throw new InboundTrackingProviderError("INVALID_RESPONSE", "Provider returned an invalid time offset.", false);
  return { dateText: value, instant: new Date(milliseconds).toISOString() };
}
const origin = (value: boolean | null | undefined): "carrier" | "provider_calculated" | "unknown" => value === true ? "carrier" : value === false ? "provider_calculated" : "unknown";
const latestInstant = (events: InboundTrackingEvent[]): string | null => events.filter((event) => event.actual === true && event.occurredAt !== null).map((event) => event.occurredAt!).sort().at(-1) ?? null;
export function trackingFingerprint(snapshot: InboundTrackingSnapshot): string {
  return createHash("sha256").update(JSON.stringify(inboundTrackingSnapshotSchema.parse(snapshot))).digest("hex");
}
export function acceptsTrackingSnapshot(current: InboundTrackingSnapshot | null, incoming: InboundTrackingSnapshot): boolean {
  if (!current) return true;
  // SeaRates documents metadata.updated_at as the UTC carrier-data revision. Older cached revisions cannot replace newer evidence.
  if (current.sourceUpdatedAt !== null) return incoming.sourceUpdatedAt !== null && incoming.sourceUpdatedAt >= current.sourceUpdatedAt;
  // ShipStation has no source revision. A response missing a previously observed latest actual event is retained for review, not promoted.
  if (current.latestActualEventAt !== null) return incoming.latestActualEventAt !== null && incoming.latestActualEventAt >= current.latestActualEventAt;
  return true;
}
const seaEvent = z.object({
  order_id: providerId, location: providerId.nullish(), description: providerText,
  event_code: optionalText, status: optionalText, date: dateTextSchema.nullish(), actual: z.boolean().nullable(),
  is_date_from_sealine: z.boolean().nullish(), vessel: providerId.nullish(), voyage: optionalText,
});
const seaLocation = z.object({ id: providerId, name: providerText, country_code: optionalText, timezone: optionalText });
const seaPayloadSchema = z.object({ status: z.literal("success"), data: z.object({
  metadata: z.object({ number: providerText, type: z.enum(["CT", "BL", "BK"]), status: providerText, sealine: optionalText, sealine_name: optionalText, is_status_from_sealine: z.boolean().nullish(), updated_at: dateTextSchema.nullish(), from_cache: z.boolean().nullish() }),
  locations: z.array(seaLocation).max(1_000),
  vessels: z.array(z.object({ id: providerId, name: providerText })).max(1_000),
  containers: z.array(z.object({ number: providerText, events_mirrored: z.boolean().nullish(), events: z.array(seaEvent).max(1_000) })).max(100),
  route: z.object({ pod: z.object({ location: providerId.nullish(), date: dateTextSchema.nullish(), actual: z.boolean().nullable() }).nullish() }).nullish(),
  route_data: z.object({ ais: z.object({ status: providerText, data: z.object({
    vessel: z.object({ name: optionalText }).nullish(),
    last_vessel_position: z.object({ lat: z.number().min(-90).max(90).nullish(), lng: z.number().min(-180).max(180).nullish(), updated_at: dateTextSchema.nullish() }).nullish(),
  }).nullish() }).nullish() }).nullish(),
}) });

export function parseSeaRatesTracking(payload: unknown, identity: InboundTrackingIdentity): InboundTrackingSnapshot {
  const parsed = seaPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new InboundTrackingProviderError("INVALID_RESPONSE", "SeaRates returned tracking data outside the supported contract.", false);
  const data = parsed.data.data;
  const expectedType = { container: "CT", bill_of_lading: "BL", booking: "BK", parcel: "" }[identity.referenceType];
  if (data.metadata.number.trim().toUpperCase() !== identity.reference || data.metadata.type !== expectedType) throw new InboundTrackingProviderError("REFERENCE_MISMATCH", "SeaRates response does not match the saved tracking reference.", false);
  if (identity.carrierCode && identity.carrierCode !== "auto" && data.metadata.sealine?.toUpperCase() !== identity.carrierCode) throw new InboundTrackingProviderError("CARRIER_MISMATCH", "SeaRates response does not match the saved shipping line.", false);
  const locations = new Map(data.locations.map((location) => [location.id, location]));
  const vessels = new Map(data.vessels.map((vessel) => [vessel.id, vessel.name]));
  if (locations.size !== data.locations.length || vessels.size !== data.vessels.length) throw new InboundTrackingProviderError("INVALID_RESPONSE", "SeaRates returned duplicate location or vessel identities.", false);
  const events: InboundTrackingEvent[] = [];
  const seen = new Set<string>();
  for (const container of [...data.containers].sort((a, b) => a.number.localeCompare(b.number))) {
    if (identity.referenceType === "container" && container.number.trim().toUpperCase() !== identity.reference) throw new InboundTrackingProviderError("REFERENCE_MISMATCH", "SeaRates returned events for another container.", false);
    for (const event of [...container.events].sort((a, b) => a.order_id - b.order_id)) {
      const key = `${container.number}:${event.order_id}`;
      if (seen.has(key)) throw new InboundTrackingProviderError("INVALID_RESPONSE", "SeaRates returned duplicate event identities.", false);
      seen.add(key);
      const location = event.location == null ? null : locations.get(event.location);
      if ((event.location != null && !location) || (event.vessel != null && !vessels.has(event.vessel))) throw new InboundTrackingProviderError("INVALID_RESPONSE", "SeaRates event references missing location or vessel evidence.", false);
      const date = trackingDate(event.date);
      events.push({ key, container: container.number, sequence: event.order_id, description: event.description, code: event.status ?? event.event_code ?? null, dateText: date.dateText, occurredAt: date.instant, timezone: location?.timezone ?? null, actual: event.actual, location: location ? [location.name, location.country_code].filter(Boolean).join(", ") : null, vessel: event.vessel == null ? null : vessels.get(event.vessel) ?? null, voyage: event.voyage ?? null, source: origin(event.is_date_from_sealine), mirrored: container.events_mirrored === true });
    }
  }
  if (events.length > 1_000) throw new InboundTrackingProviderError("RESPONSE_LIMIT", "Tracking history exceeds the supported 1,000-event limit; review this reference.", false);
  const pod = data.route?.pod;
  const arrivalDate = trackingDate(pod?.date);
  const arrivalLocation = pod?.location == null ? null : locations.get(pod.location);
  if (pod?.location != null && !arrivalLocation) throw new InboundTrackingProviderError("INVALID_RESPONSE", "SeaRates arrival references a missing port.", false);
  const ais = data.route_data?.ais;
  const position = ais?.status === "OK" ? ais.data?.last_vessel_position : null;
  const positionInstant = trackingDate(position?.updated_at, true).instant;
  // Route pins may be interpolations. Only actual AIS coordinates with their UTC observation time are exposed as a vessel position.
  const vesselPosition = position?.lat != null && position.lng != null && positionInstant !== null
    ? { latitude: position.lat, longitude: position.lng, observedAt: positionInstant, vessel: ais?.data?.vessel?.name ?? null } : null;
  return inboundTrackingSnapshotSchema.parse({ version: 1, provider: "searates", reference: identity.reference, status: data.metadata.status, statusSource: origin(data.metadata.is_status_from_sealine), sourceUpdatedAt: trackingDate(data.metadata.updated_at, true).instant, latestActualEventAt: latestInstant(events), fromCache: data.metadata.from_cache ?? null, carrierName: data.metadata.sealine_name ?? null, arrival: arrivalDate.dateText === null ? null : { kind: "port", dateText: arrivalDate.dateText, occurredAt: arrivalDate.instant, timezone: arrivalLocation?.timezone ?? null, location: arrivalLocation?.name ?? null, actual: pod?.actual ?? null }, vesselPosition, positionStatus: ais?.status ?? null, events });
}
const parcelPayloadSchema = z.object({
  tracking_number: providerText, carrier_code: optionalText, status_code: providerText, status_description: optionalText,
  estimated_delivery_date: dateTextSchema.nullish(), actual_delivery_date: dateTextSchema.nullish(),
  events: z.array(z.object({ occurred_at: dateTextSchema, description: providerText, city_locality: optionalText, state_province: optionalText, country_code: optionalText, event_code: optionalText, status_code: optionalText })).max(1_000),
});
export function parseShipStationInboundTracking(payload: unknown, identity: InboundTrackingIdentity): InboundTrackingSnapshot {
  const parsed = parcelPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new InboundTrackingProviderError("INVALID_RESPONSE", "ShipStation returned tracking data outside the supported contract.", false);
  const data = parsed.data;
  if (data.tracking_number.trim().toUpperCase() !== identity.reference) throw new InboundTrackingProviderError("REFERENCE_MISMATCH", "ShipStation response does not match the saved tracking number.", false);
  const reportedCarrier = data.carrier_code?.trim().toLowerCase();
  // The official track-by-number example requests stamps_com and reports usps.
  const documentedAlias = identity.carrierCode === "stamps_com" && reportedCarrier === "usps";
  if (reportedCarrier && reportedCarrier !== identity.carrierCode && !documentedAlias) throw new InboundTrackingProviderError("CARRIER_MISMATCH", "ShipStation response does not match the saved carrier.", false);
  const unique = new Map<string, InboundTrackingEvent>();
  for (const event of data.events) {
    const date = trackingDate(event.occurred_at);
    if (date.instant === null) throw new InboundTrackingProviderError("INVALID_RESPONSE", "ShipStation event has no UTC offset.", false);
    const location = [event.city_locality, event.state_province, event.country_code].filter(Boolean).join(", ") || null;
    const key = createHash("sha256").update(JSON.stringify([date.instant, event.event_code ?? event.status_code ?? null, event.description, location])).digest("hex");
    unique.set(key, { key, container: null, sequence: 0, description: event.description, code: event.status_code ?? event.event_code ?? null, dateText: date.dateText, occurredAt: date.instant, timezone: null, actual: true, location, vessel: null, voyage: null, source: "carrier", mirrored: false });
  }
  const events = [...unique.values()].sort((a, b) => a.occurredAt!.localeCompare(b.occurredAt!) || a.key.localeCompare(b.key)).map((event, sequence) => ({ ...event, sequence }));
  const actualArrival = trackingDate(data.actual_delivery_date);
  const arrival = trackingDate(data.actual_delivery_date ?? data.estimated_delivery_date);
  const latestActualEventAt = [latestInstant(events), actualArrival.instant].filter((value): value is string => value !== null).sort().at(-1) ?? null;
  return inboundTrackingSnapshotSchema.parse({ version: 1, provider: "shipstation", reference: identity.reference, status: data.status_description || data.status_code, statusSource: "carrier", sourceUpdatedAt: null, latestActualEventAt, fromCache: null, carrierName: identity.carrierCode, arrival: arrival.dateText === null ? null : { kind: "carrier_destination", dateText: arrival.dateText, occurredAt: arrival.instant, timezone: null, location: null, actual: Boolean(data.actual_delivery_date) }, vesselPosition: null, positionStatus: null, events });
}

export const TRACKING_SUCCESS_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const TRACKING_MINIMUM_REFRESH_MS = 5 * 60 * 1_000;
export const TRACKING_LEASE_MS = 60 * 1_000;
export function trackingRetryDelay(failureCount: number, retryAfterMs: number | null): number {
  if (!Number.isSafeInteger(failureCount) || failureCount < 1) throw new Error("failureCount must be a positive safe integer");
  if (retryAfterMs !== null && (!Number.isFinite(retryAfterMs) || retryAfterMs < 0)) throw new Error("retryAfterMs must be null or a finite nonnegative delay");
  const backoff = Math.min(24 * 60 * 60 * 1_000, TRACKING_MINIMUM_REFRESH_MS * 2 ** Math.min(failureCount - 1, 9));
  return Math.max(backoff, Math.min(24 * 60 * 60 * 1_000, retryAfterMs ?? 0));
}
