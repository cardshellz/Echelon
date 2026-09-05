export interface ProcurementWorkspaceRef {
  kind: "purchase" | "shipment" | "receipt" | "invoice";
  id: number;
}

export interface PurchaseWorkspaceSelection {
  selected: ProcurementWorkspaceRef | null;
  trail: ProcurementWorkspaceRef[];
  invalid: boolean;
}

export const MAX_WORKSPACE_TRAIL = 8;
const MAX_WORKSPACE_SEARCH = 8192;

export function workspaceRefKey(ref: ProcurementWorkspaceRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function parseWorkspaceRef(value: string | null): ProcurementWorkspaceRef | null {
  const match = /^(purchase|shipment|receipt|invoice):([1-9]\d*)$/.exec(value ?? "");
  if (!match) return null;
  const id = Number(match[2]);
  return Number.isSafeInteger(id) ? { kind: match[1] as ProcurementWorkspaceRef["kind"], id } : null;
}

export function parsePurchaseWorkspaceSelection(search: string): PurchaseWorkspaceSelection {
  if (search.length > MAX_WORKSPACE_SEARCH) return { selected: null, trail: [], invalid: true };
  const params = new URLSearchParams(search);
  const selections = params.getAll("inspect");
  const selected = selections.length === 1 ? parseWorkspaceRef(selections[0]) : null;
  const history = params.getAll("inspectVia");
  const parsedHistory = history.map(parseWorkspaceRef);
  return {
    selected,
    invalid: selections.length > 0 && selected === null,
    trail: selected && history.length <= MAX_WORKSPACE_TRAIL && parsedHistory.every((ref) => ref !== null)
      ? parsedHistory as ProcurementWorkspaceRef[] : [],
  };
}

function workspaceHref(path: string, params: URLSearchParams): string {
  const match = /^\/purchase-orders\/([1-9]\d*)$/.exec(path);
  if (!match || !parseWorkspaceRef(`purchase:${match[1]}`)) {
    throw new Error("Invalid purchase workspace destination");
  }
  params.set("tab", "lifecycle");
  return `${path}?${params.toString()}`;
}

function writeSelection(params: URLSearchParams, selected: ProcurementWorkspaceRef | null, trail: ProcurementWorkspaceRef[]): void {
  params.delete("inspect");
  params.delete("inspectVia");
  if (selected) params.set("inspect", workspaceRefKey(selected));
  for (const ref of trail) params.append("inspectVia", workspaceRefKey(ref));
}

export function purchaseWorkspaceInspectHref(path: string, search: string, target: ProcurementWorkspaceRef): string {
  if (!parseWorkspaceRef(workspaceRefKey(target))) {
    throw new Error("Invalid purchase workspace destination");
  }
  const current = parsePurchaseWorkspaceSelection(search);
  const trail = current.selected && workspaceRefKey(current.selected) !== workspaceRefKey(target)
    ? [...current.trail, current.selected].slice(-MAX_WORKSPACE_TRAIL) : current.trail;
  const params = new URLSearchParams(search);
  writeSelection(params, target, trail);
  return workspaceHref(path, params);
}

export function purchaseWorkspaceCloseHref(path: string, search: string, back = false): string {
  const current = parsePurchaseWorkspaceSelection(search);
  const params = new URLSearchParams(search);
  writeSelection(params, back ? current.trail.at(-1) ?? null : null, back ? current.trail.slice(0, -1) : []);
  return workspaceHref(path, params);
}
