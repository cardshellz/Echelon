export function storeOAuthEmailVerificationMessage(action: string): string {
  return `Verification code sent to your email address. Enter it below, then ${action}.`;
}
