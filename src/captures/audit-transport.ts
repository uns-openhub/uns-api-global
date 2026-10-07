import type { AuditEvent } from "./audit-outbox.js";
export async function sendCaptureAudit(options: {
  controllerRestUrl: string;
  getAccessToken: () => Promise<string | null | undefined>;
  event: AuditEvent;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 5000);
  const timeout = new Promise<never>((_resolve, reject) =>
    abort.signal.addEventListener(
      "abort",
      () => reject(new Error("Capture audit timeout")),
      { once: true },
    ),
  );
  try {
    const token = await Promise.race([options.getAccessToken(), timeout]);
    if (!token) throw new Error("Capture audit credential unavailable");
    const response = await Promise.race([
      (options.fetchImpl ?? fetch)(
        options.controllerRestUrl.replace(/\/+$/, "") + "/captures/sessions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(options.event),
          signal: abort.signal,
        },
      ),
      timeout,
    ]);
    if (!response.ok) throw new Error("Capture audit not acknowledged");
    const body = (await Promise.race([response.json(), timeout])) as {
      ok?: unknown;
      id?: unknown;
    };
    if (body.ok !== true || typeof body.id !== "string" || !body.id)
      throw new Error("Capture audit acknowledgement invalid");
  } catch {
    throw new Error(
      "Capture audit delivery is unavailable; retained checkpoint will be retried.",
    );
  } finally {
    clearTimeout(timer);
  }
}
