import { type IUserStorage, userMethods } from "../modules/identity/identity.storage";
import { type IProductLocationStorage, productLocationMethods } from "../modules/warehouse/product-locations.storage";
import { type IOrderStorage, orderMethods } from "./orders";
import { type IWarehouseStorage, warehouseMethods } from "../modules/warehouse/warehouse.storage";
import { type IProductStorage, productMethods } from "../modules/catalog/catalog.storage";
import { type IChannelCatalogStorage, channelCatalogMethods } from "./channel-catalog";
import { type IInventoryStorage, inventoryMethods } from "../modules/inventory/inventory.storage";
import { type IPickingLogStorage, pickingLogMethods } from "./picking-logs";
import { type IOrderHistoryStorage, orderHistoryMethods } from "./order-history";
import { type IChannelStorage, channelMethods } from "./channels";
import { type ISettingsStorage, settingsMethods } from "../modules/warehouse/settings.storage";
import { type ICycleCountStorage, cycleCountMethods } from "../modules/inventory/cycle-counts.storage";
import { type IReplenishmentStorage, replenishmentMethods } from "../modules/inventory/replenishment.storage";
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
