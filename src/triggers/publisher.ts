// src/triggers/publisher.ts
//
// Constructs the UNS packet a fired trigger emits and hands it to an injected
// publish function. The actual MQTT publish wiring lives in src/index.ts (where
// the existing UnsProxyProcess + controller token provider are scoped) — this module is a pure
// adapter so it stays unit-testable.
//
// Output shape mirrors what `updateLastValue` parses on the SUBSCRIBE side (see
// src/index.ts): `message.data = { value, uom, time, dataGroup }`.
//
// Trigger-specific metadata belongs in the trigger fire audit path. The UNS
// output itself stays a standard `message.data` packet so archiver and other
// consumers parse it through @uns-kit/core without ad-hoc payload branches.

import { UnsPacket } from "@uns-kit/core/uns/uns-packet.js";
import { isIOS8601Type, type ISO8601, type IUnsPacket } from "@uns-kit/core/uns/uns-interfaces.js";
import type { MeasurementUnit } from "@uns-kit/core/uns/uns-measurements.js";
import type { TriggerDefinition, TriggerFireRequest } from "./types.js";

/** The function the orchestrator hands to the publisher. In production this
 * wraps a UnsProxyProcess MQTT publish; in tests it's a spy. Async so the
 * publisher can await flushes if the underlying transport buffers. */
export type PublishFn = (params: {
  outputTopic: string;
  payload: string;
}) => Promise<void> | void;

export type TriggerPublisherDeps = {
  publish: PublishFn;
  /** Wall-clock source. Injected so tests can pin the fire time without mocking
   * globals. Defaults to Date.now. */
  now?: () => number;
};

export class TriggerPublisher {
  private readonly publish: PublishFn;
  private readonly now: () => number;

  constructor(deps: TriggerPublisherDeps) {
    this.publish = deps.publish;
    this.now = deps.now ?? (() => Date.now());
  }

  async fire(req: TriggerFireRequest): Promise<void> {
    const payload = await this.buildPayload(req);
    await this.publish({
      outputTopic: req.trigger.outputTopic,
      payload: JSON.stringify(payload),
    });
  }

  /** Public for tests — same packet the publisher would push. */
  async buildPayload(req: TriggerFireRequest): Promise<IUnsPacket> {
    const fireTime = new Date(this.now()).toISOString();
    const outputUom = resolveTriggerOutputUom(req.trigger, req.uom);
    const packet = await UnsPacket.unsPacketFromUnsMessage({
      data: {
        value: req.value,
        time: asIso8601(fireTime, "fireTime"),
        dataGroup: "trigger",
        foreignEventKey: req.trigger.id,
        ...(outputUom ? { uom: outputUom as MeasurementUnit } : {}),
      },
    });
    if (!packet) throw new Error("Could not build trigger UNS packet.");
    return packet;
  }
}

export function resolveTriggerOutputUom(
  trigger: TriggerDefinition,
  sourceUom: string | null,
): string | null {
  const config = trigger.config as { uomMode?: unknown; uom?: unknown };
  if (config.uomMode === "none") return null;
  if (config.uomMode === "override") {
    const override = typeof config.uom === "string" ? config.uom.trim() : "";
    return override || null;
  }
  const inherited = typeof sourceUom === "string" ? sourceUom.trim() : "";
  return inherited || null;
}

function asIso8601(value: string, fieldName: string): ISO8601 {
  if (isIOS8601Type(value)) return value;
  throw new Error(`Trigger fire ${fieldName} must be ISO8601.`);
}
