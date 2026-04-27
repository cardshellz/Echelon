import { useEffect } from "react";

export function PWAUpdatePrompt() {
  // Register service worker for offline caching (updates handled via WebSocket)
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.error("SW registration failed:", err);
    });
  }, []);

  // Version updates are now handled via WebSocket in Picking.tsx
  // which auto-reloads when a new version is detected
  return null;
}
