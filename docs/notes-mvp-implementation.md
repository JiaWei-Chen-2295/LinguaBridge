# LinguaBridge MVP 实现说明

版本：v0.1  
日期：2026-06-05  
关联文档：[MVP PRD](./prd-mvp-ai-realtime-subtitle.md)、[MVP 技术选型](./technical-selection-mvp.md)

## 1. 当前实现目标

本阶段先落地可运行的 MVP 骨架，用于承接 Phase 0 Spike 和 Phase 1 Alpha：

- `packages/protocol`：客户端和网关共享的字幕、会话、用量、邀请码协议类型。
- `apps/gateway`：Realtime Gateway，提供 HTTP API 和 WebSocket 实时字幕通道。
- `apps/desktop`：Tauri v2 + React 桌面客户端，包含主窗口和字幕浮窗。
- `packages/mock-models`：本地 mock ASR/MT/纠错链路，用于无阿里云凭证时验证实时状态机。
- `infra`：Alpha 本地开发所需 PostgreSQL/Redis 基础配置。

## 2. 明确假设

- 当前版本默认使用 mock model provider；设置 `MODEL_PROVIDER=alibaba-cloud` 后，Gateway 会接阿里云实时 ASR + Qwen-MT。客户端仍不保存云服务密钥。
- Windows WASAPI loopback 已接真实采集路径，输出 16 kHz mono PCM16 帧，并对默认输出设备切换给出可恢复错误提示。
- 本地开发可使用内存存储验证邀请码、用量和会话；PostgreSQL/OSS 删除闭环会在 Alpha 数据层实现时补齐。
- 数据保留策略维持 PRD 确认的默认 30 天，不新增关闭云端保存开关。

## 3. 开发入口

```bash
npm install
npm run typecheck
npm run build
npm run dev:gateway
npm run dev:desktop
npm run dev:desktop:web
```

- `npm run dev:desktop`：启动真实 Tauri 桌面客户端，会弹出主窗口和字幕浮窗。
- `npm run dev:desktop:web`：只启动前端 Vite 预览，不会弹出桌面窗口。
- 真实桌面客户端仍需要 Tauri v2 系统依赖、Rust 工具链和 Windows WebView2；当前仓库根脚本会在 Windows 上优先使用 GNU Rust toolchain 启动桌面端。

## 4. Phase 0 待验证

- Windows WASAPI loopback：默认输出设备、蓝牙耳机切换、空音频、采样率转换。当前实现可采集并检测默认输出切换，仍需设备矩阵实测。
- 字幕浮窗：置顶、多显示器、DPI 缩放、锁定和透明度。当前浮窗不再读取 `mockData`，只展示主窗口同步来的实时字幕。
- ASR + Qwen-MT：5 段技术视频样本延迟和术语表现。当前 Gateway 已有真实 provider 入口，默认仍为 mock。
- LiveTranslate：与 ASR + MT 对比延迟、分段和术语质量。当前保留配置开关，尚未作为默认字幕链路。
- 会话落盘：音频、字幕、修订历史、导出文件、删除路径。
- 邀请码和用量：激活、额度、append-only usage events、后台成本口径。

## 5. WASAPI loopback 手工验证

目标：确认桌面端能从系统默认输出捕获浏览器、播放器和会议软件音频，并在默认输出设备切换时给出 `deviceSwitchRequired`。

1. 启动 `npm run dev:gateway` 和 `npm run dev:desktop`，在主窗口选择当前默认输出设备并开始伴学。
2. 浏览器验证：用 Edge/Chrome 播放英文技术视频 2 分钟，确认主窗口或浮窗持续收到音频帧，停止后设备可再次启动。
3. 播放器验证：用 Windows Media Player/VLC 播放本地英文视频 2 分钟，确认音频帧持续增长且无 `emptyAudio` 或 `wasapiUnavailable`。
4. 会议软件验证：用 Teams/Zoom/腾讯会议播放会议回放或测试会议音频 2 分钟，确认可捕获远端声音；不要求捕获麦克风。
5. 设备切换验证：采集中把 Windows 默认输出从扬声器切到耳机或蓝牙耳机，1 秒内应进入错误状态，`lastErrorKind` 为 `deviceSwitchRequired`；停止后刷新设备并重新开始应能恢复。

当前限制：Phase 0 只检测并提示默认输出切换，不做自动重连；如果用户显式选择了非默认输出设备，切换默认输出不会中断该显式设备的捕获。

## 6. 字幕浮窗手工验证

目标：确认 `subtitle-overlay` 由主窗口实时字幕状态驱动，且窗口交互满足 Phase 0 验证项。

1. 启动 `npm run dev:gateway` 和 `npm run dev:desktop`，保持 `MODEL_PROVIDER=mock`。
2. 打开悬浮窗后不要开始伴学，浮窗应显示“等待实时字幕”，不应出现 `mockData` 中的 Kubernetes 示例字幕。
3. 主窗口完成邀请码、隐私授权并开始伴学，播放任意系统音频；mock provider 只有在收到 `audio.frame` 累计到字幕时间点后才发字幕，主窗口和浮窗应同步显示最近 1-2 段。
4. 验证浮窗置顶、拖动、锁定、隐藏控制条、单行/双行、字号和透明度。锁定后拖动手柄不应移动窗口。
5. 在 100%/150% DPI 和多显示器间移动浮窗，确认文字不重叠、窗口可继续拖动，主窗口新字幕仍能同步到浮窗。

## 7. Gateway 模型链路验证

### 本地 mock 链路

1. 保持 `MODEL_PROVIDER=mock`。
2. 启动 `npm run dev:gateway`。
3. 启动 `npm run dev:desktop`，开始伴学并播放系统音频。
4. 验证 `session.start` 后不会立刻出现字幕；只有客户端持续发送 `audio.frame` 后，mock 字幕才按累计音频时长依次出现。
5. 停止会话后检查导出接口，例如 `/sessions/{sessionId}/export?format=json`，应包含音频用量、字幕段和修订记录。

### 阿里云 ASR + Qwen-MT 链路

1. 在 Gateway 环境设置 `MODEL_PROVIDER=alibaba-cloud`，并设置 `ALIBABA_MODEL_STUDIO_API_KEY` 或 `DASHSCOPE_API_KEY`。不要把真实密钥提交到仓库。
2. 按需要确认：
   - `ALIBABA_ASR_REALTIME_URL`
   - `ALIBABA_OPENAI_BASE_URL`
   - `ALIBABA_ASR_MODEL=qwen3-asr-flash-realtime`
   - `ALIBABA_MT_MODEL=qwen-mt-flash`
   - `ALIBABA_ASR_INPUT_AUDIO_FORMAT=pcm`（Gateway 发送的是 PCM16 16 kHz mono 原始字节；阿里云 Qwen-ASR Realtime 的会话参数名使用 `pcm`）
3. 运行 `npm run diagnose:config -w @lingua-bridge/gateway`，确认 `modelProvider` 是 `alibaba-cloud`、`hasApiKey` 是 `true`、`inputAudioFormat` 是 `pcm`，并确认 endpoint 与账号站点一致。中国站通常使用 `dashscope.aliyuncs.com`，国际站使用 `dashscope-intl.aliyuncs.com`。Gateway 会自动读取仓库根 `.env` 和 `apps/gateway/.env`，真实进程环境变量优先级最高。
4. 启动前确认 4318 端口没有旧 Gateway：`Get-NetTCPConnection -LocalPort 4318`。如果被旧 `node.exe ... apps/gateway/src/main.ts` 占用，先 `Stop-Process -Id <PID>`，或临时设置 `PORT=4319` 并让桌面端使用同一个 WebSocket 地址。
5. 启动 `npm run dev:gateway` 和 `npm run dev:desktop`，播放英文技术内容并开始伴学。Gateway 启动日志会输出当前 provider、模型名和 endpoint，但不会输出密钥。
6. Gateway 会把 PCM16 16 kHz mono 音频帧转发到阿里云实时 ASR，收到 final ASR 文本后调用 Qwen-MT，再向客户端发 `subtitle.segment.updated`。如果已经连接但没有字幕，把 `LOG_LEVEL=debug` 后重启 Gateway，检查是否依次出现 `Alibaba Cloud realtime ASR session connected`、`session.updated`、`sent audio frame to Alibaba Cloud realtime ASR`、`input_audio_buffer.speech_started`、`conversation.item.input_audio_transcription.completed` 或 provider error。
7. 记录 5 段技术样本的首句延迟、稳态延迟、术语错误和中断情况。`qwen3-asr-flash-realtime` 当前时间戳能力有限，字幕时间暂以 Gateway 收到的音频时长近似；若需要更稳定时间戳，继续评估 Fun-ASR/Paraformer。

### LiveTranslate Spike

当前 `.env.example` 保留 `LIVETRANSLATE_SPIKE_ENABLED`、`LIVETRANSLATE_REALTIME_URL` 和 `LIVETRANSLATE_MODEL`。Phase 0 可在后续添加独立 adapter 做延迟、术语和分段对比；本次实现未把 LiveTranslate 接为默认字幕输出链路。
