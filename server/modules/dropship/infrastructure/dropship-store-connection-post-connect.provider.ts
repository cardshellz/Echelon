import type {
  DropshipStoreConnectionPostConnectProvider,
} from "../application/dropship-store-connection-service";

export class DropshipStoreConnectionPostConnectPipeline
  implements DropshipStoreConnectionPostConnectProvider
{
  constructor(
    private readonly providers: readonly DropshipStoreConnectionPostConnectProvider[],
  ) {}

  async afterStoreConnected(
    input: Parameters<DropshipStoreConnectionPostConnectProvider["afterStoreConnected"]>[0],
  ): Promise<void> {
    for (const provider of this.providers) {
      await provider.afterStoreConnected(input);
    }
  }
}
