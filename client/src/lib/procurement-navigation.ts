import { MAX_WORKSPACE_TRAIL, parsePurchaseWorkspaceSelection, parseWorkspaceRef, workspaceRefKey, type ProcurementWorkspaceRef } from "./purchase-workspace-selection";
import { shipmentListSearch } from "./shipment-list-navigation";

/** Navigation metadata only: these references never authorize or reparent records. */
export type ProcurementRecordKind = "purchase" | "shipment" | "invoice" | "receipt" | "credit" | "supplier-return";

export interface ProcurementRecord {
  kind: ProcurementRecordKind;
  id: number;
  tab: string;
  relationship?: { po: number | "all" | null; line: number | null };
  label?: string;
  workspace?: { selected: ProcurementWorkspaceRef; trail: ProcurementWorkspaceRef[] };
}

// Opening an editor is navigation only; the amendment service still owns approval.
export const PO_EDITOR_QUERY_PARAM = "editPo";
export const INVOICE_CORRECTION_QUERY_PARAM = "correctLine";
export const INVOICE_COST_QUERY_PARAM = "costLine";
export const SHIPMENT_COST_REPAIR_QUERY_PARAM = "repairCostLinks";
export interface ProcurementChildNavigationOptions {
  currentLabel?: string;
  currentRelationship?: ProcurementRecord["relationship"];
  replaceCurrent?: boolean;
  editPo?: boolean;
  invoiceLineCorrectionId?: number;
  invoiceCostLineId?: number;
  shipmentCostRepairLineId?: number;
}

export interface ProcurementJourney {
  purchase: ProcurementRecord | null;
  trail: ProcurementRecord[];
  shipmentList?: string;
}

const TABS: Record<ProcurementRecordKind, readonly string[]> = {
  purchase: ["lines", "lifecycle", "receipts", "invoices", "payments", "shipments", "exceptions", "history"],
  shipment: ["lines", "costs", "allocation", "invoices", "timeline", "tracking"],
  invoice: ["lines", "details", "attachments"],
  receipt: ["detail"],
  credit: ["details"],
  "supplier-return": ["details"],
};
// Bound copied URLs even when users follow cycles through shared documents.
const MAX_TRAIL_DEPTH = 12;
const MAX_SEARCH_LENGTH = 8192;
const LIST_PATHS = ["/purchase-orders", "/shipments", "/ap-invoices", "/receiving", "/supplier-credits", "/supplier-returns"];

function positiveId(value: string | null): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function relationshipMetadata(params: URLSearchParams): Pick<ProcurementRecord, "relationship" | "label"> {
  const po = single(params, "poScope");
  const line = positiveId(single(params, "shipmentLine"));
  const poId = po === "all" ? "all" : positiveId(po);
  const label = single(params, "document");
  return { ...(poId !== null || line !== null ? { relationship: { po: poId, line } } : {}),
    ...(label && /^[A-Za-z0-9 #._/-]{1,80}$/.test(label) ? { label } : {}) };
}

export function parseProcurementRecord(path: string, search: string): ProcurementRecord | null {
  if (search.length > MAX_SEARCH_LENGTH) return null;
  const params = new URLSearchParams(search);
  const match = /^(\/purchase-orders|\/shipments|\/ap-invoices|\/supplier-credits|\/supplier-returns)\/([1-9]\d*)$/.exec(path);
  const kind: ProcurementRecordKind | null = path === "/receiving" ? "receipt"
    : match?.[1] === "/purchase-orders" ? "purchase"
    : match?.[1] === "/shipments" ? "shipment"
    : match?.[1] === "/ap-invoices" ? "invoice"
    : match?.[1] === "/supplier-credits" ? "credit"
    : match?.[1] === "/supplier-returns" ? "supplier-return" : null;
  const id = positiveId(kind === "receipt" ? single(params, "open") : match?.[2] ?? null);
  if (!kind || id === null) return null;
  const tab = single(params, "tab");
  const selectedTab = tab && TABS[kind].includes(tab) ? tab : TABS[kind][0];
  const workspace = parsePurchaseWorkspaceSelection(search);
  return {
    kind, id, tab: selectedTab, ...relationshipMetadata(params),
    ...(kind === "purchase" && selectedTab === "lifecycle" && workspace.selected && !workspace.invalid
      ? { workspace: { selected: workspace.selected, trail: workspace.trail } } : {}),
  };
}

function encodeReference(record: ProcurementRecord): string {
  const base = `${record.kind}:${record.id}:${record.tab}`;
  const reference = record.workspace && record.kind === "purchase" && record.tab === "lifecycle"
    ? [base, workspaceRefKey(record.workspace.selected), ...record.workspace.trail.map(workspaceRefKey)].join("~") : base;
  const metadata = new URLSearchParams();
  if (record.relationship?.po !== null && record.relationship?.po !== undefined) metadata.set("poScope", String(record.relationship.po));
  if (record.relationship?.line) metadata.set("shipmentLine", String(record.relationship.line));
  if (record.label) metadata.set("document", record.label);
  return metadata.size ? `${reference}!${metadata}` : reference;
}

function decodeReference(value: string | null): ProcurementRecord | null {
  if (!value) return null;
  const [reference, metadata, extra] = value.split("!");
  if (extra !== undefined) return null;
  const [base, ...workspaceParts] = reference.split("~");
  const parts = base.split(":");
  if (parts.length !== 3 || !Object.prototype.hasOwnProperty.call(TABS, parts[0])) return null;
  const kind = parts[0] as ProcurementRecordKind;
  const id = positiveId(parts[1]);
  if (id === null || !TABS[kind].includes(parts[2])) return null;
  const record: ProcurementRecord = { kind, id, tab: parts[2], ...relationshipMetadata(new URLSearchParams(metadata)) };
  if (workspaceParts.length === 0) return record;
  if (kind !== "purchase" || record.tab !== "lifecycle" || workspaceParts.length > MAX_WORKSPACE_TRAIL + 1) return null;
  const refs = workspaceParts.map(parseWorkspaceRef);
  if (refs.some((ref) => ref === null)) return null;
  record.workspace = { selected: refs[0]!, trail: refs.slice(1) as ProcurementWorkspaceRef[] };
  return record;
}

export function parseProcurementJourney(search: string): ProcurementJourney {
  if (search.length > MAX_SEARCH_LENGTH) return { purchase: null, trail: [] };
  const params = new URLSearchParams(search);
  const anchor = decodeReference(single(params, "purchase"));
  const values = params.getAll("via");
  const trail = values.map(decodeReference);
  return {
    purchase: anchor?.kind === "purchase" ? anchor : null,
    ...(single(params, "shipmentsReturn") ? { shipmentList: shipmentListSearch(single(params, "shipmentsReturn")!) } : {}),
    trail: values.length <= MAX_TRAIL_DEPTH && trail.every((record) => record !== null)
      ? trail as ProcurementRecord[] : [],
  };
}

export function procurementRecordHref(record: ProcurementRecord, journey?: ProcurementJourney): string {
  const params = new URLSearchParams();
  const path = record.kind === "purchase" ? `/purchase-orders/${record.id}`
    : record.kind === "shipment" ? `/shipments/${record.id}`
    : record.kind === "invoice" ? `/ap-invoices/${record.id}`
    : record.kind === "credit" ? `/supplier-credits/${record.id}`
    : record.kind === "supplier-return" ? `/supplier-returns/${record.id}` : "/receiving";
  if (record.kind === "receipt") params.set("open", String(record.id));
  else params.set("tab", record.tab);
  if (record.relationship?.po !== null && record.relationship?.po !== undefined) params.set("poScope", String(record.relationship.po));
  if (record.relationship?.line) params.set("shipmentLine", String(record.relationship.line));
  if (record.label) params.set("document", record.label);
  if (record.kind === "purchase" && record.tab === "lifecycle" && record.workspace) {
    params.set("inspect", workspaceRefKey(record.workspace.selected));
    for (const ref of record.workspace.trail) params.append("inspectVia", workspaceRefKey(ref));
  }
  if (journey?.purchase) params.set("purchase", encodeReference(journey.purchase));
  if (journey?.shipmentList) params.set("shipmentsReturn", journey.shipmentList);
  for (const parent of journey?.trail ?? []) params.append("via", encodeReference(parent));
  return `${path}?${params.toString()}`;
}

export function procurementRecordLabel(record: ProcurementRecord): string {
  if (record.label) return record.label;
  const label = { purchase: "purchase", shipment: "shipment", invoice: "invoice", receipt: "receipt", credit: "supplier credit", "supplier-return": "supplier return" }[record.kind];
  return `${label} #${record.id}`;
}

export function procurementChildHref(
  path: string,
  search: string,
  destination: string,
  options: ProcurementChildNavigationOptions = {},
): string {
  const separator = destination.indexOf("?");
  const target = parseProcurementRecord(separator < 0 ? destination : destination.slice(0, separator), separator < 0 ? "" : destination.slice(separator + 1));
  // Callers provide known internal document routes, never arbitrary return URLs.
  if (!target) throw new Error("Invalid procurement document destination");
  const current = parseProcurementRecord(path, search);
  if (current && options.currentLabel) {
    const metadata = new URLSearchParams({ document: options.currentLabel });
    current.label = relationshipMetadata(metadata).label;
  }
  if (current && options.currentRelationship) {
    const { po, line } = options.currentRelationship;
    const metadata = new URLSearchParams({ ...(po !== null ? { poScope: String(po) } : {}), ...(line !== null ? { shipmentLine: String(line) } : {}) });
    current.relationship = relationshipMetadata(metadata).relationship;
  }
  const journey = parseProcurementJourney(search);
  const purchase = journey.purchase ?? (current?.kind === "purchase" ? current : null);
  const trail = current && !options.replaceCurrent ? [...journey.trail, current] : journey.trail;
  const href = procurementRecordHref(target, { purchase, trail: trail.slice(-MAX_TRAIL_DEPTH),
    shipmentList: path === "/shipments" ? shipmentListSearch(search) : journey.shipmentList });
  if (options.shipmentCostRepairLineId !== undefined) {
    const lineId = options.shipmentCostRepairLineId;
    if (target.kind !== "shipment" || options.editPo || options.invoiceCostLineId !== undefined || options.invoiceLineCorrectionId !== undefined
      || !Number.isSafeInteger(lineId) || lineId <= 0 || lineId > 2_147_483_647) throw new Error("Cost-link repair requires a valid shipment line destination");
    return `${href}&${SHIPMENT_COST_REPAIR_QUERY_PARAM}=${lineId}`;
  }
  if (options.invoiceCostLineId !== undefined) {
    const lineId = options.invoiceCostLineId;
    if (target.kind !== "invoice" || options.editPo || options.invoiceLineCorrectionId !== undefined
      || !Number.isSafeInteger(lineId) || lineId <= 0 || lineId > 2_147_483_647) throw new Error("Cost review requires a valid invoice line destination");
    return `${href}&${INVOICE_COST_QUERY_PARAM}=${lineId}`;
  }
  if (options.editPo) {
    if (target.kind !== "purchase" || options.invoiceLineCorrectionId !== undefined) throw new Error("The PO editor requires a purchase order destination");
    return `${href}&${PO_EDITOR_QUERY_PARAM}=1`;
  }
  if (options.invoiceLineCorrectionId !== undefined) {
    const lineId = options.invoiceLineCorrectionId;
    if (target.kind !== "invoice" || !Number.isSafeInteger(lineId) || lineId <= 0 || lineId > 2_147_483_647) throw new Error("Invoice correction requires a valid invoice line destination");
    return `${href}&${INVOICE_CORRECTION_QUERY_PARAM}=${lineId}`;
  }
  return href;
}

/** Preserve the same document trail when entering a supported work list. */
export function procurementListChildHref(path: string, search: string, destination: string): string {
  const separator = destination.indexOf("?");
  const listPath = separator < 0 ? destination : destination.slice(0, separator);
  if (!LIST_PATHS.includes(listPath)) throw new Error("Invalid procurement list destination");
  const params = new URLSearchParams(separator < 0 ? "" : destination.slice(separator + 1));
  const journey = parseProcurementJourney(search);
  const current = parseProcurementRecord(path, search);
  const purchase = journey.purchase ?? (current?.kind === "purchase" ? current : null);
  params.delete("purchase"); params.delete("via");
  if (purchase) params.set("purchase", encodeReference(purchase));
  if (journey.shipmentList) params.set("shipmentsReturn", journey.shipmentList);
  for (const record of [...journey.trail, ...(current ? [current] : [])].slice(-MAX_TRAIL_DEPTH)) params.append("via", encodeReference(record));
  return `${listPath}${params.size ? `?${params}` : ""}`;
}

export function procurementBackHref(search: string, fallback: string): string {
  const journey = parseProcurementJourney(search);
  const parent = journey.trail.at(-1);
  if (parent) return procurementRecordHref(parent, { ...journey, trail: journey.trail.slice(0, -1) });
  if (journey.shipmentList) return `/shipments?${journey.shipmentList}`;
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
