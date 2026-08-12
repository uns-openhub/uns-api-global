/**
 * Change this file according to your specifications and rename it to index.ts
 */

import { UnsProxyProcess, ConfigFile, logger, mqttChannelParameters, resolveMqttChannel, type MqttChannelConfig } from "@uns-kit/core";
import { registerAttributeDescriptions, registerObjectTypeDescriptions } from "@uns-kit/core/uns/uns-dictionary-registry.js";
import { UnsTopics } from "@uns-kit/core/uns/uns-topics.js";
import {
  GeneratedObjectTypes,
  GeneratedAttributes,
  GeneratedAttributeDescriptions,
  GeneratedObjectTypeDescriptions,
} from "../uns/uns-dictionary.generated.js";
import { GeneratedAssets, resolveGeneratedAsset } from "../uns/uns-assets.js";
import type { IUnsTableColumns } from "@uns-kit/core/uns/uns-interfaces.js";
import type { ISO8601 } from "@uns-kit/core/uns/uns-interfaces.js";
import { GeneratedPhysicalMeasurements } from "../uns/uns-measurements.generated.js";

/**
 * Load the configuration from a file.
 * On the server, this file is provided by the `uns-datahub-controller`.
 * In the development environment, you are responsible for creating and maintaining this file and its contents.
 */
const config = await ConfigFile.loadConfig();
registerObjectTypeDescriptions(GeneratedObjectTypeDescriptions);
registerAttributeDescriptions(GeneratedAttributeDescriptions);

/**
 * Input and output inherit the full MQTT connection from infra unless they
 * intentionally override individual channel settings.
 */
const infraChannel = resolveMqttChannel(config.infra as MqttChannelConfig);
const inputChannel = resolveMqttChannel(config.infra as MqttChannelConfig, config.input as MqttChannelConfig | undefined);
const outputChannel = resolveMqttChannel(config.infra as MqttChannelConfig, config.output as MqttChannelConfig | undefined);
const unsProxyProcess = new UnsProxyProcess(infraChannel.host, {
  processName: config.uns.processName!,
  ...mqttChannelParameters(infraChannel),
});
const mqttInput = await unsProxyProcess.createUnsMqttProxy(inputChannel.host, "templateUnsRttInput", config.uns.instanceMode!, config.uns.handover!, {
  ...mqttChannelParameters(inputChannel),
  mqttSubToTopics: ["raw/#"],
});
const mqttOutput = await unsProxyProcess.createUnsMqttProxy(outputChannel.host, "templateUnsRttOutput", config.uns.instanceMode!, config.uns.handover!, {
  ...mqttChannelParameters(outputChannel),
  publishThrottlingDelay: 1000,
});

/**
 * The input worker connects to the upstream broker and listens for incoming messages.
 * It processes the messages and transforms them into a table-type IUnsMessage.
 * The resulting message is published to the output broker.
 */
mqttInput.event.on("input", async (event) => {
  try {
    if (event.topic === "raw/data") {
      const values = event.message.split(",");
      const [countRaw, timestampRaw, sensorRaw] = values;
      if (!countRaw || !timestampRaw || !sensorRaw) {
        logger.warn(`Skipping malformed raw/data payload: ${event.message}`);
        return;
      }

      const currentValue = Number.parseFloat(countRaw);
      const eventDate = new Date(Number.parseInt(timestampRaw, 10));
      const sensorValue = Number.parseFloat(sensorRaw);

      const time: ISO8601 = eventDate.toISOString() as ISO8601;
      const dataGroup = "sensor_table";
      const columns: IUnsTableColumns = {
        current: {
          type: "double",
          value: currentValue,
          uom: GeneratedPhysicalMeasurements.Ampere,
        },
        voltage: { type: "double", value: sensorValue },
      };
      const topic: UnsTopics = "enterprise/site/area/line/";
      const asset = resolveGeneratedAsset("asset");
      const assetDescription = ""; // customize manually
      mqttOutput.publishMqttMessage({
        topic,
        asset,
        assetDescription,
        objectType: GeneratedObjectTypes["resource-status"],
        objectId: "main",
        attributes: [
          {
            attribute: GeneratedAttributes["status"] ?? "status",
            description: GeneratedAttributeDescriptions["status"] ?? "Table",
            table: {
              dataGroup,
              time,
              columns,
            },
          },
        ],
      });
    }
  } catch (error) {
    const reason = error instanceof Error ? error : new Error(String(error));
    logger.error(`Error publishing message to MQTT: ${reason.message}`);
    throw reason;
  }
});
