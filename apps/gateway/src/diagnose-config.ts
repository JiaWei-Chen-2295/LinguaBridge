import { loadConfig } from "./config";

const config = loadConfig();

console.log(
  JSON.stringify(
    {
      host: config.host,
      port: config.port,
      websocketPath: config.websocketPath,
      modelProvider: config.model.provider,
      subtitleRevisionIntervalMs: config.subtitleRevisionIntervalMs,
      alibabaCloud: {
        hasApiKey: config.model.alibabaCloud.apiKey !== undefined,
        asrWebsocketUrl: config.model.alibabaCloud.asrWebsocketUrl,
        openAiBaseUrl: config.model.alibabaCloud.openAiBaseUrl,
        asrModel: config.model.alibabaCloud.asrModel,
        mtModel: config.model.alibabaCloud.mtModel,
        revisionModel: config.model.alibabaCloud.revisionModel,
        inputAudioFormat: config.model.alibabaCloud.inputAudioFormat,
        translateDrafts: config.model.alibabaCloud.translateDrafts,
        requestTimeoutMs: config.model.alibabaCloud.requestTimeoutMs
      },
      liveTranslateSpikeEnabled: config.model.liveTranslateSpike.enabled
    },
    null,
    2
  )
);
