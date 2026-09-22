import { ArrowLeft, Store } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";

export function ChannelWorkspaceHeader({ name, description }: { name: string; description: string }) {
  const [, navigate] = useLocation();
  return <div className="flex items-center gap-3">
    <Button variant="ghost" size="icon" aria-label="Back to channels" onClick={() => navigate("/channels")}><ArrowLeft className="h-5 w-5" /></Button>
    <div className="bg-blue-500/10 p-2 rounded-lg"><Store className="h-6 w-6 text-blue-600" /></div>
    <div className="flex-1"><h1 className="text-2xl font-bold tracking-tight">{name} Channel</h1>
      <p className="text-sm text-muted-foreground">{description}</p></div>
  </div>;
}
