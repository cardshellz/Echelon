import React, { useEffect, useRef, useCallback } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { playSound as playSoundLib, type SoundTheme, type SoundType } from "@/lib/sounds";
import {
  findMatchingScannableItemIndex,
  normalizeScanCode,
  scanCouldStillMatchItem,
  scanMatchesItem,
} from "@/lib/picking-scan";
import type {
  PickBatch,
  PickItem,
  PickingViewState,
  SingleOrder,
} from "./picking-types-and-helpers";

export function usePickingRealtimeUpdates({
  queryClient,
  soundTheme,
  refetchAuth,
}: {
  queryClient: QueryClient;
  soundTheme: SoundTheme;
  refetchAuth: () => unknown;
}) {
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let currentVersion: string | null = null;

    const connect = () => {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log("WebSocket connected for real-time order updates");
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "authority:updated") {
            void refetchAuth();
          } else if (data.type === "orders:updated") {
            console.log("New order received via WebSocket, refreshing queue");
            void queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
            if (soundTheme !== "silent") {
              playSoundLib("success", soundTheme);
            }
          } else if (data.type === "version") {
            if (currentVersion === null) {
              currentVersion = data.version;
              console.log(`[Version] Initial: ${currentVersion}`);
            } else if (currentVersion !== data.version) {
              console.log(`[Version] Update detected: ${currentVersion} -> ${data.version}`);
              window.location.reload();
            }
          }
        } catch (e) {
          console.error("WebSocket message parse error:", e);
        }
      };

      ws.onclose = (event) => {
        if (event.code === 1008) {
          void refetchAuth();
          return;
        }
        if (event.code === 1006) {
          void refetchAuth();
        }
        console.log("WebSocket disconnected, reconnecting in 5s...");
        reconnectTimeout = setTimeout(connect, 5000);
      };

      ws.onerror = (error) => {
        console.error("WebSocket error:", error);
      };
    };

    connect();

    return () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [queryClient, soundTheme]);
}

export function useSyncCompletedOrders({
  pickingMode,
  ordersFromApi,
  setLocalSingleQueue,
}: {
  pickingMode: string;
  ordersFromApi: SingleOrder[];
  setLocalSingleQueue: React.Dispatch<React.SetStateAction<SingleOrder[]>>;
}) {
  const lastSyncedCompletedIdsRef = useRef<string>("");

  useEffect(() => {
    if (pickingMode === "single" && ordersFromApi.length > 0) {
      const completedFromApi = ordersFromApi.filter((o) => o.status === "completed");
      if (completedFromApi.length > 0) {
        const completedFingerprint = completedFromApi.map((o) => o.id).sort().join(",");
        if (completedFingerprint === lastSyncedCompletedIdsRef.current) return;
        lastSyncedCompletedIdsRef.current = completedFingerprint;

        setLocalSingleQueue((prev) => {
          const localCompleted = prev.filter((o) => o.status === "completed");
          const completedApiIds = new Set(completedFromApi.map((o) => o.id));
          const localOnlyCompleted = localCompleted.filter((lc) => !completedApiIds.has(lc.id));
          const allCompleted = [...completedFromApi, ...localOnlyCompleted];
          const localNonCompleted = prev.filter((o) => o.status !== "completed");
          return [...localNonCompleted, ...allCompleted];
        });
      }
    }
  }, [ordersFromApi, pickingMode, setLocalSingleQueue]);
}

export function usePickingFocusAndRefs({
  view,
  shortPickOpen,
  multiQtyOpen,
  binCountOpen,
  allocationDialogOpen,
  activeWork,
}: {
  view: PickingViewState;
  shortPickOpen: boolean;
  multiQtyOpen: boolean;
  binCountOpen: boolean;
  allocationDialogOpen: boolean;
  activeWork: PickBatch | SingleOrder | undefined;
}) {
  const manualInputRef = useRef<HTMLInputElement>(null);
  const hiddenScannerRef = useRef<HTMLInputElement>(null);
  const focusTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const maintainFocus = useCallback(() => {
    if (view === "picking" && !shortPickOpen && !multiQtyOpen && !binCountOpen && !allocationDialogOpen) {
      if (hiddenScannerRef.current) hiddenScannerRef.current.focus();
    }
  }, [view, shortPickOpen, multiQtyOpen, binCountOpen, allocationDialogOpen]);

  useEffect(() => {
    if (view === "picking") {
      setTimeout(maintainFocus, 100);
      return () => {
        if (focusTimeoutRef.current) clearTimeout(focusTimeoutRef.current);
      };
    }
  }, [view, maintainFocus]);

  useEffect(() => {
    if (!shortPickOpen && !multiQtyOpen && !binCountOpen && !allocationDialogOpen) {
      setTimeout(maintainFocus, 100);
    }
  }, [shortPickOpen, multiQtyOpen, binCountOpen, allocationDialogOpen, maintainFocus]);

  useEffect(() => {
    if (view === "picking") {
      const handleFocusIn = (e: FocusEvent) => {
        const target = e.target as HTMLElement;
        if (shortPickOpen || multiQtyOpen || binCountOpen || allocationDialogOpen) return;
        if (target !== manualInputRef.current && target.tagName === "INPUT") {
          e.preventDefault();
          maintainFocus();
        }
      };

      document.addEventListener("focusin", handleFocusIn);
      return () => document.removeEventListener("focusin", handleFocusIn);
    }
  }, [view, shortPickOpen, multiQtyOpen, binCountOpen, allocationDialogOpen, maintainFocus]);

  useEffect(() => {
    if (view !== "picking" || !activeWork) return;

    const firstPendingIndex = activeWork.items.findIndex(
      (item) => item.status === "pending" || item.status === "in_progress",
    );

    if (firstPendingIndex !== -1) {
      const item = activeWork.items[firstPendingIndex];
      const element = itemRefs.current.get(item.id);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  }, [view, activeWork?.items.map((i) => `${i.id}:${i.status}`).join(",")]);

  return {
    manualInputRef,
    hiddenScannerRef,
    itemRefs,
    maintainFocus,
  };
}

export function usePickingScanHandlers({
  view,
  pickerViewMode,
  activeWork,
  currentItem,
  shortPickOpen,
  multiQtyOpen,
  binCountOpen,
  setScanInput,
  setScanStatus,
  setDebugLog,
  setMultiQtyOpen,
  scanPickInFlightRef,
  focusedScanTimeoutRef,
  clearFocusedScanTimeout,
  rejectScan,
  confirmPick,
  handleListItemPickOne,
  playSound,
  triggerHaptic,
  maintainFocus,
}: {
  view: PickingViewState;
  pickerViewMode: string;
  activeWork: PickBatch | SingleOrder | undefined;
  currentItem: PickItem | undefined;
  shortPickOpen: boolean;
  multiQtyOpen: boolean;
  binCountOpen: boolean;
  setScanInput: React.Dispatch<React.SetStateAction<string>>;
  setScanStatus: React.Dispatch<React.SetStateAction<"idle" | "success" | "error">>;
  setDebugLog: React.Dispatch<React.SetStateAction<string[]>>;
  setMultiQtyOpen: React.Dispatch<React.SetStateAction<boolean>>;
  scanPickInFlightRef: React.MutableRefObject<Set<number>>;
  focusedScanTimeoutRef: React.MutableRefObject<NodeJS.Timeout | null>;
  clearFocusedScanTimeout: () => void;
  rejectScan: (resetDelayMs?: number) => void;
  confirmPick: (qty: number) => void;
  handleListItemPickOne: (idx: number) => void;
  playSound: (type: SoundType) => void;
  triggerHaptic: (type: "light" | "medium" | "heavy") => void;
  maintainFocus: () => void;
}) {
  const scanBufferRef = useRef<string>("");
  const scanBufferTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const processScanRef = useRef<(value: string) => void>(() => {});

  useEffect(() => {
    if (view !== "picking" || shortPickOpen || multiQtyOpen || binCountOpen) {
      return;
    }

    const logDebug = (msg: string) => {
      const ts = new Date().toLocaleTimeString();
      setDebugLog((prev) => [`${ts}: ${msg}`, ...prev.slice(0, 9)]);
      console.log("[SCAN]", msg);
    };

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (scanBufferTimeoutRef.current) {
        clearTimeout(scanBufferTimeoutRef.current);
      }

      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const scannedValue = scanBufferRef.current.trim();
        if (scannedValue.length > 0) {
          logDebug(`GLOBAL: Enter with buffer "${scannedValue}"`);
          setScanInput(scannedValue);
          setTimeout(() => {
            processScanRef.current(scannedValue);
            scanBufferRef.current = "";
            setScanInput("");
          }, 10);
        }
        return;
      }

      if (e.key.length === 1) {
        scanBufferRef.current += e.key;
        setScanInput(scanBufferRef.current);

        scanBufferTimeoutRef.current = setTimeout(() => {
          if (scanBufferRef.current.length > 0) {
            logDebug(`GLOBAL: Timeout, processing buffer "${scanBufferRef.current}"`);
            const scannedValue = scanBufferRef.current.trim();
            if (scannedValue.length >= 3) {
              processScanRef.current(scannedValue);
            }
            scanBufferRef.current = "";
            setScanInput("");
          }
        }, 300);
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
      if (scanBufferTimeoutRef.current) {
        clearTimeout(scanBufferTimeoutRef.current);
      }
    };
  }, [view, shortPickOpen, multiQtyOpen, binCountOpen, setDebugLog, setScanInput]);

  const acceptFocusedScan = () => {
    if (!currentItem) return;
    if (scanPickInFlightRef.current.has(currentItem.id)) {
      rejectScan(500);
      return;
    }

    clearFocusedScanTimeout();
    setScanStatus("success");
    playSound("scan");
    triggerHaptic("medium");

    if (currentItem.qty > 1) {
      setTimeout(() => {
        setMultiQtyOpen(true);
        setScanStatus("idle");
        setScanInput("");
      }, 400);
    } else {
      setTimeout(() => {
        confirmPick(1);
      }, 400);
    }
  };

  const processFocusedScan = (value: string) => {
    setScanInput(value);
    if (!currentItem || !value.trim()) return;

    if (scanMatchesItem(value, currentItem)) {
      acceptFocusedScan();
    } else {
      rejectScan();
    }
  };

  const handleScan = (value: string) => {
    setScanInput(value);
    if (!currentItem) return;

    clearFocusedScanTimeout();
    if (!value.trim()) return;

    if (scanMatchesItem(value, currentItem)) {
      acceptFocusedScan();
      return;
    }

    const normalizedInput = normalizeScanCode(value);
    if (normalizedInput.length >= 3 && !scanCouldStillMatchItem(value, currentItem)) {
      focusedScanTimeoutRef.current = setTimeout(() => {
        processFocusedScan(value);
      }, 180);
    }
  };

  useEffect(() => {
    return () => clearFocusedScanTimeout();
  }, []);

  const addDebug = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setDebugLog((prev) => [`${timestamp}: ${msg}`, ...prev.slice(0, 9)]);
    console.log("[SCAN]", msg);
  };

  const handleScanKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const value = e.currentTarget.value;
      addDebug(`Enter: "${value}"`);

      if (!activeWork || !value.trim()) {
        addDebug("No value or no order");
        setScanInput("");
        return;
      }

      const matchingIndex = findMatchingScannableItemIndex(activeWork.items, value);

      if (matchingIndex !== -1) {
        const item = activeWork.items[matchingIndex];
        const newPicked = item.picked + 1;
        if (scanPickInFlightRef.current.has(item.id)) {
          addDebug(`DUPLICATE IGNORED: ${item.sku} is already updating`);
          rejectScan(500);
          return;
        }
        addDebug(`MATCH! ${item.sku} (${newPicked}/${item.qty})`);
        setScanStatus("success");
        playSound("success");
        triggerHaptic("medium");

        handleListItemPickOne(matchingIndex);

        setTimeout(() => {
          setScanStatus("idle");
          setScanInput("");
          maintainFocus();
        }, 300);
      } else {
        addDebug(`NO MATCH: "${normalizeScanCode(value)}"`);
        setScanStatus("error");
        playSound("error");
        triggerHaptic("heavy");

        setTimeout(() => {
          setScanStatus("idle");
          setScanInput("");
          maintainFocus();
        }, 1000);
      }
    }
  };

  useEffect(() => {
    processScanRef.current = (value: string) => {
      if (pickerViewMode === "focus") {
        processFocusedScan(value);
        return;
      }

      if (!activeWork || !value.trim()) {
        addDebug("Global scan: no value or no order");
        return;
      }

      const matchingIndex = findMatchingScannableItemIndex(activeWork.items, value);

      if (matchingIndex !== -1) {
        const item = activeWork.items[matchingIndex];
        const newPicked = item.picked + 1;
        if (scanPickInFlightRef.current.has(item.id)) {
          addDebug(`GLOBAL DUPLICATE IGNORED: ${item.sku} is already updating`);
          rejectScan(500);
          return;
        }
        addDebug(`GLOBAL MATCH! ${item.sku} (${newPicked}/${item.qty})`);
        setScanStatus("success");
        playSound("success");
        triggerHaptic("medium");

        handleListItemPickOne(matchingIndex);

        setTimeout(() => {
          setScanStatus("idle");
          maintainFocus();
        }, 300);
      } else {
        addDebug(`GLOBAL NO MATCH: "${normalizeScanCode(value)}"`);
        setScanStatus("error");
        playSound("error");
        triggerHaptic("heavy");

        setTimeout(() => {
          setScanStatus("idle");
          maintainFocus();
        }, 1000);
      }
    };
  }, [activeWork, currentItem, playSound, triggerHaptic, maintainFocus, pickerViewMode]);

  return {
    processScanRef,
    handleScan,
    processFocusedScan,
    handleScanKeyDown,
  };
}
