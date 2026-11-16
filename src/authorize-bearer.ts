import { hasMachineAuthorizationHint, type AuthorizationStatus } from "./authorization-status.js";

/** One entry point for catch-all, batch and runtime data routes. The verifier
 * must cryptographically validate signature and applicable expiry before status sees the
 * claims, so callers cannot choose whether a status result is cacheable. */
export async function authorizeBearer<T extends Record<string, unknown>>(
  token: string,
  verify: (token: string) => Promise<T>,
  status: Pick<AuthorizationStatus,"check">,
  authentication: {jwksWellKnownUrl?:string | undefined; jwtSecret?:string | undefined},
):Promise<T> {
  const claims=await verify(token);
  await status.check(token,{claims,standaloneHmac:!authentication.jwksWellKnownUrl && !!authentication.jwtSecret});
  return claims;
}

/** Runtime inspection returns unfiltered trigger/capture values. It is an
 * administrator UI operation, not a data endpoint for machine credentials. */
export function canInspectRuntime(claims: Record<string, unknown>): boolean {
  return !hasMachineAuthorizationHint(claims) &&
    Array.isArray(claims["roles"]) && claims["roles"].includes("admin");
}
