import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestInventoryPublicationWorkerRun,
  startInventoryPublicationOutboxWorker,
  stopInventoryPublicationOutboxWorker,
} from "../../application/inventory-publication-outbox.worker";

vi.mock("../../../../platform/observability/runtime-memory", () => ({
  observeRuntimeWork: (_name: string, work: () => Promise<unknown>) => work(),
}));

const batch = { claimed: 0 } as never;
const WAKE_DEBOUNCE_MS = 250;

describe("inventory publication worker wake-up", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("INVENTORY_PUBLICATION_WORKER_INTERVAL_MS", "60000");
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    stopInventoryPublicationOutboxWorker();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function startedWorker(processDue = vi.fn(async () => batch)) {
    startInventoryPublicationOutboxWorker({ processDue });
    await vi.advanceTimersByTimeAsync(5_000); // the startup batch
    expect(processDue).toHaveBeenCalledTimes(1);
    return processDue;
  }

  it("runs a batch right after a wake-up instead of waiting for the timer", async () => {
    const processDue = await startedWorker();
    requestInventoryPublicationWorkerRun();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    expect(processDue).toHaveBeenCalledTimes(2);
  });

  it("turns a burst of wake-ups into one batch", async () => {
    const processDue = await startedWorker();
    for (let index = 0; index < 20; index += 1) requestInventoryPublicationWorkerRun();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 4);
    expect(processDue).toHaveBeenCalledTimes(2);
  });

  it("runs exactly one follow-up batch for work committed while a batch was running", async () => {
    let finish!: () => void;
    const processDue = vi.fn(async () => batch);
    await startedWorker(processDue);
    processDue.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(batch); }));
    requestInventoryPublicationWorkerRun();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    expect(processDue).toHaveBeenCalledTimes(2); // still running
    requestInventoryPublicationWorkerRun();
    requestInventoryPublicationWorkerRun();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 4);
    expect(processDue).toHaveBeenCalledTimes(2); // never overlaps
    finish();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    expect(processDue).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 4);
    expect(processDue).toHaveBeenCalledTimes(3);
  });

  it("keeps the timer as the backstop when no wake-up arrives", async () => {
    const processDue = await startedWorker();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(processDue).toHaveBeenCalledTimes(2);
  });

  it("keeps waking after a failed batch", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const processDue = await startedWorker();
    processDue.mockRejectedValueOnce(new Error("database unavailable"));
    requestInventoryPublicationWorkerRun();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    requestInventoryPublicationWorkerRun();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    expect(processDue).toHaveBeenCalledTimes(3);
  });

  it("ignores wake-ups when the worker is not started or has been stopped", async () => {
    const processDue = vi.fn(async () => batch);
    requestInventoryPublicationWorkerRun();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 4);
    expect(processDue).not.toHaveBeenCalled();
    await startedWorker(processDue);
    stopInventoryPublicationOutboxWorker();
    requestInventoryPublicationWorkerRun();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(processDue).toHaveBeenCalledTimes(1);
  });
});
