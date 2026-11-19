import { describe, expect, it, vi } from "vitest";
import { createSavedLabelStatusSource } from "../../saved-label-status.source";

const now = new Date("2026-10-30T12:00:00Z");
const source = {
  kind: "return" as const,
  sourceId: 1,
  providerReference: "se-987",
  trackingNumber: "SYNTHETIC-RETURN-1",
};
const saved = {
  labelId: "se-987",
  shipmentId: "se-765",
  externalShipmentId: "return-test-1",
  carrierId: "se-123",
  serviceCode: "ups_ground",
  trackingNumber: source.trackingNumber,
  amountCents: 503,
  currency: "USD",
  downloadUrl: "https://api.shipstation.com/v2/downloads/test/label.pdf",
  labelFormat: "pdf",
  createdAt: now.toISOString(),
};
function fixture() {
  const label = {
    label_id: saved.labelId,
    shipment_id: saved.shipmentId,
    carrier_id: saved.carrierId,
    service_code: saved.serviceCode,
    tracking_number: saved.trackingNumber,
    is_return_label: true,
    voided: false,
    voided_at: null as string|null,
    status: "completed",
  };
  const carrier = { carrier_id: saved.carrierId, carrier_code: "ups" };
  const snapshot = {
    label_id: saved.labelId,
    tracking_number: saved.trackingNumber,
    carrier_code: "ups",
    status_code: "NY",
  };
  const query = vi.fn(async () => ({
    rows: [{ result_snapshot: saved, physically_received: false }],
  }));
  const request = vi.fn<typeof fetch>(async (target, options) => {
    const url = new URL(String(target));
    expect(url.origin).toBe("https://api.shipstation.com");
    expect(options).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
    });
    expect(new Headers(options?.headers).get("API-Key")).toBe(
      "synthetic-status-key",
    );
    if (url.pathname === "/v2/labels/se-987") return Response.json(label);
    if (url.pathname === "/v2/carriers/se-123") return Response.json(carrier);
    if (url.pathname === "/v2/labels/se-987/track")
      return Response.json(snapshot);
    throw new Error("No synthetic provider fallback");
  });
  return {
    label,
    carrier,
    snapshot,
    query,
    request,
    reader: createSavedLabelStatusSource({
      pool: { query } as never,
      now: () => new Date(now),
      v2Key: "synthetic-status-key",
      request,
    }),
  };
}
describe("exact saved-label tracking HTTP contracts", () => {
  it("uses the verified V2 label endpoint and provider carrier account without guessing a carrier from tracking text", async () => {
    const s = fixture();
    expect(await s.reader.read(source)).toMatchObject({
      facts: {
        providerReference: "se-987",
        direction: "return",
        carrierCode: "ups",
      },
      snapshot: { status_code: "NY" },
    });
    expect(s.request).toHaveBeenCalledTimes(3);
    expect(s.query).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("physically_received"),
      [1],
    );
  });
  it("stops at confirmed mixed-box receipt without any carrier request", async () => {
    const s = fixture();
    s.query.mockResolvedValue({
      rows: [{ result_snapshot: saved, physically_received: true }],
    });
    expect(await s.reader.read(source)).toEqual({ finished: true });
    expect(s.request).not.toHaveBeenCalled();
  });
  it.each([
    "label_id",
    "shipment_id",
    "carrier_id",
    "tracking_number",
  ] as const)("rejects a substituted %s from the provider", async (field) => {
    const s = fixture();
    s.label[field] = "se-another";
    await expect(s.reader.read(source)).rejects.toMatchObject({
      code: "SAVED_LABEL_STATUS_IDENTITY_MISMATCH",
      retryable: false,
    });
    expect(s.request).toHaveBeenCalledTimes(1);
  });
  it("rejects another carrier account and a return label misclassified as outbound", async () => {
    const s = fixture();
    s.carrier.carrier_id = "se-another";
    await expect(s.reader.read(source)).rejects.toMatchObject({
      code: "SAVED_LABEL_STATUS_IDENTITY_MISMATCH",
      retryable: false,
    });
    const other = fixture();
    other.label.is_return_label = false;
    await expect(other.reader.read(source)).rejects.toMatchObject({
      code: "SAVED_LABEL_STATUS_IDENTITY_MISMATCH",
      retryable: false,
    });
  });
  it("rejects tracking data for another label or package", async () => {
    for (const field of ["label_id", "tracking_number"] as const) {
      const s = fixture();
      s.snapshot[field] = "se-another";
      await expect(s.reader.read(source)).rejects.toMatchObject({
        code: "SAVED_LABEL_STATUS_TRACKING_MISMATCH",
        retryable: false,
      });
    }
  });
  it("does not mistake a provider outage for missing or completed tracking", async () => {
    const s = fixture();
    s.request.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(s.reader.read(source)).rejects.toMatchObject({
      code: "SAVED_LABEL_STATUS_HTTP_503",
      retryable: true,
    });
  });
  it("does not read a mismatched saved source, even when receipt was confirmed", async () => {
    const s = fixture();
    await expect(
      s.reader.read({ ...source, providerReference: "se-another" }),
    ).rejects.toMatchObject({
      code: "SAVED_LABEL_STATUS_SOURCE_CHANGED",
      retryable: false,
    });
    expect(s.request).not.toHaveBeenCalled();
  });  it("retains the actual provider void timestamp and never fabricates one",async()=>{
    const s=fixture();s.label.voided=true;s.label.status="voided";
    await expect(s.reader.read(source)).rejects.toMatchObject({code:"SAVED_LABEL_STATUS_VOID_TIME_UNAVAILABLE",retryable:true});
    const providerTime="2026-10-29T09:30:00Z";s.label.voided_at=providerTime;
    expect(await s.reader.read(source)).toMatchObject({facts:{voided:true,voidedAt:providerTime},snapshot:null});
  });

});
