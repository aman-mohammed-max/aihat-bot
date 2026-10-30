import type { RuntimeCapabilities } from "@aihat/core";

export const runtimeCapabilities: RuntimeCapabilities = {
  runtime: "bun",
  features: {
    sharedAgentEngine: true,
    databasePersistence: true,
    objectStorage: true,
    encryptedSecrets: true,
    persistentBackgroundJobs: true,
    durableObjectSqlite: false,
    durableObjectAlarms: false,
    queueEnqueue: false,
    queueProcessing: false,
    authentication: true,
    promptSkills: true,
    httpSkills: true,
    nativeSkills: false,
    telegram: true,
    mcp: true,
    mcpOAuth: false,
    arbitraryCodeExecution: false,
  },
};
