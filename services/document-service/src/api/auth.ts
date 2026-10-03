/**
 * Authentication: Microsoft Entra ID access tokens validated against the JWKS.
 *
 * Keys are shared across tenants on the `common` endpoint; jose's remote JWK
 * set caches them and refetches when a new `kid` is encountered. Because the
 * app is multi-tenant, the issuer is validated per token against the token's
 * own `tid`, and that `tid` must be an onboarded customer.
 *
 * `AuthGuard` runs on every route except those marked `@Public()`, and stores
 * the principal and resolved tenant on the request for the `@Tenant()` and
 * `@CurrentPrincipal()` parameter decorators.
 */

import {
  createParamDecorator,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { errorMessage, getLogger } from '@docprocessor/shared';
import type { Request } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

import type { Settings } from '../config.js';
import { ApiError } from './api-error.js';

const logger = getLogger('document_service.api.auth');

const TENANT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export interface Principal {
  readonly subject: string;
  readonly tenantId: string;
}

export interface AuthenticatedRequest extends Request {
  principal?: Principal;
  tenantId?: string;
}

const IS_PUBLIC = Symbol('isPublic');

/** Exempt a route (e.g. probes) from authentication. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

function unauthorized(detail: string): ApiError {
  return new ApiError(401, detail, { 'WWW-Authenticate': 'Bearer' });
}

/**
 * v2.0 and v1.0 access tokens use different issuer formats; which one an app
 * receives depends on its manifest's `accessTokenAcceptedVersion`.
 */
function expectedIssuers(tenantId: string): Set<string> {
  return new Set([`https://login.microsoftonline.com/${tenantId}/v2.0`, `https://sts.windows.net/${tenantId}/`]);
}

type AuthSettings = Pick<
  Settings,
  'authEnabled' | 'azureAdAudience' | 'azureAdJwksUrl' | 'azureAdRequiredScope' | 'allowedTenantIds'
>;

export class TokenVerifier {
  private keys: JWTVerifyGetKey | undefined;

  /** `keys` defaults to the configured remote JWKS; tests pass a local key set. */
  constructor(
    private readonly settings: AuthSettings,
    keys?: JWTVerifyGetKey,
  ) {
    this.keys = keys;
  }

  private getKeys(): JWTVerifyGetKey {
    this.keys ??= createRemoteJWKSet(new URL(this.settings.azureAdJwksUrl));
    return this.keys;
  }

  private hasRequiredPermission(claims: JWTPayload): boolean {
    const required = this.settings.azureAdRequiredScope;
    if (!required) {
      return true;
    }
    const scopes = typeof claims.scp === 'string' ? claims.scp.split(/\s+/) : [];
    const roles = claims.roles;
    return scopes.includes(required) || (Array.isArray(roles) && roles.includes(required));
  }

  /**
   * Validate the `Authorization: Bearer <jwt>` header.
   *
   * Verifies the RS256 signature, audience, expiry, per-tenant issuer, tenant
   * allow-list and (optionally) the required scope / app role. With auth
   * disabled (local development only) the tenant is taken from `X-Tenant-ID`
   * (or defaults to `local-tenant`).
   */
  async verify(authorization: string | undefined, headerTenantId: string | undefined): Promise<Principal> {
    if (!this.settings.authEnabled) {
      return { subject: 'local-dev', tenantId: headerTenantId ?? 'local-tenant' };
    }
    if (!authorization || !authorization.toLowerCase().startsWith('bearer ')) {
      throw unauthorized('Missing or malformed Authorization header');
    }
    const token = authorization.slice('bearer '.length).trim();

    let claims: JWTPayload;
    try {
      ({ payload: claims } = await jwtVerify(token, this.getKeys(), {
        algorithms: ['RS256'],
        audience: this.settings.azureAdAudience,
        requiredClaims: ['exp', 'iss', 'aud', 'tid'],
      }));
    } catch (error) {
      logger.warn('token_validation_failed', { error: errorMessage(error) });
      throw unauthorized('Invalid or expired token');
    }

    const tenantId = String(claims.tid).toLowerCase();
    if (!claims.iss || !expectedIssuers(tenantId).has(claims.iss)) {
      logger.warn('token_issuer_mismatch', { tenant_id: tenantId });
      throw unauthorized('Invalid token issuer');
    }
    if (!this.settings.allowedTenantIds.has(tenantId)) {
      logger.warn('tenant_not_allowed', { tenant_id: tenantId });
      throw new ApiError(403, 'Tenant is not onboarded');
    }
    if (!this.hasRequiredPermission(claims)) {
      throw new ApiError(403, `Token lacks required permission '${this.settings.azureAdRequiredScope}'`);
    }
    return { subject: String(claims.sub ?? 'unknown'), tenantId };
  }
}

/**
 * The tenant always comes from the authenticated token. `X-Tenant-ID` is
 * optional; if a client sends it, it must match the token's tenant.
 */
export function resolveTenantId(principal: Principal, headerTenantId: string | undefined): string {
  const tenantId = principal.tenantId;
  if (headerTenantId !== undefined && headerTenantId.toLowerCase() !== tenantId.toLowerCase()) {
    logger.warn('tenant_header_mismatch', { token_tenant_id: tenantId, header_tenant_id: headerTenantId });
    throw new ApiError(403, 'X-Tenant-ID does not match the authenticated tenant');
  }
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new ApiError(400, 'Invalid tenant ID');
  }
  return tenantId;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const headerTenantId = request.header('x-tenant-id');
    const principal = await this.verifier.verify(request.header('authorization'), headerTenantId);
    request.principal = principal;
    request.tenantId = resolveTenantId(principal, headerTenantId);
    return true;
  }
}

/** The caller's tenant, as resolved by `AuthGuard`. */
export const Tenant = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  const tenantId = context.switchToHttp().getRequest<AuthenticatedRequest>().tenantId;
  if (tenantId === undefined) {
    throw new Error('@Tenant() used on a route without AuthGuard');
  }
  return tenantId;
});

/** The authenticated principal, as resolved by `AuthGuard`. */
export const CurrentPrincipal = createParamDecorator((_: unknown, context: ExecutionContext): Principal => {
  const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().principal;
  if (principal === undefined) {
    throw new Error('@CurrentPrincipal() used on a route without AuthGuard');
  }
  return principal;
});
