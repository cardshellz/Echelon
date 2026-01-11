export type SoundType = "success" | "error" | "complete";
export type SoundTheme = "classic" | "modern" | "arcade" | "gentle" | "silent";

interface SoundConfig {
  frequencies: number[];
  durations: number[];
  volume: number;
  waveType: OscillatorType;
}

const soundThemes: Record<SoundTheme, Record<SoundType, SoundConfig>> = {
  classic: {
    success: {
      frequencies: [880, 1108],
      durations: [0.1, 0.1],
      volume: 0.3,
      waveType: "sine"
    },
    error: {
      frequencies: [200, 150],
      durations: [0.15, 0.15],
      volume: 0.3,
      waveType: "square"
    },
    complete: {
      frequencies: [523, 659, 784, 1047],
      durations: [0.12, 0.12, 0.12, 0.25],
      volume: 0.3,
      waveType: "sine"
    }
  },
  modern: {
    success: {
      frequencies: [600, 900],
      durations: [0.05, 0.1],
      volume: 0.25,
      waveType: "triangle"
    },
    error: {
      frequencies: [250, 180],
      durations: [0.1, 0.2],
      volume: 0.25,
      waveType: "sawtooth"
    },
    complete: {
      frequencies: [440, 554, 659, 880, 1108],
      durations: [0.1, 0.1, 0.1, 0.15, 0.3],
      volume: 0.25,
      waveType: "triangle"
    }
  },
  arcade: {
    success: {
      frequencies: [1200, 1600],
      durations: [0.05, 0.08],
      volume: 0.2,
      waveType: "square"
    },
    error: {
      frequencies: [150, 100, 150],
      durations: [0.1, 0.1, 0.15],
      volume: 0.2,
      waveType: "square"
    },
    complete: {
      frequencies: [262, 330, 392, 523, 659, 784, 1047],
      durations: [0.08, 0.08, 0.08, 0.08, 0.08, 0.1, 0.35],
      volume: 0.2,
      waveType: "square"
    }
  },
  gentle: {
    success: {
      frequencies: [440, 550],
      durations: [0.15, 0.2],
      volume: 0.15,
      waveType: "sine"
    },
    error: {
      frequencies: [300, 250],
      durations: [0.2, 0.25],
      volume: 0.15,
      waveType: "sine"
    },
    complete: {
      frequencies: [330, 392, 494, 659],
      durations: [0.2, 0.2, 0.2, 0.4],
      volume: 0.15,
      waveType: "sine"
    }
  },
  silent: {
    success: { frequencies: [], durations: [], volume: 0, waveType: "sine" },
    error: { frequencies: [], durations: [], volume: 0, waveType: "sine" },
    complete: { frequencies: [], durations: [], volume: 0, waveType: "sine" }
  }
};

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
  return audioContext;
}

export function playSound(type: SoundType, theme: SoundTheme = "classic"): void {
  if (theme === "silent") return;
  
  const config = soundThemes[theme][type];
  if (!config.frequencies.length) return;
  
  const ctx = getAudioContext();
  let startTime = ctx.currentTime;
  
  config.frequencies.forEach((freq, i) => {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.type = config.waveType;
    oscillator.frequency.setValueAtTime(freq, startTime);
    
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    
    const duration = config.durations[i];
    gainNode.gain.setValueAtTime(config.volume, startTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
    
    oscillator.start(startTime);
    oscillator.stop(startTime + duration);
    
    startTime += duration;
  });
}

export type HapticType = "light" | "medium" | "heavy" | "success" | "error" | "complete";

const hapticPatterns: Record<HapticType, number[]> = {
  light: [15],
  medium: [40],
  heavy: [80],
  success: [30, 30, 50],
  error: [100, 50, 100],
  complete: [50, 50, 50, 50, 100]
};

export function triggerHaptic(type: HapticType): void {
  if ("vibrate" in navigator) {
    navigator.vibrate(hapticPatterns[type]);
  }
}

export function playSoundWithHaptic(
  soundType: SoundType, 
  theme: SoundTheme = "classic",
  useHaptic: boolean = true
): void {
  playSound(soundType, theme);
  
  if (useHaptic) {
    const hapticMap: Record<SoundType, HapticType> = {
      success: "success",
      error: "error",
      complete: "complete"
    };
    triggerHaptic(hapticMap[soundType]);
  }
}

export function previewTheme(theme: SoundTheme): void {
  playSound("success", theme);
}

export const themeNames: Record<SoundTheme, string> = {
  classic: "Classic",
  modern: "Modern",
  arcade: "Arcade",
  gentle: "Gentle",
  silent: "Silent"
};

export const themeDescriptions: Record<SoundTheme, string> = {
  classic: "Clear beeps and chimes",
  modern: "Soft, rounded tones",
  arcade: "Retro game-style sounds",
  gentle: "Quiet, calm notifications",
  silent: "No sounds (haptic only)"
};
