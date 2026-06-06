# LinguaBridge MVP 实现说明

版本：v0.1  
日期：2026-06-05  
关联文档：[MVP PRD](./prd-mvp-ai-realtime-subtitle.md)、[MVP 技术选型](./technical-selection-mvp.md)

## 1. 当前实现目标

本阶段优先**快速打通端到端功能**（采集 → 实时字幕 → 落盘 → 导出），运维与风控能力后置。

先落地可运行的 MVP 骨架，用于承接 Phase 0 Spike 和 Phase 1 Alpha：

- `packages/protocol`：客户端和网关共享的字幕、会话、用量、邀请码协议类型。
- `apps/gateway`：Realtime Gateway，提供 HTTP API 和 WebSocket 实时字幕通道。
- `apps/desktop`：Tauri v2 + React 桌面客户端，包含主窗口和字幕浮窗。
- `packages/mock-models`：本地 mock ASR/MT/纠错链路，用于无阿里云凭证时验证实时状态机。
- `infra`：Alpha 本地开发所需 PostgreSQL 与 MinIO 对象存储基础配置；Gateway 当前不接入 Redis。

## 2. 明确假设

- 当前版本默认使用 mock model provider；设置 `MODEL_PROVIDER=alibaba-cloud` 后，Gateway 会接阿里云实时 ASR + Qwen-MT。客户端仍不保存云服务密钥。
- 桌面端第一版默认以 `interpretation` 模式启动真实会话；当 Gateway 使用 `MODEL_PROVIDER=alibaba-cloud` 时，同传链路走 LiveTranslate，返回中文字幕和中文译音。
- Windows WASAPI loopback 已接真实采集路径，输出 16 kHz mono PCM16 帧，并对默认输出设备切换给出可恢复错误提示。
- Gateway 配置 `DATABASE_URL` 时使用 PostgreSQL 持久化邀请码、会话、字幕分段、修订、音频对象索引和用量事件；未配置时仅保留内存存储作为本地降级。
- 会话结束时上传 `audio.pcm`、可选 `audio-interpretation.pcm`、`segments.json` 和 `exports/*` 到 MinIO/OSS-compatible 对象存储；删除会话时先删除对象存储前缀，再清理 PostgreSQL 会话、分段、修订和音频对象索引。
- 数据保留策略维持默认 30 天；中文译音音轨随会话一起按 30 天策略保存，不新增关闭云端保存开关。
- 当前中文译音由桌面端 Web Audio 播放，尚未实现 Windows process-exclude loopback，因此译音可能被 WASAPI loopback 重新捕获。真实内测前仍需实现或验证回灌规避。
- **Alpha 简化范围（为提速，本阶段不做）**：
  - Redis / Tair：不接入；本地 `docker-compose` 不启动 Redis。
  - 限流、并发控制、邀请码额度拦截（`quota_exhausted`）、在线会话分布式缓存。
  - 后台成本统计、批次分析、SLS 监控等运营能力。
- **Alpha 仍要做**：邀请码准入（可简化）、实时字幕链路、会话落盘、导出、基础用量记录（已按 append-only 事件写入但不阻断会话）。
- 在线会话状态由 Gateway 进程内管理；持久化以 PostgreSQL + 对象存储为主。实现任务不要为上述「不做」项增加复杂度。

## 3. 开发入口

```bash
npm install
docker compose -f infra/docker-compose.yml up -d postgres minio
npm run typecheck
npm run build
npm run dev:gateway
npm run dev:desktop
npm run dev:desktop:web
```

- `npm run dev:desktop`：启动真实 Tauri 桌面客户端，会弹出主窗口和字幕浮窗。
- `npm run dev:desktop:web`：只启动前端 Vite 预览，不会弹出桌面窗口。
- 真实桌面客户端仍需要 Tauri v2 系统依赖、Rust 工具链和 Windows WebView2；当前仓库根脚本会在 Windows 上优先使用 GNU Rust toolchain 启动桌面端。

## 4. PostgreSQL + MinIO 持久化验证

1. 启动基础依赖：`docker compose -f infra/docker-compose.yml up -d postgres minio`。
2. 确认 `.env` 或 `apps/gateway/.env` 中有 `DATABASE_URL=postgresql://lingua_bridge:lingua_bridge_dev@127.0.0.1:5432/lingua_bridge`，并保持 `OBJECT_STORAGE_PROVIDER=minio`。本地 MinIO 使用 `MINIO_ENDPOINT=localhost:9000`、`MINIO_ACCESS_KEY=admin`、`MINIO_SECRET_KEY=password`、`MINIO_SECURE=false`。
3. 启动 Gateway：`npm run dev:gateway`。`/health` 应返回 `databaseConfigured: true`、`redisConfigured: false`。
4. 激活邀请码：`POST /invites/activate`，body 至少包含 `{"code":"ALPHA-DEV-2026"}`。
5. 通过桌面端或 WebSocket 测试脚本发起 `session.start`、若干 `audio.frame`、`session.stop`。停止后应在 PostgreSQL 看到 `realtime_sessions`、`subtitle_segments`、`segment_revisions`、`usage_events`、`session_audio_objects` 记录。
6. 在 MinIO bucket `lingua-bridge-dev` 中应看到 `users/{userId}/sessions/{sessionId}/audio.pcm`、`segments.json` 和 `exports/transcript.md|subtitle.srt|session.json`；同传模式还应看到 `audio-interpretation.pcm`。
7. 调用 `DELETE /sessions/{sessionId}` 后，对象存储对应前缀应被删除，PostgreSQL 中该会话的 session/segments/revisions/audio object 索引被清理；用量事件保留并去掉 `session_id`，标记 `deletedSession`。

## 5. Phase 0 待验证

- Windows WASAPI loopback：默认输出设备、蓝牙耳机切换、空音频、采样率转换。当前实现可采集并检测默认输出切换，仍需设备矩阵实测。
- 字幕浮窗：置顶、多显示器、DPI 缩放、锁定和透明度。当前浮窗不再读取 `mockData`，只展示主窗口同步来的实时字幕。
- ASR + Qwen-MT：5 段技术视频样本延迟和术语表现。当前 Gateway 已有真实 provider 入口，默认仍为 mock。
- LiveTranslate：第一版同传模式已接入 Gateway，仍需用真实阿里云凭证验证延迟、分段、术语质量和回灌风险。
- 会话落盘：音频、字幕、修订历史、导出文件、删除路径。
- 邀请码和用量：激活、额度、append-only usage events、后台成本口径。

## 6. WASAPI loopback 手工验证

目标：确认桌面端能从系统默认输出捕获浏览器、播放器和会议软件音频，并在默认输出设备切换时给出 `deviceSwitchRequired`。

1. 启动 `npm run dev:gateway` 和 `npm run dev:desktop`，在主窗口选择当前默认输出设备并开始伴学。
2. 浏览器验证：用 Edge/Chrome 播放英文技术视频 2 分钟，确认主窗口或浮窗持续收到音频帧，停止后设备可再次启动。
3. 播放器验证：用 Windows Media Player/VLC 播放本地英文视频 2 分钟，确认音频帧持续增长且无 `emptyAudio` 或 `wasapiUnavailable`。
4. 会议软件验证：用 Teams/Zoom/腾讯会议播放会议回放或测试会议音频 2 分钟，确认可捕获远端声音；不要求捕获麦克风。
5. 设备切换验证：采集中把 Windows 默认输出从扬声器切到耳机或蓝牙耳机，1 秒内应进入错误状态，`lastErrorKind` 为 `deviceSwitchRequired`；停止后刷新设备并重新开始应能恢复。

当前限制：Phase 0 只检测并提示默认输出切换，不做自动重连；如果用户显式选择了非默认输出设备，切换默认输出不会中断该显式设备的捕获。

## 7. 字幕浮窗手工验证

目标：确认 `subtitle-overlay` 由主窗口实时字幕状态驱动，且窗口交互满足 Phase 0 验证项。

1. 启动 `npm run dev:gateway` 和 `npm run dev:desktop`，保持 `MODEL_PROVIDER=mock`。
2. 打开悬浮窗后不要开始伴学，浮窗应显示“等待实时字幕”，不应出现 `mockData` 中的 Kubernetes 示例字幕。
3. 主窗口完成邀请码、隐私授权并开始伴学，播放任意系统音频；mock provider 只有在收到 `audio.frame` 累计到字幕时间点后才发字幕，主窗口和浮窗应同步显示最近 1-2 段。
4. 验证浮窗置顶、拖动、锁定、隐藏控制条、单行/双行、字号和透明度。锁定后拖动手柄不应移动窗口。
5. 在 100%/150% DPI 和多显示器间移动浮窗，确认文字不重叠、窗口可继续拖动，主窗口新字幕仍能同步到浮窗。

## 8. Gateway 模型链路验证

### Subtitle Engine 状态流

Gateway 的实时链路现在由 `SubtitleEngine` 统一驱动：

```text
audio.frame
  -> ASR provider partial
  -> Qwen-MT/mock MT
  -> subtitle.segment.updated(status=draft)
  -> ASR provider final
  -> Qwen-MT/mock MT
  -> subtitle.segment.updated(status=final)
  -> 每 15-30 秒取最近 2-4 段上下文
  -> revision provider 只改最近 2 段
  -> subtitle.segment.updated(status=revised)
```

- `MODEL_PROVIDER=mock` 时，mock ASR 也按累计 `audio.frame` 时长产出 partial/final，再走同一套 MT、术语和修订状态机；不再直接吐固定 subtitle fixture。
- `MODEL_PROVIDER=alibaba-cloud` 时，ASR partial/final 来自阿里云 realtime ASR，翻译走 Qwen-MT，修订走 `ALIBABA_REVISION_MODEL`。
- `SUBTITLE_REVISION_INTERVAL_MS` 默认为 `20000`，运行时会限制在 15000-30000 毫秒；`session.stop` 前会再 flush 一次上下文修订。
- 术语表来源为内置技术术语 + PostgreSQL `term_entries`。命中 `keep_source` 会保留英文，命中 `fixed_translation` 会固定译法；模型输出后还有一次术语兜底，防止译法漂移。
- 实时推送的 `revised` 只覆盖当前段和上一段；更早段落只参与 2-4 段上下文，不作为 revised 事件推给 UI。
- `subtitle_segments` 保存当前段状态，`segment_revisions` 记录每次 draft/final/revised 历史，`usage_events` 记录 `asr_audio_duration`、`mt_input_tokens`、`mt_output_tokens`、`revision_tokens`、`oss_audio_storage` 等 append-only 事件。

### 本地 mock 链路

1. 保持 `MODEL_PROVIDER=mock`。
2. 启动 `npm run dev:gateway`。
3. 启动 `npm run dev:desktop`，开始伴学并播放系统音频。
4. 验证 `session.start` 后不会立刻出现字幕；只有客户端持续发送 `audio.frame` 后，mock ASR 才按累计音频时长产生 partial/final。
5. 字幕预期顺序：第一段出现 `draft`，随后同段更新为 `final`；累计到第二段 final 后，最近两段会在 15-30 秒 timer 或 stop flush 中更新为 `revised`。
6. 停止会话后检查导出接口，例如 `/sessions/{sessionId}/export?format=json`，应包含音频用量、字幕段、`segment_revisions` 和 `usage_events`。
7. 使用 PostgreSQL 时可直接检查：
   - `subtitle_segments`：每个 `segment_id` 只有当前状态。
   - `segment_revisions`：同一段有 draft/final/revised 多条历史。
   - `usage_events`：包含 `asr_audio_duration`、`mt_input_tokens`、`mt_output_tokens`、`revision_tokens`。

### 阿里云 ASR + Qwen-MT 链路

1. 在 Gateway 环境设置 `MODEL_PROVIDER=alibaba-cloud`，并设置 `ALIBABA_MODEL_STUDIO_API_KEY` 或 `DASHSCOPE_API_KEY`。不要把真实密钥提交到仓库。
2. 按需要确认：
   - `ALIBABA_ASR_REALTIME_URL`
   - `ALIBABA_OPENAI_BASE_URL`
   - `ALIBABA_ASR_MODEL=qwen3-asr-flash-realtime`
   - `ALIBABA_MT_MODEL=qwen-mt-flash`
   - `ALIBABA_REVISION_MODEL=qwen-turbo`
   - `ALIBABA_ASR_INPUT_AUDIO_FORMAT=pcm`（Gateway 发送的是 PCM16 16 kHz mono 原始字节；阿里云 Qwen-ASR Realtime 的会话参数名使用 `pcm`）
3. 如需降低草稿成本，可临时设置 `ALIBABA_TRANSLATE_DRAFTS=false`；默认 `true` 用于验证 `draft -> final -> revised` 全状态流。
4. 运行 `npm run diagnose:config -w @lingua-bridge/gateway`，确认 `modelProvider` 是 `alibaba-cloud`、`hasApiKey` 是 `true`、`inputAudioFormat` 是 `pcm`、`revisionModel` 和 `subtitleRevisionIntervalMs` 正确，并确认 endpoint 与账号站点一致。中国站通常使用 `dashscope.aliyuncs.com`，国际站使用 `dashscope-intl.aliyuncs.com`。Gateway 会自动读取仓库根 `.env` 和 `apps/gateway/.env`，真实进程环境变量优先级最高。
5. 启动前确认 4318 端口没有旧 Gateway：`Get-NetTCPConnection -LocalPort 4318`。如果被旧 `node.exe ... apps/gateway/src/main.ts` 占用，先 `Stop-Process -Id <PID>`；或临时设置 `PORT=4319`，并同步把仓库根 `.env` 中的 `VITE_GATEWAY_WS_URL` 改成 `ws://127.0.0.1:4319/realtime/sessions`。桌面端 Vite 配置会从仓库根 `.env` 读取这个变量。
6. 启动 `npm run dev:gateway` 和 `npm run dev:desktop`，播放英文技术内容并开始伴学。Gateway 启动日志会输出当前 provider、模型名和 endpoint，但不会输出密钥。
7. Gateway 会把 PCM16 16 kHz mono 音频帧转发到阿里云实时 ASR，收到 partial/final ASR 文本后调用 Qwen-MT，再向客户端发 `subtitle.segment.updated`；修订 timer 会把最近 2-4 段送入 revision provider，并只推送最近两段 `revised`。如果已经连接但没有字幕，把 `LOG_LEVEL=debug` 后重启 Gateway，检查是否依次出现 `Alibaba Cloud realtime ASR session connected`、`session.updated`、`sent audio frame to Alibaba Cloud realtime ASR`、`input_audio_buffer.speech_started`、`conversation.item.input_audio_transcription.text`、`conversation.item.input_audio_transcription.completed` 或 provider error。
8. 记录 5 段技术样本的首句延迟、稳态延迟、术语错误和中断情况。`qwen3-asr-flash-realtime` 当前时间戳能力有限，字幕时间暂以 Gateway 收到的音频时长近似；若需要更稳定时间戳，继续评估 Fun-ASR/Paraformer。

### LiveTranslate 中文同传链路

第一版桌面端默认发送 `mode: "interpretation"` 与 `outputAudio: true`。Gateway 在 `MODEL_PROVIDER=alibaba-cloud` 时会创建 `AlibabaCloudLiveTranslateSession`，并把中文译音通过 `interpretation.audio.delta` 事件推给桌面端播放。

配置项：

- `LIVETRANSLATE_REALTIME_URL=wss://dashscope.aliyuncs.com/api-ws/v1/realtime`
- `LIVETRANSLATE_MODEL=qwen3.5-livetranslate-flash-realtime`
- `LIVETRANSLATE_VOICE=Tina`
- `LIVETRANSLATE_OUTPUT_SAMPLE_FORMAT=pcm_s16le`
- `LIVETRANSLATE_OUTPUT_SAMPLE_RATE=24000`

验证步骤：

1. 设置 `MODEL_PROVIDER=alibaba-cloud`，并设置 `ALIBABA_MODEL_STUDIO_API_KEY` 或 `DASHSCOPE_API_KEY`。
2. 运行 `npm run diagnose:config -w @lingua-bridge/gateway`，确认 `liveTranslate.model`、`voice`、`outputSampleFormat`、`outputSampleRate` 符合预期。
3. 启动 `npm run dev:gateway` 和 `npm run dev:desktop`，主窗口完成邀请码和授权后点击开始。
4. 播放英文技术内容，确认主窗口出现中文字幕，并能听到中文译音。
5. 停止后检查对象存储和 `session_audio_objects`，应包含源音频和 `kind=interpretation` 的中文译音音轨。

当前限制：中文译音先用 Web Audio 播放，没有独立音量滑杆和原生 WASAPI render；Windows loopback 仍可能捕获 LinguaBridge 自己播放的中文译音。下一步应优先做 process-exclude loopback 或可选音频路由隔离。
