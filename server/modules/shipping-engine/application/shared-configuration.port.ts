import type { z } from "zod";
import type { CartonizeBox } from "../../cartonization/domain/cartonize";
import type {
  BoxSuiteSummary,
  DropshipSharedShippingConfig,
  FulfillmentChannel,
  PackagingAssignment,
  PackagingConfiguration,
  ProgramCharges,
  saveBoxSuiteSchema,
  saveDropshipProgramSchema,
  saveFulfillmentServiceSchema,
  savePackagingAssignmentSchema,
  saveProgramChargesSchema,
} from "@shared/shipping/configuration";

export interface SharedShippingConfigurationStore {
  listPackaging(): Promise<PackagingConfiguration>;
  loadPackaging(
    channel: FulfillmentChannel,
    warehouseId: number,
  ): Promise<{
    suiteId: number;
    suiteRevision: number;
    assignmentRevision: number;
    boxes: CartonizeBox[];
  }>;
  saveSuite(
    input: z.infer<typeof saveBoxSuiteSchema>,
    actor: string,
    now: Date,
  ): Promise<BoxSuiteSummary>;
  saveAssignment(
    input: z.infer<typeof savePackagingAssignmentSchema>,
    actor: string,
    now: Date,
  ): Promise<PackagingAssignment>;
  readChargeConfiguration(
    bookId: number,
  ): Promise<{ revision: number; charges: ProgramCharges }>;
  saveCharges(
    bookId: number,
    input: z.infer<typeof saveProgramChargesSchema>,
    actor: string,
    now: Date,
  ): Promise<{ revision: number; charges: ProgramCharges }>;
  dropshipConfig(
    channelId: number | null,
  ): Promise<DropshipSharedShippingConfig>;
  saveDropshipProgram(
    input: z.infer<typeof saveDropshipProgramSchema>,
    actor: string,
    now: Date,
  ): Promise<{ warehouseId: number | null; rateBookId: number }>;
  saveService(
    input: z.infer<typeof saveFulfillmentServiceSchema>,
    actor: string,
    now: Date,
  ): Promise<{ id: number; revision: number }>;
  history(key: string): Promise<unknown[]>;
}
