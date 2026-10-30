import { z } from "zod";
import { createShipStationReturnLabelAdapter } from "../../../shipping-engine/infrastructure/shipstation-return-label.adapter";

const address = z.object({ phone: z.string().trim().min(1) }).passthrough();
const shipment = z.object({ external_shipment_id: z.string(), carrier_id: z.string(), service_code: z.string(),
  ship_from: address, ship_to: address, packages: z.array(z.record(z.unknown())).length(1) }).passthrough();
const request = z.object({ is_return_label: z.literal(true), rma_number: z.string(), shipment }).passthrough();
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** Real adapter at an HTTP fixture boundary. No network fallback is possible.
 * Reject missing contact data just as the upstream validation failure did. */
export function shipStationReturnWorkflowFixture(now: () => Date) {
  const calls: Array<{ method: string; path: string; externalShipmentId?: string }> = [];
  const savedLabels = new Map<string, Record<string, unknown>>();
  const savedShipments = new Map<string, Record<string, unknown>>();
  let sequence = 1000, loseNextReply = false;
  const fetchFn: typeof fetch = async (target, options) => {
    const url = new URL(String(target));
    if (url.origin !== "https://api.shipstation.com") throw new Error("Unexpected fixture origin");
    const method = options?.method ?? "GET";
    calls.push({ method, path: url.pathname });
    if (method === "POST" && url.pathname === "/v2/labels") {
      const parsed = request.safeParse(JSON.parse(String(options?.body)));
      if (!parsed.success) return new Response(JSON.stringify({ errors: [{ error_code: "validation", message: "phone must not be empty" }] }), { status: 400 });
      const body = parsed.data, id = ++sequence, labelId = `se-${id}`, shipmentId = `se-${id + 1000}`;
      calls[calls.length - 1].externalShipmentId = body.shipment.external_shipment_id;
      const tracking = `TEST-TRACK-${id}`, pdf = `https://api.shipstation.com/v2/downloads/test/${labelId}.pdf`;
      const label = { label_id: labelId, shipment_id: shipmentId, external_shipment_id: body.shipment.external_shipment_id,
        status: "completed", is_return_label: true, is_international: false, rma_number: body.rma_number,
        carrier_id: body.shipment.carrier_id, service_code: body.shipment.service_code,
        tracking_number: tracking, trackable: true, voided: false, voided_at: null,
        label_format: "pdf", label_layout: "4x6", charge_event: "carrier_default", created_at: now().toISOString(),
        shipment_cost: { currency: "usd", amount: "5.03" }, insurance_cost: { currency: "usd", amount: "0.00" },
        label_download: { pdf, href: pdf }, packages: body.shipment.packages.map(parcel => ({ ...parcel, tracking_number: tracking })) };
      savedLabels.set(labelId, label); savedShipments.set(shipmentId, { ...body.shipment, shipment_id: shipmentId });
      if (loseNextReply) { loseNextReply = false; throw new TypeError("Synthetic lost carrier response"); }
      return json(label);
    }
    if (method === "GET" && url.pathname === "/v2/labels") {
      const matches = [...savedLabels.values()].filter(label => label.external_shipment_id === url.searchParams.get("external_shipment_id"));
      return json({ labels: matches.map(label => ({ label_id: label.label_id, external_shipment_id: label.external_shipment_id })), total: matches.length, page: 1, pages: 1 });
    }
    if (method === "GET" && url.pathname.startsWith("/v2/labels/")) return json(savedLabels.get(url.pathname.split("/").at(-1)!) ?? null);
    if (method === "GET" && url.pathname.startsWith("/v2/shipments/")) return json(savedShipments.get(url.pathname.split("/").at(-1)!) ?? null);
    if (method === "GET" && url.pathname.startsWith("/v2/downloads/test/")) return new Response("%PDF-1.4\nSynthetic return label", { headers: { "content-type": "application/pdf" } });
    throw new Error("Unexpected fixture request");
  };
  return { calls, fetchFn, provider: createShipStationReturnLabelAdapter({ apiKey: "synthetic-workflow-key", fetchFn }),
    loseNextPurchaseReply: () => { loseNextReply = true; } };
}
