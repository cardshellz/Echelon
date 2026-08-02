import type {
  ShippingDestinationScopeSummary,
} from "@shared/types/shipping-channel-routing";

export interface DestinationScopeReader {
  list(): Promise<ShippingDestinationScopeSummary[]>;
}

export class DestinationScopeReadService {
  constructor(private readonly reader: DestinationScopeReader) {}

  async listActive(): Promise<ShippingDestinationScopeSummary[]> {
    const scopes = await this.reader.list();
    return scopes
      .filter((scope) => scope.status === "active")
      .sort((left, right) =>
        left.name.localeCompare(right.name) || left.id - right.id,
      );
  }
}
