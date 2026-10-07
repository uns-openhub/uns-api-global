export type RegistryHealth = {
  id: string;
  label: string;
  healthy: boolean;
  state: "healthy" | "degraded";
  checkedAt: string;
  message?: string;
};
export type RegistryRefreshOptions = {
  now?: () => number;
  requestTimeoutMs?: number;
  maxStaleMs?: number;
  onHealthChange?: (health: RegistryHealth) => void;
};

/** Authorization loss is distinct from a short transport outage. */
export class ControllerRegistryHealth {
  private checkedAt = 0;
  private expiresAt = Infinity;
  private accepted = false;
  private state: RegistryHealth;
  readonly now: () => number;
  constructor(
    private id: string,
    private label: string,
    private options: RegistryRefreshOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.state = {
      id,
      label,
      healthy: false,
      state: "degraded",
      checkedAt: new Date(this.now()).toISOString(),
      message:
        "Controller definitions have not been checked; execution is paused.",
    };
  }
  get(): RegistryHealth {
    return { ...this.state };
  }
  private tokenExpiry(token: string): number {
    try {
      const part = token.split(".")[1];
      if (!part) return Infinity;
      const claims = JSON.parse(Buffer.from(part, "base64url").toString()) as {
        exp?: unknown;
      };
      return typeof claims.exp === "number" && Number.isFinite(claims.exp)
        ? claims.exp * 1000
        : Infinity;
    } catch {
      return Infinity;
    }
  }
  tokenExpired(token: string): boolean {
    return this.tokenExpiry(token) <= this.now();
  }
  success(token: string): void {
    this.expiresAt = this.tokenExpiry(token);
    this.accepted = true;
    this.checkedAt = this.now();
    this.report(true);
  }
  authorizationFailure(): void {
    this.accepted = false;
    this.report(
      false,
      "Controller authorization is unavailable. Cached definitions are not evaluated; check the managed service credential.",
    );
  }
  transportFailure(): void {
    this.report(
      false,
      "Controller definitions could not be refreshed. Cached execution is limited to the last checked configuration grace period.",
    );
  }
  allowed(): boolean {
    const valid =
      this.accepted &&
      this.now() < this.expiresAt &&
      this.now() >= this.checkedAt &&
      this.now() - this.checkedAt < (this.options.maxStaleMs ?? 120_000);
    if (!valid && this.accepted) {
      this.accepted = false;
      this.report(
        false,
        "Checked controller definitions are stale or their credential expired. Execution is paused until an authenticated refresh succeeds.",
      );
    }
    return valid;
  }
  private report(healthy: boolean, message?: string): void {
    this.state = {
      id: this.id,
      label: this.label,
      healthy,
      state: healthy ? "healthy" : "degraded",
      checkedAt: new Date(this.now()).toISOString(),
      ...(message ? { message } : {}),
    };
    this.options.onHealthChange?.(this.get());
  }
}
