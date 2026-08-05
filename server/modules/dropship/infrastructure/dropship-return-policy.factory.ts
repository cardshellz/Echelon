import {
  DropshipReturnPolicyService,
  makeDropshipReturnPolicyLogger,
  systemDropshipReturnPolicyClock,
} from "../application/dropship-return-policy-service";
import { PgDropshipReturnPolicyRepository } from "./dropship-return-policy.repository";

export function createDropshipReturnPolicyServiceFromEnv(): DropshipReturnPolicyService {
  return new DropshipReturnPolicyService({
    repository: new PgDropshipReturnPolicyRepository(),
    clock: systemDropshipReturnPolicyClock,
    logger: makeDropshipReturnPolicyLogger(),
  });
}
