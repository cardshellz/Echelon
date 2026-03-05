import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Bell, RotateCcw } from "lucide-react";
import {
  useNotificationPreferences,
  useSetPreference,
  useResetPreferences,
  type NotificationPreference,
} from "@/hooks/use-notifications";

const categoryLabels: Record<string, string> = {
  replenishment: "Replenishment",
  receiving: "Receiving",
  picking: "Picking",
  inventory: "Inventory",
};

export default function NotificationPreferences() {
  const { toast } = useToast();
  const { data: prefs = [], isLoading } = useNotificationPreferences();
  const setPref = useSetPreference();
  const resetPrefs = useResetPreferences();

  // Group by category
  const grouped = prefs.reduce<Record<string, NotificationPreference[]>>((acc, p) => {
    const cat = p.category;
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(p);
    return acc;
  }, {});

  const handleToggle = (typeId: number, enabled: boolean) => {
    setPref.mutate(
      { typeId, enabled },
      {
        onError: () => {
          toast({ title: "Failed to update preference", variant: "destructive" });
        },
      }
    );
  };

  const handleReset = () => {
    resetPrefs.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Preferences reset to role defaults" });
      },
      onError: () => {
        toast({ title: "Failed to reset preferences", variant: "destructive" });
      },
    });
  };

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bell size={24} />
            Notification Preferences
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Choose which notifications you receive. Overrides are highlighted.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleReset}
          disabled={resetPrefs.isPending}
          className="gap-1.5"
        >
          <RotateCcw size={14} />
          Reset to defaults
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : (
        Object.entries(grouped).map(([category, items]) => (
          <Card key={category}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                {categoryLabels[category] ?? category}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {items.map((pref) => (
                <div
                  key={pref.id}
                  className="flex items-center justify-between gap-4"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{pref.label}</span>
                      {pref.isOverride && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
                          Override
                        </span>
                      )}
                    </div>
                    {pref.description && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {pref.description}
                      </p>
                    )}
                  </div>
                  <Switch
                    checked={pref.enabled}
                    onCheckedChange={(checked) => handleToggle(pref.id, checked)}
                    disabled={setPref.isPending}
                  />
                </div>
              ))}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
