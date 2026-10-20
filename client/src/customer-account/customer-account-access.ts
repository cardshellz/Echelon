import { CUSTOMER_ACCOUNT_SIGN_IN_REQUIRED } from "@shared/customer-account/customer-account.contract";
import { CustomerAccountRequestError } from "./customer-account.transport";

export interface CustomerAccountAccessNotice {
  message: string;
  action: "sign_in" | "retry";
}

/** Display copy belongs to the storefront. A legacy login error also covered
 * configuration/proof failures, so it must never imply that a shopper signed out. */
export function customerAccountAccessNotice(cause: unknown): CustomerAccountAccessNotice {
  if (cause instanceof CustomerAccountRequestError && cause.code === CUSTOMER_ACCOUNT_SIGN_IN_REQUIRED) {
    return { message: "Your sign-in is no longer active. Sign in again to make changes.", action: "sign_in" };
  }
  return { message: "We couldn't load the options for your order. Please try again.", action: "retry" };
}

export function customerAccountSignInUrl(loginPath: string, returnPath: string): string {
  const origin = "https://account.invalid";
  const login = new URL(loginPath, origin);
  const destination = new URL(returnPath, origin);
  if (login.origin !== origin || destination.origin !== origin || login.username || login.password
    || destination.username || destination.password) throw new Error("Account navigation must stay on the storefront.");
  login.searchParams.set("return_url", `${destination.pathname}${destination.search}`);
  return `${login.pathname}${login.search}`;
}
