/**
 * Microsoft Entra ID sign-in for `auth.mode: "entra"`: MSAL with the
 * authorization code flow and PKCE, through redirects (no popups to block).
 * The API takes the tenant from the token's `tid`, so this mode sends no
 * `X-Tenant-ID`.
 */

import {
  createStandardPublicClientApplication,
  InteractionRequiredAuthError,
  type AccountInfo,
  type IPublicClientApplication,
} from '@azure/msal-browser';

import type { EntraAuthConfig } from './config';

export interface EntraSession {
  /** The signed-in account, or null before sign-in. */
  readonly account: AccountInfo | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** An access token for the API; redirects to sign in again if it must. */
  accessToken(): Promise<string>;
}

export async function startEntraSession(config: EntraAuthConfig): Promise<EntraSession> {
  const scopes = [...config.scopes];
  const msal: IPublicClientApplication = await createStandardPublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: config.authority,
      redirectUri: window.location.origin,
      postLogoutRedirectUri: window.location.origin,
    },
    // Tokens live only as long as the tab.
    cache: { cacheLocation: 'sessionStorage' },
  });

  // Completes a sign-in redirect, if this page load is the return from one.
  const result = await msal.handleRedirectPromise();
  const account = result?.account ?? msal.getAllAccounts()[0] ?? null;
  if (account) msal.setActiveAccount(account);

  return {
    account,
    signIn: () => msal.loginRedirect({ scopes }),
    signOut: () => msal.logoutRedirect({ account: msal.getActiveAccount() }),
    async accessToken() {
      const active = msal.getActiveAccount();
      if (!active) throw new Error('Not signed in');
      try {
        return (await msal.acquireTokenSilent({ scopes, account: active })).accessToken;
      } catch (error) {
        // Consent or MFA needed, or the session expired: the page navigates away.
        if (error instanceof InteractionRequiredAuthError) await msal.acquireTokenRedirect({ scopes, account: active });
        throw error;
      }
    },
  };
}
