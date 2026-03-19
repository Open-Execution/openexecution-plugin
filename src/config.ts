/**
 * @module config
 * @description Configuration resolution — applies defaults and privacy presets
 *
 * License: Apache 2.0
 */
import type { PluginConfig, ResolvedConfig, PrivacyLevel } from "./types.js";

/** Privacy preset mappings */
const PRIVACY_PRESETS: Record<PrivacyLevel, Pick<ResolvedConfig, "includeToolArgs" | "includeToolResults" | "includeLlmContent" | "includeAssistantText">> = {
  full: { includeToolArgs: true, includeToolResults: true, includeLlmContent: true, includeAssistantText: true },
  metadata: { includeToolArgs: false, includeToolResults: false, includeLlmContent: false, includeAssistantText: true },
  minimal: { includeToolArgs: false, includeToolResults: false, includeLlmContent: false, includeAssistantText: false },
};

/**
 * Resolve raw plugin config into a fully-defaulted config.
 * Privacy preset is applied first, then individual overrides take precedence.
 */
export function resolveConfig(raw: PluginConfig): ResolvedConfig {
  const preset = raw.privacyLevel ? PRIVACY_PRESETS[raw.privacyLevel] : null;

  return {
    webhookUrl: raw.webhookUrl,
    webhookSecret: raw.webhookSecret,

    // Batching
    batchIntervalMs: Math.max(raw.batchIntervalMs ?? 2000, 100),
    batchMaxSize: Math.max(raw.batchMaxSize ?? 50, 1),
    timeoutMs: Math.max(raw.timeoutMs ?? 10000, 1000),
    retryAttempts: Math.max(raw.retryAttempts ?? 3, 0),

    // Privacy: individual overrides > preset > defaults (default = full)
    includeToolArgs: raw.includeToolArgs ?? preset?.includeToolArgs ?? true,
    includeToolResults: raw.includeToolResults ?? preset?.includeToolResults ?? true,
    includeLlmContent: raw.includeLlmContent ?? preset?.includeLlmContent ?? true,
    includeAssistantText: raw.includeAssistantText ?? preset?.includeAssistantText ?? true,

    // Display
    displayMode: raw.displayMode ?? "minimal",
    showSessionSummary: raw.showSessionSummary ?? true,
    showDeliveryStatus: raw.showDeliveryStatus ?? false,
    displayPrefix: raw.displayPrefix ?? "oe",
  };
}
