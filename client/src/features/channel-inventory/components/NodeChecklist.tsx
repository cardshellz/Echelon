import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

import { NODE_TYPE_LABELS, nodeLabel, type FulfillmentNode } from "../model";
import { StatePill } from "./primitives";

/** Warehouses (fulfillment nodes) that may supply a destination. */
export function NodeChecklist({ nodes, selectedIds, activeIds, onToggle, disabled, idPrefix }: {
  nodes: readonly FulfillmentNode[];
  selectedIds: readonly number[];
  /** Nodes in the currently active (sealed) supply, marked so pending removals are visible. */
  activeIds?: readonly number[];
  onToggle(nodeId: number, checked: boolean): void;
  disabled?: boolean;
  idPrefix: string;
}) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {nodes.map((node) => {
        const checked = selectedIds.includes(node.id);
        const inputId = `${idPrefix}-node-${node.id}`;
        const wasActive = activeIds?.includes(node.id) ?? false;
        return (
          <li key={node.id}>
            <label
              htmlFor={inputId}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
                checked ? "border-primary/50 bg-accent/60" : "border-border hover:bg-accent/40",
                disabled && "cursor-not-allowed opacity-70",
              )}
            >
              <Checkbox
                id={inputId}
                checked={checked}
                disabled={disabled}
                onCheckedChange={(value) => onToggle(node.id, value === true)}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{nodeLabel(node)}</span>
                  <StatePill tone="neutral">{NODE_TYPE_LABELS[node.nodeType]}</StatePill>
                  {node.lifecycleStatus === "draft" && <StatePill tone="draft">Prepared, not yet active</StatePill>}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {wasActive && !checked ? "Currently active; will be removed when this draft is activated" : `Code ${node.code}`}
                </span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
