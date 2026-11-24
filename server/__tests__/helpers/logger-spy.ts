import { vi, type Mock } from "vitest";
import { formatStructuredLogLine, logger, type LogLevel } from "../../platform/observability";

const activeSpies = new Map<LogLevel, Mock<(line: string) => void>>();

/**
 * Spies on `logger[level]`, silences stdout/stderr emission during tests, and
 * records the exact serialized structured JSON line (`formatStructuredLogLine`)
 * so unit/integration tests can assert call counts, structured fields, and
 * secret redaction against the real observability pipeline.
 */
export function spyLoggerJson(
  level: LogLevel | "log",
  listener?: (line: string) => void,
): Mock<(line: string) => void> & { mockRestore: () => void } {
  const normalizedLevel: LogLevel = level === "log" ? "info" : level;
  const lines = vi.fn<(line: string) => void>((line: string) => {
    listener?.(line);
  });
  activeSpies.set(normalizedLevel, lines);
  const spy = vi.spyOn(logger, normalizedLevel).mockImplementation((action, data) => {
    lines(formatStructuredLogLine({ level: normalizedLevel, action, ...(data ?? {}) }));
  });
  return Object.assign(lines, {
    mockRestore: () => {
      if (activeSpies.get(normalizedLevel) === lines) {
        activeSpies.delete(normalizedLevel);
      }
      spy.mockRestore();
    },
  });
}

export function getLoggerJsonSpy(level: LogLevel | "log"): Mock<(line: string) => void> {
  const normalizedLevel: LogLevel = level === "log" ? "info" : level;
  const active = activeSpies.get(normalizedLevel);
  if (!active) {
    throw new Error(`No active spyLoggerJson("${normalizedLevel}") installed`);
  }
  return active;
}
