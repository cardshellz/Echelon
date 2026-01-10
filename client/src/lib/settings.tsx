import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";

export type PickingMode = "batch" | "single";
export type PickerViewMode = "focus" | "list";

interface SettingsContextType {
  pickingMode: PickingMode;
  setPickingMode: (mode: PickingMode) => void;
  pickerViewMode: PickerViewMode;
  setPickerViewMode: (mode: PickerViewMode) => void;
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
  
  const [pickerViewMode, setPickerViewModeState] = useState<PickerViewMode>(() => {
    const saved = localStorage.getItem("pickerViewMode");
    return (saved === "focus" || saved === "list") ? saved : "focus";
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

  const setPickerViewMode = (mode: PickerViewMode) => {
    setPickerViewModeState(mode);
    localStorage.setItem("pickerViewMode", mode);
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
      pickerViewMode,
      setPickerViewMode,
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
