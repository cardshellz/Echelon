export class ControlTowerRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export function parsePositiveWorkItemId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ControlTowerRequestError("A valid work item id is required", 400, "INVALID_WORK_ITEM_ID");
  }
  return parsed;
}

export function parseWorkItemVersion(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ControlTowerRequestError("A valid work item version is required", 400, "INVALID_WORK_ITEM_VERSION");
  }
  return parsed;
}
