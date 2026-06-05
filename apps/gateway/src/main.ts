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
    app.log.info({ address }, "LinguaBridge gateway listening");
  } catch (error) {
    app.log.error({ error }, "Failed to start LinguaBridge gateway");
    process.exitCode = 1;
  }
}

void main();
