#!/usr/bin/env node

import fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tag = process.argv.slice(2).find(argument => argument !== "--") ?? process.env["GITHUB_REF_NAME"];

if (!tag) {
  throw new Error("Provide a release tag, for example: pnpm run check-release-version -- 4.1.0");
}

const normalizedTag = tag.startsWith("v") ? tag.slice(1) : tag;
if (normalizedTag !== packageJson.version) {
  throw new Error(`Release tag '${tag}' does not match package.json.version '${packageJson.version}'.`);
}

const metadata = packageJson.unsDatahub;
if (metadata?.schemaVersion !== 1 || metadata?.kind !== "addon") {
  throw new Error("package.json.unsDatahub must declare schemaVersion 1 and kind 'addon'.");
}

if (
  metadata.controllerCompatibility !== undefined &&
  (typeof metadata.controllerCompatibility !== "string" || !metadata.controllerCompatibility.trim())
) {
  throw new Error("package.json.unsDatahub.controllerCompatibility must be a non-empty semantic version range.");
}

console.log(`Release metadata is valid for '${tag}'.`);
