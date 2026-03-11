import { type IUserStorage, userMethods } from "./users";
import { type IProductLocationStorage, productLocationMethods } from "./product-locations";
import { type IOrderStorage, orderMethods } from "./orders";
import { type IWarehouseStorage, warehouseMethods } from "./warehouse";
import { type IProductStorage, productMethods } from "./products";
import { type IChannelCatalogStorage, channelCatalogMethods } from "./channel-catalog";
import { type IInventoryStorage, inventoryMethods } from "./inventory";
import { type IPickingLogStorage, pickingLogMethods } from "./picking-logs";
import { type IOrderHistoryStorage, orderHistoryMethods } from "./order-history";
import { type IChannelStorage, channelMethods } from "./channels";
import { type ISettingsStorage, settingsMethods } from "./settings";
import { type ICycleCountStorage, cycleCountMethods } from "./cycle-counts";
import { type IReplenishmentStorage, replenishmentMethods } from "./replenishment";
import { type IProcurementStorage, procurementMethods } from "./procurement";

export type IStorage =
  IUserStorage &
  IProductLocationStorage &
  IOrderStorage &
  IWarehouseStorage &
  IProductStorage &
  IChannelCatalogStorage &
  IInventoryStorage &
  IPickingLogStorage &
  IOrderHistoryStorage &
  IChannelStorage &
  ISettingsStorage &
  ICycleCountStorage &
  IReplenishmentStorage &
  IProcurementStorage;

export class DatabaseStorage {
  [key: string]: any;
}

Object.assign(
  DatabaseStorage.prototype,
  userMethods,
  productLocationMethods,
  orderMethods,
  warehouseMethods,
  productMethods,
  channelCatalogMethods,
  inventoryMethods,
  pickingLogMethods,
  orderHistoryMethods,
  channelMethods,
  settingsMethods,
  cycleCountMethods,
  replenishmentMethods,
  procurementMethods,
);

export const storage = new DatabaseStorage() as unknown as IStorage;
