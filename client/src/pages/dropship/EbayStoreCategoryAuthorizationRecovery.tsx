import { useMemo, useState } from "react";
import { ArrowRight, Fingerprint, Mail, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import {
  buildStoreConnectionOAuthStartInput,
  postJson,
  queryErrorCode,
  type DropshipStoreConnectionOAuthStartResponse,
} from "@/lib/dropship-ops-surface";
import { dropshipPortalPath, isDropshipSensitiveProofActive, useDropshipAuth } from "@/lib/dropship-auth";
import { storeOAuthEmailVerificationMessage } from "./store-oauth-verification-copy";
import { StoreOAuthTargetConfirmationDialog } from "./StoreOAuthTargetConfirmationDialog";

type PendingEbayAuthorizationAction = "send-code" | "verify-code" | "passkey-proof" | "oauth-start" | null;
const EBAY_AUTHORIZATION_PERMISSION_ERROR_CODES = new Set([
  "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED",
  "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED",
]);

export function EbayStoreCategoryAuthorizationRecovery({
  error,
  storeConnectionId,
  storeName,
}: {
  error: unknown;
  storeConnectionId: number;
  storeName: string;
}) {
  const {
    principal,
    sensitiveProofs,
    startEmailStepUp,
    verifyEmailStepUp,
    verifyPasskeyStepUp,
  } = useDropshipAuth();
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingEbayAuthorizationAction>(null);
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const connectProofActive = useMemo(() => isDropshipSensitiveProofActive({
    principal,
    action: "connect_store",
    proof: sensitiveProofs.connect_store,
  }), [principal, sensitiveProofs.connect_store]);
  const permissionRequired = EBAY_AUTHORIZATION_PERMISSION_ERROR_CODES.has(
    queryErrorCode(error) ?? "",
  );

  async function run(
    action: Exclude<PendingEbayAuthorizationAction, null>,
    task: () => Promise<void>,
  ): Promise<boolean> {
    setPendingAction(action);
    setErrorMessage("");
    setMessage("");
    try {
      await task();
      return true;
    } catch (caught) {
      setErrorMessage(caught instanceof Error ? caught.message : "eBay authorization could not be started.");
      return false;
    } finally {
      setPendingAction(null);
    }
  }

  async function startAuthorization(): Promise<void> {
    if (!connectProofActive) {
      if (principal?.hasPasskey) {
        const verified = await run("passkey-proof", async () => {
          await verifyPasskeyStepUp("connect_store");
        });
        if (!verified) return;
      } else if (!emailCodeSent) {
        await run("send-code", async () => {
          await startEmailStepUp("connect_store");
          setEmailCodeSent(true);
          setVerificationCode("");
          setMessage(storeOAuthEmailVerificationMessage("refresh the eBay authorization"));
        });
        return;
      } else {
        if (verificationCode.length !== 6) {
          setErrorMessage("Enter the 6-digit verification code before refreshing the eBay authorization.");
          return;
        }
        const verified = await run("verify-code", async () => {
          await verifyEmailStepUp({
            action: "connect_store",
            verificationCode,
          });
        });
        if (!verified) return;
        setEmailCodeSent(false);
        setVerificationCode("");
      }
    }

    await run("oauth-start", async () => {
      const result = await postJson<DropshipStoreConnectionOAuthStartResponse>(
        "/api/dropship/store-connections/oauth/start",
        buildStoreConnectionOAuthStartInput({
          platform: "ebay",
          intent: "refresh_connection",
          storeConnectionId,
          shopDomain: "",
          returnTo: dropshipPortalPath("/catalog"),
        }),
      );
      window.location.assign(result.authorizationUrl);
    });
  }

  function cancelAuthorization(): void {
    setEmailCodeSent(false);
    setVerificationCode("");
    setMessage("");
    setErrorMessage("");
  }

  return (
    <>
      <EbayStoreCategoryAuthorizationRecoveryView
        connectProofActive={connectProofActive}
        emailCodeSent={emailCodeSent}
        errorMessage={errorMessage}
        hasPasskey={principal?.hasPasskey ?? false}
        message={message}
        pendingAction={pendingAction}
        permissionRequired={permissionRequired}
        storeName={storeName}
        verificationCode={verificationCode}
        onCancel={cancelAuthorization}
        onStart={emailCodeSent ? startAuthorization : () => setConfirmationOpen(true)}
        onVerificationCodeChange={setVerificationCode}
      />
      <StoreOAuthTargetConfirmationDialog
        intent="refresh_connection"
        open={confirmationOpen}
        target={{
          storeConnectionId,
          platform: "ebay",
          displayName: storeName,
          externalAccountId: null,
        }}
        onCancel={() => setConfirmationOpen(false)}
        onConfirm={() => {
          setConfirmationOpen(false);
          void startAuthorization();
        }}
      />
    </>
  );
}

export function EbayStoreCategoryAuthorizationRecoveryView({
  connectProofActive,
  emailCodeSent,
  errorMessage,
  hasPasskey,
  message,
  onCancel,
  onStart,
  onVerificationCodeChange,
  pendingAction,
  permissionRequired,
  storeName,
  verificationCode,
}: {
  connectProofActive: boolean;
  emailCodeSent: boolean;
  errorMessage: string;
  hasPasskey: boolean;
  message: string;
  onCancel: () => void;
  onStart: () => void;
  onVerificationCodeChange: (value: string) => void;
  pendingAction: PendingEbayAuthorizationAction;
  permissionRequired: boolean;
  storeName: string;
  verificationCode: string;
}) {
  const pending = pendingAction !== null;
  const actionText = permissionRequired ? "refresh eBay authorization" : "reconnect eBay store";
  const readyButtonLabel = permissionRequired ? `Refresh eBay authorization for ${storeName}` : `Reconnect ${storeName}`;
  const initialButtonLabel = pendingAction === "send-code"
    ? "Sending verification code"
    : pendingAction === "passkey-proof"
      ? "Waiting for passkey"
      : pendingAction === "oauth-start"
        ? "Opening eBay authorization"
        : connectProofActive
          ? readyButtonLabel
          : `Verify and ${actionText}`;
  const initialButtonIcon = pendingAction === "passkey-proof" || (!connectProofActive && hasPasskey)
    ? <Fingerprint className="h-4 w-4" />
    : !connectProofActive
      ? <Mail className="h-4 w-4" />
      : <RefreshCw className="h-4 w-4" />;

  return (
    <div className="mt-3">
      {message && (
        <div role="status" className="mb-3 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-emerald-950">
          {message}
        </div>
      )}
      {errorMessage && (
        <div role="alert" className="mb-3 rounded-md border border-rose-300 bg-rose-50 p-3 text-rose-900">
          {errorMessage}
        </div>
      )}
      {emailCodeSent ? (
        <div className="flex flex-col gap-3 rounded-md border border-amber-300 bg-white p-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <Label>Store authorization verification code</Label>
            <InputOTP
              maxLength={6}
              value={verificationCode}
              onChange={onVerificationCodeChange}
              disabled={pending}
            >
              <InputOTPGroup>
                {Array.from({ length: 6 }).map((_, index) => (
                  <InputOTPSlot key={index} index={index} className="h-10 w-10 text-sm" />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="button"
              className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
              disabled={pending || verificationCode.length !== 6}
              onClick={onStart}
            >
              <ArrowRight className="h-4 w-4" />
              {pendingAction === "verify-code" ? "Verifying code" : `Verify and continue to eBay for ${storeName}`}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2 border-amber-400 bg-white text-amber-950 hover:bg-amber-100"
          disabled={pending}
          onClick={onStart}
        >
          {initialButtonIcon}
          {initialButtonLabel}
        </Button>
      )}
    </div>
  );
}
