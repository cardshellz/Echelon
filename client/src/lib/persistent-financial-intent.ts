import { canonicalJson } from "@shared/utils/canonical-json";

type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface PersistentFinancialIntent<Body> { version: 1; userId: string; key: string; body: Body }
interface RecoveryMessages {
  read: string;
  corrupt: string;
  unresolved: string;
  save: string;
  clear: string;
}

/** One immutable unresolved intent per storage key; validate all persisted evidence before use. */
export function createPersistentFinancialIntentStore<Body, RecordType extends PersistentFinancialIntent<Body>>(options: {
  storage: () => RecoveryStorage;
  storageKey: string;
  userId: string;
  parse: (raw: unknown) => RecordType;
  messages: RecoveryMessages;
}) {
  const { storage, storageKey, userId, parse, messages } = options;
  function read(): RecordType | null {
    let raw: string | null;
    try { raw = storage().getItem(storageKey); }
    catch { throw new Error(messages.read); }
    if (raw === null) return null;
    try {
      const record = parse(JSON.parse(raw));
      if (record.userId !== userId) throw new Error("Recovery operator mismatch");
      return record;
    } catch { throw new Error(messages.corrupt); }
  }
  return {
    userId, read,
    acquire(body: Body, generateKey: () => string): RecordType {
      const existing = read();
      if (existing) {
        if (canonicalJson(existing.body) !== canonicalJson(body)) throw new Error(messages.unresolved);
        return existing;
      }
      const record = parse({ version: 1, userId, key: generateKey(), body });
      try { storage().setItem(storageKey, JSON.stringify(record)); }
      catch { throw new Error(messages.save); }
      return record;
    },
    complete(key: string): void {
      if (read()?.key !== key) return;
      try { storage().removeItem(storageKey); }
      catch { throw new Error(messages.clear); }
    },
  };
}
