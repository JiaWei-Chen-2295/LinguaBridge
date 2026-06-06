import { buildGatewayApp } from "./app";
import { loadConfig } from "./config";

async function main(): Promise<void> {
  const config = loadConfig();
  const { app } = await buildGatewayApp(config);

  const close = async (): Promise<void> => {
    await app.close();
  };

  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });

  try {
    const address = await app.listen({
      host: config.host,
      port: config.port
    });
    app.log.info(
      {
        address,
        modelProvider: config.model.provider,
        alibabaCloud: {
          hasApiKey: config.model.alibabaCloud.apiKey !== undefined,
          asrWebsocketUrl: config.model.alibabaCloud.asrWebsocketUrl,
          openAiBaseUrl: config.model.alibabaCloud.openAiBaseUrl,
          asrModel: config.model.alibabaCloud.asrModel,
          mtModel: config.model.alibabaCloud.mtModel,
          revisionModel: config.model.alibabaCloud.revisionModel,
          translateDrafts: config.model.alibabaCloud.translateDrafts
        },
        subtitleRevisionIntervalMs: config.subtitleRevisionIntervalMs,
        liveTranslateSpikeEnabled: config.model.liveTranslateSpike.enabled
      },
      "LinguaBridge gateway listening"
    );
  } catch (error) {
    app.log.error(
      {
        error,
        host: config.host,
        port: config.port,
        nextStep: describeStartupFailure(error, config.port)
      },
      "Failed to start LinguaBridge gateway"
    );
    process.exitCode = 1;
  }
}

function describeStartupFailure(error: unknown, port: number): string {
  if (isNodeError(error) && error.code === "EADDRINUSE") {
    return `Port ${port} is already in use. Stop the old gateway process or start this one with PORT=${port + 1}.`;
  }

  return "Check gateway configuration, logs, and local network permissions, then restart the gateway.";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

void main();
