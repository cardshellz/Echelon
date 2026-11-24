type DateValue = string | Date | null | undefined;

export type DeliveryScheduleRecord = {
  status?: string | null;
  physicalStatus?: string | null;
  sentToVendorAt?: DateValue;
  orderDate?: DateValue;
  createdAt?: DateValue;
  expectedDeliveryDate?: DateValue;
  confirmedDeliveryDate?: DateValue;
};

export type DeliverySchedulePatch = {
  expectedDeliveryDate?: Date | null;
  confirmedDeliveryDate?: Date | null;
};

export type DeliveryScheduleValidationIssue = {
  code:
    | "INVALID_EXPECTED_DELIVERY_DATE"
    | "INVALID_CONFIRMED_DELIVERY_DATE"
    | "EXPECTED_DELIVERY_BEFORE_PO"
    | "CONFIRMED_DELIVERY_BEFORE_PO"
    | "CONFIRMED_DELIVERY_BEFORE_SEND";
  field: "expectedDeliveryDate" | "confirmedDeliveryDate";
  message: string;
};

const PRE_SEND_STATUSES = new Set(["draft", "pending_approval", "approved"]);

export function coerceDeliveryDate(value: DateValue): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function utcDateStamp(value: DateValue): number | null {
  const date = coerceDeliveryDate(value);
  if (!date) return null;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function firstValidDate(...values: DateValue[]): Date | null {
  for (const value of values) {
    const date = coerceDeliveryDate(value);
    if (date) return date;
  }
  return null;
}

export function resolvePoSubmissionDate(record: DeliveryScheduleRecord): Date | null {
  return firstValidDate(record.sentToVendorAt, record.orderDate, record.createdAt);
}

export function validateDeliverySchedulePatch(
  record: DeliveryScheduleRecord,
  patch: DeliverySchedulePatch,
): DeliveryScheduleValidationIssue[] {
  const issues: DeliveryScheduleValidationIssue[] = [];
  const submissionDate = resolvePoSubmissionDate(record);
  const submissionDay = utcDateStamp(submissionDate);

  if (patch.expectedDeliveryDate !== undefined && patch.expectedDeliveryDate !== null) {
    const expectedDay = utcDateStamp(patch.expectedDeliveryDate);
    if (expectedDay === null) {
      issues.push({
        code: "INVALID_EXPECTED_DELIVERY_DATE",
        field: "expectedDeliveryDate",
        message: "Requested delivery date must be a valid date.",
      });
    } else if (submissionDay !== null && expectedDay < submissionDay) {
      issues.push({
        code: "EXPECTED_DELIVERY_BEFORE_PO",
        field: "expectedDeliveryDate",
        message: "Requested delivery date cannot be before the PO submission date.",
      });
    }
  }

  if (patch.confirmedDeliveryDate !== undefined && patch.confirmedDeliveryDate !== null) {
    const confirmedDay = utcDateStamp(patch.confirmedDeliveryDate);
    const currentStatus = record.physicalStatus && record.physicalStatus !== "draft"
      ? record.physicalStatus
      : record.status ?? record.physicalStatus ?? "draft";
    if (confirmedDay === null) {
      issues.push({
        code: "INVALID_CONFIRMED_DELIVERY_DATE",
        field: "confirmedDeliveryDate",
        message: "Vendor confirmed delivery date must be a valid date.",
      });
    } else if (PRE_SEND_STATUSES.has(currentStatus)) {
      issues.push({
        code: "CONFIRMED_DELIVERY_BEFORE_SEND",
        field: "confirmedDeliveryDate",
        message: "Vendor confirmed delivery date can only be recorded after the PO is sent.",
      });
    } else if (submissionDay !== null && confirmedDay < submissionDay) {
      issues.push({
        code: "CONFIRMED_DELIVERY_BEFORE_PO",
        field: "confirmedDeliveryDate",
        message: "Vendor confirmed delivery date cannot be before the PO submission date.",
      });
    }
  }

  return issues;
}

export function isConfirmedDeliveryDateInvalid(record: DeliveryScheduleRecord): boolean {
  if (record.confirmedDeliveryDate === null || record.confirmedDeliveryDate === undefined) return false;
  const confirmed = coerceDeliveryDate(record.confirmedDeliveryDate);
  if (!confirmed) return true;
  return validateDeliverySchedulePatch(record, { confirmedDeliveryDate: confirmed })
    .some((issue) => issue.field === "confirmedDeliveryDate");
}

export function resolveEffectiveDeliveryDate(record: DeliveryScheduleRecord): Date | null {
  if (!isConfirmedDeliveryDateInvalid(record)) {
    const confirmed = coerceDeliveryDate(record.confirmedDeliveryDate);
    if (confirmed) return confirmed;
  }
  return coerceDeliveryDate(record.expectedDeliveryDate);
}

export function sameDeliveryDate(left: DateValue, right: DateValue): boolean {
  const leftDate = coerceDeliveryDate(left);
  const rightDate = coerceDeliveryDate(right);
  if (!leftDate || !rightDate) return leftDate === rightDate;
  return leftDate.getTime() === rightDate.getTime();
}

export function deliveryDateIso(value: DateValue): string | null {
  return coerceDeliveryDate(value)?.toISOString() ?? null;
}
