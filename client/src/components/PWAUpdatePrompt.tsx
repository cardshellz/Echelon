import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw, X } from "lucide-react";

export function PWAUpdatePrompt() {
  const [showUpdate, setShowUpdate] = useState(false);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let reg: ServiceWorkerRegistration | null = null;

    const registerSW = async () => {
      try {
        reg = await navigator.serviceWorker.register("/sw.js");
        setRegistration(reg);

        if (reg.waiting) {
          setShowUpdate(true);
        }

        reg.addEventListener("updatefound", () => {
          const newWorker = reg?.installing;
          if (!newWorker) return;

          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              setShowUpdate(true);
            }
          });
        });
      } catch (err) {
        console.error("SW registration failed:", err);
      }
    };

    registerSW();

    // Check for updates every 60 seconds
    const updateInterval = setInterval(() => {
      if (reg) {
        reg.update().catch(console.error);
      }
    }, 60000);

    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });

    return () => clearInterval(updateInterval);
  }, []);

  const handleUpdate = () => {
    if (registration?.waiting) {
      registration.waiting.postMessage("SKIP_WAITING");
    }
  };

  if (!showUpdate) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 flex items-center justify-between gap-2 bg-primary text-primary-foreground p-3 rounded-lg shadow-lg animate-in slide-in-from-bottom-4">
      <div className="flex items-center gap-2 text-sm">
        <RefreshCw className="h-4 w-4" />
        <span>New version available!</span>
      </div>
      <div className="flex items-center gap-1">
        <Button 
          size="sm" 
          variant="secondary"
          className="h-8 px-3 text-xs font-medium"
          onClick={handleUpdate}
        >
          Update Now
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-primary-foreground hover:text-primary-foreground/80"
          onClick={() => setShowUpdate(false)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
