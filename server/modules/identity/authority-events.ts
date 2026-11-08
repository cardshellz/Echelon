export type StaffAuthorityChangeListener = (affectedUserIds?: ReadonlyArray<string>) => void | Promise<void>;

const listeners = new Set<StaffAuthorityChangeListener>();

export function onStaffAuthorityChanged(listener: StaffAuthorityChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function notifyStaffAuthorityChanged(affectedUserIds?: Iterable<string>): Promise<void> {
  const normalized = affectedUserIds ? Array.from(new Set(affectedUserIds)).filter(Boolean) : undefined;
  for (const listener of [...listeners]) {
    try {
      await listener(normalized);
    } catch {
      // Best-effort live transport invalidation must never undo a committed transaction.
    }
  }
}
