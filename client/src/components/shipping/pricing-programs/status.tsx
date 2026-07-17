/**
 * Status badges shared across the Pricing Programs surface. Every status
 * carries an icon and a label (spec §5.8: never color alone).
 */

import { Archive, CheckCircle2, CircleDashed, History } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function revisionStatusBadge(status: string) {
  switch (status) {
    case "active":
      return (
        <Badge className="gap-1 border-transparent bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
          <CheckCircle2 className="h-3 w-3" />
          Active
        </Badge>
      );
    case "draft":
      return (
        <Badge variant="secondary" className="gap-1">
          <CircleDashed className="h-3 w-3" />
          Draft
        </Badge>
      );
    case "superseded":
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <History className="h-3 w-3" />
          Superseded
        </Badge>
      );
    case "retired":
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <Archive className="h-3 w-3" />
          Retired
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export function programStatusBadge(status: string) {
  switch (status) {
    case "active":
      return (
        <Badge className="gap-1 border-transparent bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
          <CheckCircle2 className="h-3 w-3" />
          Active
        </Badge>
      );
    case "draft":
      return (
        <Badge variant="secondary" className="gap-1">
          <CircleDashed className="h-3 w-3" />
          Draft
        </Badge>
      );
    case "retired":
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <Archive className="h-3 w-3" />
          Retired
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}
