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
    longTermMemory: true,
    promptSkills: true,
    httpSkills: true,
    workflowSkills: true,
    nativeSkills: false,
    modelStreaming: false,
    modelStructuredOutput: false,
    telegram: true,
    telegramMasterBot: false,
    mcp: true,
    mcpOAuth: false,
    arbitraryCodeExecution: false,
  },
};
