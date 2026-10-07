import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RegistryHealth } from "../controller-registry-health.js";
import type { CaptureSessionAuditEvent } from "./service.js";

export type AuditEvent = CaptureSessionAuditEvent & { runtimeProcess?: string };
type Entry = {
  event: AuditEvent;
  version: number;
  durable: boolean;
  acknowledged?: boolean;
  bytes: number;
};
export type AuditOutboxOptions = {
  directory: string;
  send: (event: AuditEvent) => Promise<void>;
  onHealthChange?: (health: RegistryHealth) => void;
  maxSessions?: number;
  maxBytes?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
};

/** One latest checkpoint per session. No credential or measurement values are stored. */
export class CaptureAuditOutbox {
  private entries = new Map<string, Entry>();
  private writes: Promise<void> = Promise.resolve();
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private initialized = false;
  private storageFailed = false;
  private deliveryFailed = false;
  private delay: number;
  constructor(private options: AuditOutboxOptions) {
    this.delay = options.retryMinMs ?? 1000;
  }
  canRecord(): boolean {
    return this.initialized && !this.storageFailed && !this.stopped;
  }
  pendingCount(): number {
    return [...this.entries.values()].filter((entry) => !entry.acknowledged)
      .length;
  }
  health(): RegistryHealth {
    const healthy =
      this.initialized && !this.storageFailed && !this.deliveryFailed;
    return {
      id: "capture-audit",
      label: "Capture session audit",
      healthy,
      state: healthy ? "healthy" : "degraded",
      checkedAt: new Date().toISOString(),
      ...(!healthy
        ? {
            message: this.storageFailed
              ? "Local capture audit storage is unavailable or full. New capture rows are paused; retained audit must be recovered."
              : `Capture audit delivery is unavailable. ${this.pendingCount()} session checkpoints are retained locally for retry.`,
          }
        : {}),
    };
  }
  private changed(): void {
    this.options.onHealthChange?.(this.health());
  }
  async start(): Promise<void> {
    try {
      await this.load();
    } catch {
      this.initialized = false;
      this.storageFailed = true;
      this.changed();
      throw new Error(
        "Capture audit storage requires recovery; recording is paused.",
      );
    }
  }
  private async load(): Promise<void> {
    this.stopped = false;
    this.entries.clear();
    await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(this.options.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error("Capture audit directory is not a private directory.");
    await fs.chmod(this.options.directory, 0o700);
    for (const file of await fs.readdir(this.options.directory)) {
      if (!file.endsWith(".json")) continue; // incomplete temp files are never replayed
      if (!/^[a-f0-9]{64}\.json$/.test(file))
        throw new Error("Unexpected capture audit checkpoint file.");
      const filename = path.join(this.options.directory, file);
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
        throw new Error("Unsafe capture audit checkpoint.");
      const parsed = JSON.parse(await fs.readFile(filename, "utf8")) as {
        schemaVersion?: number;
        event?: AuditEvent;
        version?: number;
      };
      if (
        parsed.schemaVersion !== 1 ||
        !validEvent(parsed.event) ||
        !Number.isSafeInteger(parsed.version) ||
        (parsed.version ?? 0) < 1 ||
        this.key(parsed.event) !== file
      )
        throw new Error(
          "Invalid capture audit checkpoint; recovery is required.",
        );
      this.entries.set(file, {
        event: parsed.event,
        version: parsed.version!,
        durable: true,
        bytes: stat.size,
      });
      this.checkCapacity();
    }
    // A prior open session cannot resume across a runtime restart. Its latest
    // emitted-row checkpoint remains truthful; close it without new output.
    for (const [key, entry] of this.entries)
      if (entry.event.eventType === "started") {
        entry.event = {
          ...entry.event,
          eventType: "closed",
          endedAt: new Date().toISOString(),
          closeReason: "runtimeRestart",
        };
        entry.version++;
        entry.durable = false;
        await this.write(key, entry);
      }
    this.initialized = true;
    this.changed();
    this.schedule(0);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.writes;
    await this.flushing;
  }
  async enqueue(event: AuditEvent): Promise<void> {
    if (!validEvent(event) || !this.initialized || this.stopped)
      throw new Error("Capture audit queue is not available.");
    return this.serialize(async () => {
      const key = this.key(event),
        old = this.entries.get(key);
      // Once closed, a delayed open/progress report can never reopen this session.
      if (old?.event.eventType === "closed" && event.eventType !== "closed")
        return;
      const merged = old
        ? {
            ...event,
            rowCount: Math.max(old.event.rowCount ?? 0, event.rowCount ?? 0),
          }
        : { ...event };
      const entry: Entry = {
        event: merged,
        version: (old?.version ?? 0) + 1,
        durable: false,
        bytes: 0,
      };
      entry.bytes = this.encode(entry).length;
      if (
        entry.bytes > 16384 ||
        (!old && this.entries.size >= (this.options.maxSessions ?? 1000)) ||
        this.bytes() - (old?.bytes ?? 0) + entry.bytes >
          (this.options.maxBytes ?? 4 * 1024 * 1024)
      ) {
        this.storageFailed = true;
        this.changed();
        throw new Error(
          "Capture audit queue capacity reached; pending evidence is retained.",
        );
      }
      this.entries.set(key, entry);
      try {
        await this.write(key, entry);
        this.storageFailed = false;
      } catch {
        this.storageFailed = true;
        this.changed();
        this.schedule(this.delay);
        throw new Error("Capture audit checkpoint could not be persisted.");
      }
      this.changed();
      this.schedule(0);
    });
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const pending = this.flushOnce();
    this.flushing = pending;
    void pending
      .finally(() => {
        if (this.flushing === pending) this.flushing = null;
      })
      .catch(() => undefined);
    return pending;
  }
  private async flushOnce(): Promise<void> {
    if (this.stopped || !this.initialized) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      for (const [key] of this.entries) {
        let entry: Entry | undefined;
        await this.serialize(async () => {
          entry = this.entries.get(key);
          if (entry && !entry.durable) await this.write(key, entry);
        });
        if (!entry || entry.acknowledged) continue;
        const sending = entry;
        await this.options.send(sending.event);
        await this.serialize(async () => {
          if (this.entries.get(key)?.version !== sending.version) return;
          // Retain acknowledged open checkpoints until close: a restart must
          // close the session even when its last progress update was delivered.
          if (sending.event.eventType === "started") {
            sending.acknowledged = true;
            return;
          }
          await fs.rm(path.join(this.options.directory, key), { force: true });
          await this.syncDirectory();
          this.entries.delete(key);
        });
      }
      this.storageFailed = false;
      this.deliveryFailed = false;
      this.delay = this.options.retryMinMs ?? 1000;
    } catch {
      // Keep the same identity and checkpoint. Ack failures cannot erase evidence.
      this.deliveryFailed = true;
      this.delay = Math.min(
        this.options.retryMaxMs ?? 30_000,
        Math.max(this.options.retryMinMs ?? 1000, this.delay * 2),
      );
    }
    this.changed();
    if (this.pendingCount()) this.schedule(this.delay);
  }
  private schedule(ms: number): void {
    if (this.stopped || !this.initialized || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
    this.timer.unref?.();
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    this.writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private key(event: AuditEvent): string {
    return (
      createHash("sha256")
        .update(event.captureId + "\0" + event.sessionId)
        .digest("hex") + ".json"
    );
  }
  private encode(entry: Entry): Buffer {
    return Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        version: entry.version,
        event: entry.event,
      }),
    );
  }
  private bytes(): number {
    return [...this.entries.values()].reduce((n, e) => n + e.bytes, 0);
  }
  private checkCapacity(): void {
    if (
      this.entries.size > (this.options.maxSessions ?? 1000) ||
      this.bytes() > (this.options.maxBytes ?? 4 * 1024 * 1024)
    )
      throw new Error(
        "Capture audit queue exceeds capacity; recovery is required.",
      );
  }
  private async write(key: string, entry: Entry): Promise<void> {
    const data = this.encode(entry),
      tmp = path.join(
        this.options.directory,
        "." + key + "." + randomUUID() + ".tmp",
      );
    try {
      const handle = await fs.open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, path.join(this.options.directory, key));
      await this.syncDirectory();
      entry.durable = true;
      entry.bytes = data.length;
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }
  private async syncDirectory(): Promise<void> {
    const dir = await fs.open(this.options.directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}
function validEvent(event: AuditEvent | undefined): event is AuditEvent {
  return (
    !!event &&
    ["started", "closed"].includes(event.eventType) &&
    [
      event.captureId,
      event.sessionId,
      event.captureName,
      event.outputTopic,
    ].every((v) => typeof v === "string" && v.length > 0 && v.length <= 4096) &&
    Number.isFinite(Date.parse(event.startedAt)) &&
    (event.eventType !== "closed" ||
      Number.isFinite(Date.parse(event.endedAt ?? ""))) &&
    Number.isSafeInteger(event.rowCount ?? 0) &&
    (event.rowCount ?? 0) >= 0
  );
}
