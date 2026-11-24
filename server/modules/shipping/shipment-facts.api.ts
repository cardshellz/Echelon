/**
 * Shipping — Shipment Facts Internal API
 *
 * The single record of packages a shipping engine reports as shipped, and the
 * one definition of units shipped per purchased order line.
 */
export * from "./domain/shipment-fact.domain";
export * from "./infrastructure/shipment-fact.repository";
export * from "./application/shipstation-shipment-fact.mapper";
