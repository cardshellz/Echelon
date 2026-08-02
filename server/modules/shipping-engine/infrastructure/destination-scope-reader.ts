import { db } from "../../../db";
import type {
  DestinationScopeReader,
} from "../application/destination-scope-reader";
import { loadDestinationScopes } from "./channel-shipping-policy.repository";

export class PostgresDestinationScopeReader implements DestinationScopeReader {
  async list() {
    return loadDestinationScopes(db);
  }
}
