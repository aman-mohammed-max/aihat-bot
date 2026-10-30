import type { RuntimeCapabilities } from "./ports.js";
import { unsupportedCapability } from "./errors.js";

export function requireCapability(capabilities: RuntimeCapabilities, feature: string): void {
  if (capabilities.features[feature] !== true) {
    throw unsupportedCapability(feature, capabilities.runtime);
  }
}
