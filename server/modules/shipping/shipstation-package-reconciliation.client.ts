import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { readBoundedResponseText } from "./shipstation-tracking-http";
import { PackageReconciliationError, packageProviderProofSchema, type PackageProviderProof, type PackageReconciliationSnapshot } from "../oms/package-reconciliation.repository";

const positiveId = z.number().int().positive().safe();
const itemSchema = z.object({ lineItemKey: z.string(), sku: z.string().nullable().optional(), quantity: z.number().int().positive().max(2_147_483_647) }).passthrough();
const shipmentSchema = z.object({ shipmentId: positiveId, orderId: positiveId, orderKey: z.string().nullable(), trackingNumber: z.string().min(1),
  voided: z.boolean(), isReturnLabel: z.boolean(), carrierCode: z.string().min(1), serviceCode: z.string().nullable(), shipmentItems: z.array(itemSchema).min(1).max(500) }).passthrough();
const orderSchema = z.object({ orderId: positiveId, orderKey: z.string().nullable(), advancedOptions: z.object({
  mergedIds: z.array(positiveId).max(100).nullable().optional(), parentId: positiveId.nullable().optional(),
}).passthrough().nullable().optional() }).passthrough();
export interface ShipStationPackageReconciliationClient {
  load(snapshot: PackageReconciliationSnapshot): Promise<PackageProviderProof>;
}
export function createShipStationPackageReconciliationClient(config: {
  apiKey: string; apiSecret: string; fetch?: typeof fetch; clock?: () => Date; sleep?: (milliseconds: number) => Promise<void>;
  minimumIntervalMs?: number; baseUrl?: string;
}): ShipStationPackageReconciliationClient {
  const credential = z.string().min(1).refine(value => value.trim() === value);
  const key = credential.parse(config.apiKey), secret = credential.parse(config.apiSecret);
  const base = new URL(config.baseUrl ?? "https://ssapi.shipstation.com");
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new PackageReconciliationError("PROVIDER_CONFIGURATION", "ShipStation reconciliation requires a clean HTTPS base URL");
  const request = config.fetch ?? fetch;
  const clock = config.clock ?? (() => new Date());
  const sleep = config.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const interval = z.number().int().min(0).max(10_000).parse(config.minimumIntervalMs ?? 1_100);
  let nextAt = 0;
  const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
  async function get(path: string, allowNotFound = false): Promise<unknown | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = nextAt - clock().getTime(); if (wait > 0) await sleep(wait);
      nextAt = clock().getTime() + interval;
      let response: Response;
      try { response = await request(new URL(path, base).href, { method: "GET", headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}` }, signal: AbortSignal.timeout(20_000) }); }
      catch { throw new PackageReconciliationError("PROVIDER_READ_FAILED", "The authenticated ShipStation evidence read failed"); }
      if (allowNotFound && response.status === 404) return null;
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.body?.cancel();
        const seconds = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(seconds) && seconds > 0 ? Math.min(30_000, Math.ceil(seconds * 1_000)) : 2_000 * (attempt + 1));
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new PackageReconciliationError("PROVIDER_READ_FAILED", "ShipStation rejected an evidence read", { status: response.status }); }
      try { return JSON.parse(await readBoundedResponseText(response, 2_000_000)); }
      catch { throw new PackageReconciliationError("PROVIDER_READ_INVALID", "ShipStation evidence response was malformed or exceeded its bound"); }
    }
    throw new PackageReconciliationError("PROVIDER_READ_FAILED", "ShipStation evidence retry limit reached");
  }
  return { async load(snapshot) {
    const labels: PackageProviderProof["labels"] = [];
    for (const evidence of snapshot.evidence) {
      const persisted = evidence.label;
      if (!persisted) throw new PackageReconciliationError("PROVIDER_IDENTITY_MISSING", "Persisted label identity is missing");
      const payload = z.object({ shipments: z.array(shipmentSchema).max(2) }).passthrough().parse(await get(`/shipments?${new URLSearchParams({ shipmentId: persisted.provider_label_id, includeShipmentItems: "true" })}`));
      if (payload.shipments.length !== 1) throw new PackageReconciliationError("PROVIDER_SHIPMENT_NOT_UNIQUE", "Exact provider shipment query did not return exactly one package");
      const shipment = payload.shipments[0];
      if (String(shipment.shipmentId) !== persisted.provider_label_id || String(shipment.orderId) !== persisted.provider_order_id
        || shipment.orderKey !== persisted.provider_order_key || shipment.trackingNumber !== persisted.tracking_number || shipment.isReturnLabel) {
        throw new PackageReconciliationError("PROVIDER_IDENTITY_CHANGED", "Exact shipment does not match the selected canonical label");
      }
      const contents = shipment.shipmentItems.map(item => {
        const sourceId = Number(/^wms-item-([1-9]\d*)$/.exec(item.lineItemKey)?.[1]);
        const source = snapshot.sources.find(source => source.id === sourceId);
        if (!source || (item.sku != null && item.sku !== source.sku)) throw new PackageReconciliationError("PROVIDER_SOURCE_IDENTITY_CHANGED", "Exact provider source key or SKU does not match its canonical order line");
        return { sourceItemId: sourceId, quantity: item.quantity };
      }).sort((a, b) => a.sourceItemId - b.sourceItemId);
      const value = { labelId: Number(persisted.id), providerLabelId: String(shipment.shipmentId), providerOrderId: String(shipment.orderId),
        providerOrderKey: shipment.orderKey, trackingNumber: shipment.trackingNumber, carrier: shipment.carrierCode, serviceCode: shipment.serviceCode,
        outbound: true as const, status: shipment.voided ? "voided" as const : "active" as const, contents };
      labels.push({ ...value, evidenceHash: hash(value) });
    }
    const relationships: PackageProviderProof["relationships"] = [];
    for (const providerOrderId of [...new Set(labels.map(label => label.providerOrderId))].sort()) {
      const rawOrder = await get(`/orders/${encodeURIComponent(providerOrderId)}`, true);
      if (rawOrder !== null) {
        const order = orderSchema.parse(rawOrder);
        if (String(order.orderId) !== providerOrderId) throw new PackageReconciliationError("PROVIDER_ORDER_IDENTITY_CHANGED", "Provider order read returned a different identity");
        const value = { providerOrderId, mergedProviderOrderIds: (order.advancedOptions?.mergedIds ?? []).map(String).sort(),
          parentProviderOrderId: order.advancedOptions?.parentId == null ? null : String(order.advancedOptions.parentId) };
        relationships.push({ ...value, evidenceHash: hash(value) });
      }
      // Lists prove label membership only. In V1 a merged order's list can show
      // its new contents on an old voided label. Exact shipment reads above own
      // package contents; never feed that mutable list back as a new manifest.
      const listedIds=new Set<number>();let declaredTotal:number|null=null;
      for (let page = 1; ; page++) {
        if (page > 10) throw new PackageReconciliationError("PROVIDER_ORDER_READ_INCOMPLETE", "Provider order package listing exceeded its page bound");
        const listing = z.object({ shipments: z.array(z.object({ shipmentId: positiveId }).passthrough()).max(100),
          pages: z.number().int().nonnegative(), page: z.number().int().positive(), total: z.number().int().nonnegative() }).passthrough()
          .parse(await get(`/shipments?${new URLSearchParams({ orderId: providerOrderId, page: String(page), pageSize: "100", includeShipmentItems: "false" })}`));
        if (listing.page !== page || listing.shipments.some(item => !labels.some(label => label.providerLabelId === String(item.shipmentId)))) {
          throw new PackageReconciliationError("PROVIDER_PACKAGE_SCOPE_INCOMPLETE", "A provider order has an undiscovered package; ingest its evidence before reconciling");
        }
        if(declaredTotal!==null&&declaredTotal!==listing.total)throw new PackageReconciliationError("PROVIDER_ORDER_READ_INCOMPLETE","Provider package listing changed during pagination");
        declaredTotal=listing.total;
        for(const item of listing.shipments){if(listedIds.has(item.shipmentId))throw new PackageReconciliationError("PROVIDER_ORDER_READ_INCOMPLETE","Provider package listing repeated a shipment");listedIds.add(item.shipmentId);}
        if (page >= listing.pages) break;
      }
      if(listedIds.size!==declaredTotal||labels.filter(label=>label.providerOrderId===providerOrderId).some(label=>!listedIds.has(Number(label.providerLabelId))))
        throw new PackageReconciliationError("PROVIDER_ORDER_READ_INCOMPLETE","Provider package listing did not cover the exact complete order scope");
    }
    return packageProviderProofSchema.parse({ labels, relationships, observedAt: clock().toISOString() });
  } };
}
