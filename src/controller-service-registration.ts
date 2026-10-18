/** Best-effort lifecycle registration. A controller restart must not abort API
 * handler/cache/automation initialization. The owning client bounds each request;
 * callers share one attempt and the existing health timer supplies retry cadence.
 */
export class ControllerServiceRegistration {
  private pending: Promise<boolean> | undefined;
  private reported: boolean | undefined;
  constructor(private readonly register: () => Promise<void>, private readonly onState?: (ready: boolean) => void) {}

  refresh(): Promise<boolean> {
    if (this.pending) return this.pending;
    const attempt = this.attempt().finally(() => { if (this.pending === attempt) this.pending = undefined; });
    this.pending = attempt;
    return attempt;
  }

  private async attempt(): Promise<boolean> {
    let ready = false;
    try { await this.register(); ready = true; }
    catch { /* No raw HTTP errors, token material or controller response bodies. */ }
    if (this.reported !== ready) { this.reported = ready; this.onState?.(ready); }
    return ready;
  }
}
