export class AccessManagementRequestError extends Error {
  constructor(readonly lastAccessManager: boolean, fallback: string) {
    super(lastAccessManager
      ? "This change would remove the last active access manager. Assign an appropriate replacement first."
      : fallback);
  }
}

export async function readAccessManagementFailure(response: Response, fallback: string): Promise<AccessManagementRequestError> {
  const body: unknown = await response.json().catch(() => null);
  const lastAccessManager = response.status === 409 && typeof body === "object" && body !== null
    && "code" in body && body.code === "IDENTITY_LAST_ACCESS_MANAGER";
  return new AccessManagementRequestError(lastAccessManager, fallback);
}
