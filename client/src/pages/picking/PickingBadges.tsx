import React from "react";
import { Link } from "wouter";
import { AlertTriangle, PackageCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  getOrderPickProgress,
  shouldShowReleasedPickProgress,
  type ReplenPrediction,
  type SingleOrder,
} from "./picking-types-and-helpers";

/**
 * Priority badges — shipping service level + membership plan, side-by-side.
 * Shipping uses static colors (amber=expedited, red=overnight).
 * Membership uses the plan's primary_color from the DB (stamped at sync).
 *
 * Rules:
 *   standard + .core        → nothing
 *   standard + .club/.ops   → membership badge only
 *   expedited + .core       → shipping badge only
 *   expedited + .club/.ops  → both badges
 */
export function PriorityBadges({
  shippingServiceLevel,
  memberPlanName,
  memberPlanColor,
  size = "sm",
}: {
  shippingServiceLevel?: "standard" | "expedited" | "overnight" | null;
  memberPlanName?: string | null;
  memberPlanColor?: string | null;
  size?: "xs" | "sm";
}) {
  const textSize = size === "xs" ? "text-[9px]" : "text-[10px]";
  const pad = size === "xs" ? "px-1.5 py-0.5" : "px-1.5 py-0";

  const shippingBadge =
    shippingServiceLevel === "overnight" ? (
      <Badge className={cn("bg-red-600 text-white", textSize, pad)}>OVERNIGHT</Badge>
    ) : shippingServiceLevel === "expedited" ? (
      <Badge className={cn("bg-amber-500 text-white", textSize, pad)}>EXPEDITED</Badge>
    ) : null;

  const isPaidTier =
    memberPlanName &&
    memberPlanName.toLowerCase() !== ".core" &&
    memberPlanName.toLowerCase() !== "core";
  const memberBadge = isPaidTier ? (
    <Badge
      variant="outline"
      className={cn(textSize, pad, "border-2 font-semibold")}
      style={
        memberPlanColor
          ? { borderColor: memberPlanColor, color: memberPlanColor }
          : undefined
      }
    >
      {memberPlanName!.toUpperCase()}
    </Badge>
  ) : null;

  if (!shippingBadge && !memberBadge) return null;
  return (
    <>
      {shippingBadge}
      {memberBadge}
    </>
  );
}

export function ReplenPredictionBadge({
  prediction,
  compact = false,
  canOpenTask = false,
}: {
  prediction?: ReplenPrediction | null;
  compact?: boolean;
  canOpenTask?: boolean;
}) {
  if (!prediction || (!prediction.replenNeeded && !prediction.existingTaskId)) return null;

  const hasExistingTask = !!prediction.existingTaskId;
  const hasBlockedTask = prediction.existingTaskStatus === "blocked";
  const hasInlineReadyTask =
    hasExistingTask &&
    prediction.existingTaskExecutionMode === "inline" &&
    (prediction.existingTaskStatus === "pending" || prediction.existingTaskStatus === "assigned");
  const isShipmentBlocking = hasBlockedTask && prediction.existingTaskBlocksShipment === true;
  const isSourceUnavailable = prediction.stockout;
  const isBlocked = isShipmentBlocking || hasBlockedTask || isSourceUnavailable;
  const label = hasExistingTask
    ? isShipmentBlocking
      ? "Replen blocks shipment"
      : hasBlockedTask
        ? "Replen needs review"
        : hasInlineReadyTask
          ? "Replen ready"
          : "Replen queued"
    : isSourceUnavailable ? "No source stock" : "Replen after pick";
  const detail = hasExistingTask
    ? `#${prediction.existingTaskId}${prediction.sourceLocationCode ? ` from ${prediction.sourceLocationCode}` : ""}`
    : prediction.sourceLocationCode
      ? `from ${prediction.sourceLocationCode}`
      : null;

  const badge = (
    <Badge
      variant="outline"
      title={hasExistingTask && canOpenTask ? `Open replen task ${detail}` : detail ? `${label} ${detail}` : label}
      className={cn(
        "inline-flex max-w-full items-center gap-1 font-semibold",
        hasExistingTask && canOpenTask && "cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-950/40",
        compact ? "text-[9px] px-1.5 py-0.5" : "text-xs px-2 py-1",
        isShipmentBlocking || hasBlockedTask
          ? "border-red-300 bg-red-50 text-red-700"
          : isSourceUnavailable
            ? "border-amber-300 bg-amber-50 text-amber-800"
            : hasExistingTask
              ? "border-blue-300 bg-blue-50 text-blue-700"
              : "border-amber-300 bg-amber-50 text-amber-700",
      )}
    >
      {isBlocked ? (
        <AlertTriangle className={cn(compact ? "h-3 w-3" : "h-3.5 w-3.5", "shrink-0")} />
      ) : (
        <PackageCheck className={cn(compact ? "h-3 w-3" : "h-3.5 w-3.5", "shrink-0")} />
      )}
      <span className="truncate">
        {label}
        {detail && <span className="font-mono font-bold"> {detail}</span>}
      </span>
    </Badge>
  );

  if (!hasExistingTask || !canOpenTask) return badge;

  return (
    <Link href={`/replenishment?taskId=${prediction.existingTaskId}&status=all`}>
      {badge}
    </Link>
  );
}

export function ReleasedPickProgressBadge({ order }: { order: SingleOrder }) {
  if (!shouldShowReleasedPickProgress(order)) {
    return null;
  }

  const progress = getOrderPickProgress(order.items);
  return (
    <Badge variant="outline" className="text-[9px] px-1.5 py-0.5 border-amber-400 text-amber-700 bg-amber-50">
      {progress.isFullyPicked ? "PICKED" : "PARTIAL PICK"}
    </Badge>
  );
}

export function ReleasedPickProgressNotice({ order }: { order: SingleOrder }) {
  if (!shouldShowReleasedPickProgress(order)) {
    return null;
  }

  const progress = getOrderPickProgress(order.items);
  return (
    <div className="text-[10px] font-semibold text-amber-700 flex items-center gap-1 mt-0.5">
      Pick progress preserved: {progress.pickedUnits}/{progress.totalUnits} units
      {" / "}
      {progress.pickedLines}/{progress.totalLines} lines
    </div>
  );
}
