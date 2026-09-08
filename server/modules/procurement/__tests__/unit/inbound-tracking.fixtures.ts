import type { InboundTrackingConfig } from "@shared/procurement/inbound-tracking";
export const oceanConfig: InboundTrackingConfig = { identity: { provider: "searates", referenceType: "container", reference: "TEST1234567", carrierCode: "" }, enabled: true, includeVesselPosition: true };
export const parcelConfig: InboundTrackingConfig = { identity: { provider: "shipstation", referenceType: "parcel", reference: "1ZTEST123", carrierCode: "ups" }, enabled: true, includeVesselPosition: false };
// Fictional payloads following provider contracts; no account data or live calls.
export function oceanPayload() {
  return { status: "success", data: {
    metadata: { number: "TEST1234567", type: "CT", status: "IN_TRANSIT", sealine_name: "Fixture ocean line", is_status_from_sealine: true, updated_at: "2026-09-07 10:00:00", from_cache: true },
    locations: [{ id: 1, name: "Origin port", country_code: "CN", timezone: "Asia/Shanghai" }, { id: 2, name: "Destination port", country_code: "US", timezone: "America/New_York" }],
    vessels: [{ id: 1, name: "Fixture vessel" }],
    containers: [{ number: "TEST1234567", events_mirrored: false, events: [
      { order_id: 1, location: 1, description: "Vessel departed", status: "VDL", date: "2026-09-01 09:30:00", actual: true, is_date_from_sealine: true, vessel: 1, voyage: "TEST-01" },
      { order_id: 2, location: 2, description: "Vessel arrival", status: "VAD", date: "2026-10-01 08:00:00", actual: false, is_date_from_sealine: false, vessel: 1, voyage: "TEST-01" },
    ] }],
    route: { pod: { location: 2, date: "2026-10-01 08:00:00", actual: false } },
    route_data: { ais: { status: "OK", data: { vessel: { name: "Fixture vessel" }, last_vessel_position: { lat: 0, lng: -10.5, updated_at: "2026-09-07 09:00:00" } } } },
  } };
}
export function parcelPayload() { return { tracking_number: "1ZTEST123", status_code: "DE", status_description: "Delivered", estimated_delivery_date: null, actual_delivery_date: "2026-09-07T09:00:00Z", events: [{ occurred_at: "2026-09-07T09:00:00Z", description: "Delivered to destination", city_locality: "Fixture City", state_province: "NY", country_code: "US", event_code: "01", status_code: "DE" }] }; }
