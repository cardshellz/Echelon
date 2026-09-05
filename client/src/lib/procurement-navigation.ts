/** Navigation metadata only: these references never authorize or reparent records. */
export type ProcurementRecordKind = "purchase" | "shipment" | "invoice" | "receipt";

export interface ProcurementRecord {
  kind: ProcurementRecordKind;
  id: number;
  tab: string;
}

export interface ProcurementJourney {
  purchase: ProcurementRecord | null;
  trail: ProcurementRecord[];
}

const TABS: Record<ProcurementRecordKind, readonly string[]> = {
  purchase: ["lines", "receipts", "invoices", "payments", "shipments", "exceptions", "history"],
  shipment: ["lines", "costs", "allocation", "invoices", "timeline"],
  invoice: ["lines", "details", "attachments"],
  receipt: ["detail"],
};
// Bound copied URLs even when users follow cycles through shared documents.
const MAX_TRAIL_DEPTH = 12;
const MAX_SEARCH_LENGTH = 8192;
const LIST_PATHS = ["/purchase-orders", "/shipments", "/ap-invoices", "/receiving"];

function positiveId(value: string | null): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

export function parseProcurementRecord(path: string, search: string): ProcurementRecord | null {
  if (search.length > MAX_SEARCH_LENGTH) return null;
  const params = new URLSearchParams(search);
  const match = /^(\/purchase-orders|\/shipments|\/ap-invoices)\/([1-9]\d*)$/.exec(path);
  const kind: ProcurementRecordKind | null = path === "/receiving" ? "receipt"
    : match?.[1] === "/purchase-orders" ? "purchase"
    : match?.[1] === "/shipments" ? "shipment"
    : match?.[1] === "/ap-invoices" ? "invoice" : null;
  const id = positiveId(kind === "receipt" ? single(params, "open") : match?.[2] ?? null);
  if (!kind || id === null) return null;
  const tab = single(params, "tab");
  return { kind, id, tab: tab && TABS[kind].includes(tab) ? tab : TABS[kind][0] };
}

function encodeReference(record: ProcurementRecord): string {
  return `${record.kind}:${record.id}:${record.tab}`;
}

function decodeReference(value: string | null): ProcurementRecord | null {
  if (!value) return null;
  const parts = value.split(":");
  if (parts.length !== 3 || !Object.prototype.hasOwnProperty.call(TABS, parts[0])) return null;
  const kind = parts[0] as ProcurementRecordKind;
  const id = positiveId(parts[1]);
  return id !== null && TABS[kind].includes(parts[2]) ? { kind, id, tab: parts[2] } : null;
}

export function parseProcurementJourney(search: string): ProcurementJourney {
  if (search.length > MAX_SEARCH_LENGTH) return { purchase: null, trail: [] };
  const params = new URLSearchParams(search);
  const anchor = decodeReference(single(params, "purchase"));
  const values = params.getAll("via");
  const trail = values.map(decodeReference);
  return {
    purchase: anchor?.kind === "purchase" ? anchor : null,
    trail: values.length <= MAX_TRAIL_DEPTH && trail.every((record) => record !== null)
      ? trail as ProcurementRecord[] : [],
  };
}

export function procurementRecordHref(record: ProcurementRecord, journey?: ProcurementJourney): string {
  const params = new URLSearchParams();
  const path = record.kind === "purchase" ? `/purchase-orders/${record.id}`
    : record.kind === "shipment" ? `/shipments/${record.id}`
    : record.kind === "invoice" ? `/ap-invoices/${record.id}` : "/receiving";
  if (record.kind === "receipt") params.set("open", String(record.id));
  else params.set("tab", record.tab);
  if (journey?.purchase) params.set("purchase", encodeReference(journey.purchase));
  for (const parent of journey?.trail ?? []) params.append("via", encodeReference(parent));
  return `${path}?${params.toString()}`;
}

export function procurementRecordLabel(record: ProcurementRecord): string {
  const label = { purchase: "purchase", shipment: "shipment", invoice: "invoice", receipt: "receipt" }[record.kind];
  return `${label} #${record.id}`;
}

export function procurementChildHref(
  path: string,
  search: string,
  destination: string,
  options: { replaceCurrent?: boolean } = {},
): string {
  const separator = destination.indexOf("?");
  const target = parseProcurementRecord(separator < 0 ? destination : destination.slice(0, separator), separator < 0 ? "" : destination.slice(separator + 1));
  // Callers provide known internal document routes, never arbitrary return URLs.
  if (!target) throw new Error("Invalid procurement document destination");
  const current = parseProcurementRecord(path, search);
  const journey = parseProcurementJourney(search);
  const purchase = journey.purchase ?? (current?.kind === "purchase" ? current : null);
  const trail = current && !options.replaceCurrent ? [...journey.trail, current] : journey.trail;
  return procurementRecordHref(target, { purchase, trail: trail.slice(-MAX_TRAIL_DEPTH) });
}

export function procurementBackHref(search: string, fallback: string): string {
  const journey = parseProcurementJourney(search);
  const parent = journey.trail.at(-1);
  if (parent) return procurementRecordHref(parent, { ...journey, trail: journey.trail.slice(0, -1) });
  if (journey.purchase) return procurementRecordHref(journey.purchase);
  if (LIST_PATHS.includes(fallback)) return fallback;
  const separator = fallback.indexOf("?");
  const record = parseProcurementRecord(separator < 0 ? fallback : fallback.slice(0, separator), separator < 0 ? "" : fallback.slice(separator + 1));
  return record ? procurementRecordHref(record) : "/purchase-orders";
}

export function procurementTabHref(path: string, search: string, tab: string): string | null {
  const current = parseProcurementRecord(path, search);
  if (!current || !TABS[current.kind].includes(tab)) return null;
  const params = new URLSearchParams(search);
  params.set("tab", tab);
  return `${path}?${params.toString()}`;
}
