export interface ReceivingNavigationVisit {
  readonly address: string | null;
  readonly generation: number;
}

/** Identifies a committed screen visit, rather than only its reusable URL. */
export function createReceivingNavigationSession() {
  let address: string | null = null;
  let generation = 0;

  return {
    enter(nextAddress: string): void {
      address = nextAddress;
      generation += 1;
    },
    leave(): void {
      address = null;
      generation += 1;
    },
    capture(): ReceivingNavigationVisit {
      return { address, generation };
    },
    isCurrent(visit: ReceivingNavigationVisit | undefined): boolean {
      return !!visit && address !== null &&
        visit.address === address && visit.generation === generation;
    },
  };
}
