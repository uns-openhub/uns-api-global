export function requireSafeRequestLogging(metadata: object): void {
  if (
    !("SAFE_REQUEST_LOGGING_VERSION" in metadata) ||
    metadata.SAFE_REQUEST_LOGGING_VERSION !== 1
  ) {
    throw new Error(
      "Query diagnostics require @uns-kit/api >=3.0.22 with safe request logging. Update the dependency and lockfile before starting this build.",
    );
  }
}
