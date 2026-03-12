import type { ServiceRegistry } from "./services";

declare global {
  namespace Express {
    interface Locals {
      services: ServiceRegistry;
    }
  }
}
