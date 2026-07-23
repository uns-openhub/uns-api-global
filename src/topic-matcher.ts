import type { DataSourceConfig } from "./config/project.config.extension.js";

/**
 * MQTT-compliant topic matching — same rules as the uns-archiver TopicMatcher.
 *
 * - `#` matches everything that follows (multi-level wildcard)
 * - `+` matches exactly one level (single-level wildcard)
 * - Otherwise exact segment match is required
 */
export function matchesTopic(topicFilter: string, topic: string): boolean {
  const filterSegments = topicFilter.split("/");
  const topicSegments = topic.split("/");

  for (let i = 0; i < filterSegments.length; i++) {
    const seg = filterSegments[i];
    if (seg === "#") return true;
    if (seg === "+") {
      if (topicSegments[i] === undefined) return false;
    } else if (seg !== topicSegments[i]) {
      return false;
    }
  }

  return filterSegments.length === topicSegments.length;
}

/**
 * Find the first dataSource entry whose topic pattern matches the given topic.
 */
export function findDataSource(
  dataSources: DataSourceConfig[],
  topic: string,
): DataSourceConfig | undefined {
  return dataSources.find((ds) => matchesTopic(ds.topic, topic));
}

/**
 * Check if a topic is allowed for history (QuestDB) queries.
 */
export function isHistoryAllowed(dataSources: DataSourceConfig[], topic: string): boolean {
  const ds = findDataSource(dataSources, topic);
  return ds?.history === true;
}

/**
 * Check if a topic is allowed for last-value cache.
 */
export function isCacheAllowed(dataSources: DataSourceConfig[], topic: string): boolean {
  const ds = findDataSource(dataSources, topic);
  return ds?.cache === true;
}

/**
 * Resolve the tablePrefix for a topic from dataSources config.
 * Returns undefined if no matching source has a tablePrefix configured.
 */
export function resolveTablePrefix(dataSources: DataSourceConfig[], topic: string): string | undefined {
  const ds = findDataSource(dataSources, topic);
  return ds?.tablePrefix;
}

/**
 * Extract the set of MQTT topic filters that have cache enabled.
 */
export function getCacheTopicFilters(dataSources: DataSourceConfig[]): string[] {
  return dataSources.filter((ds) => ds.cache).map((ds) => ds.topic);
}
