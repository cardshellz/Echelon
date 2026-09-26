import { z } from "zod";
import {
  customerReturnLabelSubmitInputSchema,
  type CustomerReturnLabelStatus,
  type CustomerReturnLabelSubmitInput,
} from "@shared/returns/customer-return-label.contract";
import { PreviewAccessError } from "./customer-return-preview";
import {
  ReturnLabelRequestError,
  type CustomerReturnLabelTransport,
} from "./customer-return-labels";

export const returnLabelSessionSchema = z
  .object({
    channelId: z.number().int().positive().safe(),
    idempotencyKey: z.string().uuid(),
    authorizationId: z.number().int().positive().safe().nullable(),
  })
  .strict();
export type ReturnLabelSessionRecord = z.infer<typeof returnLabelSessionSchema>;
export interface ReturnLabelSessionState {
  record: ReturnLabelSessionRecord | null;
  status: CustomerReturnLabelStatus | null;
  busy: boolean;
  error: string | null;
  storageBlocked: boolean;
  revision: number;
}
type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Stores no order, customer, parcel, tracking or provider data in browser storage. */
export class CustomerReturnLabelSession {
  private state: ReturnLabelSessionState;
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private intent: CustomerReturnLabelSubmitInput | null = null;
  private active = true;
  private readonly storageKey: string;

  constructor(
    adminId: string,
    private readonly storage: SessionStorage | null,
    private readonly transport: (
      channelId: number,
    ) => CustomerReturnLabelTransport,
    private readonly onAccessDenied: (message: string) => void,
    private readonly newKey: () => string = () => crypto.randomUUID(),
  ) {
    this.storageKey = `return-label-session:${encodeURIComponent(adminId)}`;
    this.state = {
      record: null,
      status: null,
      busy: false,
      error: null,
      storageBlocked: false,
      revision: 0,
    };
    try {
      if (!storage) throw new Error("Session storage unavailable");
      const saved = storage.getItem(this.storageKey);
      if (saved !== null)
        this.state.record = returnLabelSessionSchema.parse(JSON.parse(saved));
    } catch {
      this.state = {
        ...this.state,
        storageBlocked: true,
        error:
          "This browser could not restore the return session. Keep this page open and contact support before creating labels.",
      };
    }
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<ReturnLabelSessionState>) {
    if (!this.active) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private save(record: ReturnLabelSessionRecord) {
    if (!this.storage) throw new Error("Session storage unavailable");
    this.storage.setItem(
      this.storageKey,
      JSON.stringify(returnLabelSessionSchema.parse(record)),
    );
  }
  private accept(status: CustomerReturnLabelStatus) {
    const record = this.state.record;
    if (
      !record ||
      status.channelId !== record.channelId ||
      (record.authorizationId !== null &&
        record.authorizationId !== status.authorizationId)
    ) {
      throw new Error("The return status did not match your saved request.");
    }
    const previous = this.state.status;
    if (
      previous &&
      (previous.authorizationNumber !== status.authorizationNumber ||
        previous.parcels.length !== status.parcels.length ||
        previous.parcels.some(
          (parcel) =>
            !status.parcels.some(
              (next) =>
                next.parcelId === parcel.parcelId &&
                next.number === parcel.number,
            ),
        ))
    ) {
      throw new Error(
        "The box identities changed unexpectedly. Keep this return unchanged and contact support.",
      );
    }
    const saved = { ...record, authorizationId: status.authorizationId };
    // The previously persisted command key still recovers this return if this write fails.
    let warning: string | null = null;
    try {
      this.save(saved);
    } catch {
      warning =
        "Keep this page open. This browser could not save the latest return status.";
    }
    this.update({ record: saved, status, error: warning });
  }
  private async pending(
    api: CustomerReturnLabelTransport,
    signal: AbortSignal,
  ) {
    const attempted = new Set<number>();
    while (!signal.aborted && this.active) {
      const status = this.state.status;
      if (
        !status?.canProgress ||
        status.parcels.some(
          (item) =>
            item.status === "processing" || item.status === "needs_review",
        )
      )
        return;
      const parcel = [...status.parcels]
        .sort((a, b) => a.number - b.number)
        .find((item) => item.status === "pending");
      if (!parcel || attempted.has(parcel.parcelId)) return;
      attempted.add(parcel.parcelId);
      const next = await api.progress(status.authorizationId, signal);
      if (signal.aborted || !this.active) return;
      this.accept(next);
    }
  }
  private async run(work: (signal: AbortSignal) => Promise<void>) {
    if (this.state.busy || !this.active) return;
    const controller = new AbortController();
    this.controller = controller;
    this.update({ busy: true, error: null });
    try {
      await work(controller.signal);
    } catch (cause) {
      if (controller.signal.aborted || !this.active) return;
      if (cause instanceof PreviewAccessError)
        this.onAccessDenied(cause.message);
      else if (
        cause instanceof ReturnLabelRequestError &&
        cause.code === "RETURN_LABEL_SUBMISSION_REJECTED" &&
        this.state.record?.authorizationId === null
      ) {
        try {
          this.storage?.removeItem(this.storageKey);
          this.intent = null;
          this.update({
            record: null,
            status: null,
            error: cause.message,
            revision: this.state.revision + 1,
          });
        } catch {
          this.update({
            error:
              "The rejected request could not be cleared. Keep this page open and contact support.",
          });
        }
      } else
        this.update({
          error:
            cause instanceof Error
              ? cause.message
              : "The request could not be confirmed. Check label status before continuing.",
        });
    } finally {
      if (this.controller === controller) this.controller = null;
      if (!controller.signal.aborted && this.active)
        this.update({ busy: false });
    }
  }

  async begin(raw: Omit<CustomerReturnLabelSubmitInput, "idempotencyKey">) {
    if (this.state.record || this.state.storageBlocked || this.state.busy)
      return;
    let intent: CustomerReturnLabelSubmitInput;
    try {
      intent = customerReturnLabelSubmitInputSchema.parse({
        ...raw,
        idempotencyKey: this.newKey(),
      });
    } catch {
      this.update({
        error:
          "The return request could not be verified. Review the order again before creating labels.",
      });
      return;
    }
    const record: ReturnLabelSessionRecord = {
      channelId: intent.channelId,
      idempotencyKey: intent.idempotencyKey,
      authorizationId: null,
    };
    try {
      this.save(record);
    } catch {
      this.update({
        storageBlocked: true,
        error:
          "This browser cannot save a recovery key. Enable session storage before creating return labels.",
      });
      return;
    }
    this.intent = intent;
    this.update({ record });
    await this.run(async (signal) => {
      const api = this.transport(record.channelId);
      const status = await api.submit(intent, signal);
      if (signal.aborted || !this.active) return;
      this.accept(status);
      await this.pending(api, signal);
    });
  }

  /** A reload reads only. Uncertain work is resumed solely by an explicit Check action. */
  async restore() {
    const record = this.state.record;
    if (!record || this.state.status) return;
    await this.run(async (signal) => {
      const api = this.transport(record.channelId);
      const status =
        record.authorizationId === null
          ? await api.byCommand(record.idempotencyKey, signal)
          : await api.status(record.authorizationId, signal);
      if (!signal.aborted && this.active) this.accept(status);
    });
  }

  async check() {
    const record = this.state.record;
    if (!record) return;
    await this.run(async (signal) => {
      const api = this.transport(record.channelId);
      const status =
        record.authorizationId === null
          ? this.intent
            ? await api.submit(this.intent, signal)
            : await api.resume(record.idempotencyKey, signal)
          : await api.status(record.authorizationId, signal);
      if (signal.aborted || !this.active) return;
      this.accept(status);
      // Recovery of an uncertain purchase gets one explicit attempt, never a poll loop.
      if (
        status.canProgress &&
        status.parcels.some(
          (item) =>
            item.status === "processing" || item.status === "needs_review",
        )
      ) {
        const recovered = await api.progress(status.authorizationId, signal);
        if (signal.aborted || !this.active) return;
        this.accept(recovered);
      }
      await this.pending(api, signal);
    });
  }

  finish() {
    if (
      this.state.busy ||
      !this.state.status?.parcels.every((item) => item.status === "ready")
    )
      return;
    try {
      this.storage?.removeItem(this.storageKey);
      this.intent = null;
      this.update({
        record: null,
        status: null,
        error: null,
        revision: this.state.revision + 1,
      });
    } catch {
      this.update({
        error:
          "The saved return could not be cleared. Keep this page open and try again.",
      });
    }
  }

  dispose() {
    this.active = false;
    this.controller?.abort();
    // React owns subscription cleanup. A fresh authorization gate may reactivate
    // this same controller without re-subscribing useSyncExternalStore.
  }

  activate() {
    this.active = true;
    this.update({ busy: false });
  }
}
