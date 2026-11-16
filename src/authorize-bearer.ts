import type { AuthorizationStatus } from "./authorization-status.js";

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
