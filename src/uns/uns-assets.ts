// Generated UNS asset list. Run `pnpm run sync-uns-metadata` to update.
export const GeneratedAssets = {
  /** Neutral example asset. Replace it by syncing metadata from your controller. */
  "motor-1": "motor-1",
} as const;
export type GeneratedAssetName = typeof GeneratedAssets[keyof typeof GeneratedAssets];

export function resolveGeneratedAsset(name: keyof typeof GeneratedAssets): (typeof GeneratedAssets)[keyof typeof GeneratedAssets];
export function resolveGeneratedAsset<T extends string>(name: T): (typeof GeneratedAssets)[keyof typeof GeneratedAssets] | T;
export function resolveGeneratedAsset(name: string): string {
  return (GeneratedAssets as Record<string, string>)[name] ?? name;
}
