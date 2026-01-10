import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";

export type PickingMode = "batch" | "single";

interface SettingsContextType {
  pickingMode: PickingMode;
  setPickingMode: (mode: PickingMode) => void;
  autoRelease: boolean;
  setAutoRelease: (enabled: boolean) => void;
  releaseDelay: string;
  setReleaseDelay: (delay: string) => void;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [pickingMode, setPickingModeState] = useState<PickingMode>(() => {
    const saved = localStorage.getItem("pickingMode");
    return (saved === "batch" || saved === "single") ? saved : "batch";
  });
  
  const [autoRelease, setAutoReleaseState] = useState(() => {
    const saved = localStorage.getItem("autoRelease");
    return saved !== null ? saved === "true" : true;
  });
  
  const [releaseDelay, setReleaseDelayState] = useState(() => {
    return localStorage.getItem("releaseDelay") || "immediate";
  });

  const setPickingMode = (mode: PickingMode) => {
    setPickingModeState(mode);
    localStorage.setItem("pickingMode", mode);
  };

  const setAutoRelease = (enabled: boolean) => {
    setAutoReleaseState(enabled);
    localStorage.setItem("autoRelease", String(enabled));
  };

  const setReleaseDelay = (delay: string) => {
    setReleaseDelayState(delay);
    localStorage.setItem("releaseDelay", delay);
  };

  return (
    <SettingsContext.Provider value={{
      pickingMode,
      setPickingMode,
      autoRelease,
      setAutoRelease,
      releaseDelay,
      setReleaseDelay,
    }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return context;
}
