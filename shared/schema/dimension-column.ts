import { customType } from "drizzle-orm/pg-core";
import { databaseMillimetersSchema, storedMillimetersSchema } from "../shipping/dimensions";

// Keep numeric DTOs without changing pg's global numeric parser (money must
// remain decimal-safe). This precision also covers legacy integer millimeters.
export const dimensionMillimeters = customType<{ data: number; driverData: string }>({
  dataType: () => "numeric(14,4)",
  fromDriver: (value) => databaseMillimetersSchema.parse(value),
  toDriver: (value) => storedMillimetersSchema.parse(value).toString(),
});
