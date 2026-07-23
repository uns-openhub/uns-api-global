/**
 * Load the configuration from a file.
 * On the server, this file is provided by the `uns-datahub-controller`.
 * In the development environment, you are responsible for creating and maintaining this file and its contents.
 */
import readline from "readline";
import { ConfigFile, logger } from "@uns-kit/core";
import UnsMqttProxy from "@uns-kit/core/uns-mqtt/uns-mqtt-proxy.js";

/**
 * Produces a smooth oscillating value to mimic a real-world sensor signal.
 * Combines fast and slow sine waves plus tiny ripple so that subsequent values
 * rise and fall without appearing purely random.
 */
function simulateSensorValue(step: number): number {
  const baseValue = 42; // arbitrary midpoint for the simulated signal
  const fastCycle = Math.sin(step / 5) * 3;
  const slowCycle = Math.sin(step / 25) * 6;
  const ripple = Math.sin(step / 2 + Math.PI / 4) * 0.5;
  const value = baseValue + fastCycle + slowCycle + ripple;

  return Number(value.toFixed(2));
}

/**
 * This script initializes an MQTT output proxy for load testing purposes.
 * It sets up a connection to the specified MQTT broker and configures
 * a proxy instance. The load test is designed to evaluate the performance
 * and reliability of the MQTT broker under simulated load conditions.
 */
async function main() {
  try {
    const config = await ConfigFile.loadConfig();
    const outputHost = (config.output?.host)!;

    const mqttOutput = new UnsMqttProxy(
      outputHost,
      "loadTest",
      "templateUnsRttLoadTest",
      { publishThrottlingDelay: 0 },
      true
    );

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    rl.question(`Would you like to continue with load-test on ${outputHost}? (Y/n) `, async (answer) => {
      if (answer.toLowerCase() === "y" || answer.trim() === "") {
        rl.question("How many iterations should be run? (default is 100) ", async (iterations) => {
          const maxIntervals = parseInt(iterations) || 100;

          rl.question("What should be the delay between intervals in milliseconds? (default is 0 ms) ", async (intervalDelay) => {
            const delay = parseInt(intervalDelay) || 0;

            logger.info(`Starting load test with ${maxIntervals} messages and ${delay} ms delay...`);

            let count = 0;
            const startTime = Date.now();

            while (count < maxIntervals) {
              try {
                const currentDate = new Date();
                const sensorValue = simulateSensorValue(count);
                const rawData = `${count},${currentDate.getTime()},${sensorValue}`;
                await mqttOutput.publishMessage("raw/data", rawData);
              } catch (error) {
                const reason = error instanceof Error ? error : new Error(String(error));
                logger.error("Error publishing message:", reason.message);
              }

              count++;
              if (delay > 0) {
                await new Promise((resolve) => setTimeout(resolve, delay));
              }
            }

            logger.info(`Sleeping for 50ms.`);
            await new Promise((resolve) => setTimeout(resolve, 50));

            const endTime = Date.now();
            const duration = (endTime - startTime) / 1000;
            const messagesPerSecond = maxIntervals / duration;

            logger.info(`Load test completed in ${duration.toFixed(2)} seconds.`);
            logger.info(`Message rate: ${messagesPerSecond.toFixed(2)} msg/s.`);

            rl.close();
            process.exit(0);
          });
        });
      } else {
        logger.info("Load test aborted.");
        rl.close();
        process.exit(0);
      }
    });
  } catch (error) {
    const reason = error instanceof Error ? error : new Error(String(error));
    logger.error("Error initializing load test:", reason.message);
    process.exit(1);
  }
}

main();
