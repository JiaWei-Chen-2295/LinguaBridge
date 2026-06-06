# Windows process-exclude loopback 实现规划

更新时间：2026-06-06

## 1. 确认结论

当前同传文档已经识别了译音回灌风险，但规划粒度还不够实现。现在确认补齐为独立技术方案：

- Windows process-exclude loopback 可用于同传译音回灌规避，主路径可行。
- 该能力不是现有 endpoint WASAPI loopback 的一个初始化 flag，而是一条新的 application/process loopback 捕获路径。
- 最低系统要求是 Windows 10 Build 20348；Windows 11 可作为优先验证平台。
- LinguaBridge 同传模式应以当前桌面进程 PID 作为 `TargetProcessId`，用 `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` 排除 LinguaBridge 进程树。
- 不支持 process-exclude 的系统不得静默播放译音并继续采集全量系统混音；必须显式降级。

官方依据：

- Microsoft Application Loopback Audio Capture sample：说明该方案使用 `ActivateAudioInterfaceAsync`，可捕获指定进程树，或反向捕获除指定进程树以外的系统音频；要求 Windows 10 Build 20348 或更高版本。
- Microsoft `PROCESS_LOOPBACK_MODE`：包含 `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` 与 `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`，后者会排除目标进程及子进程的 render streams；最低 Windows 10 Build 20348。
- Microsoft `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`：通过 `TargetProcessId` 和 `ProcessLoopbackMode` 指定 process loopback 目标与包含/排除模式。
- Microsoft `AUDIOCLIENT_ACTIVATION_PARAMS`：process loopback 参数通过 `ActivateAudioInterfaceAsync` 传入。
- `ctx7` 已确认 `/microsoft/windows-rs` 为当前 Rust Windows API 绑定文档源；本地 `windows` crate 0.58 已包含 `ActivateAudioInterfaceAsync`、`AUDIOCLIENT_ACTIVATION_PARAMS`、`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` 和 `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK` 绑定。

## 2. 目标与非目标

目标：

- 同传模式下采集“系统原声 - LinguaBridge 自己播放的中文译音”。
- 保持现有字幕模式的 endpoint loopback 行为不变。
- 在 Windows 11 与 Windows 10 Build 20348+ 上优先实现自动回灌规避。
- 在旧 Windows 10 上默认给出可解释降级；用户显式开启高级风险模式后，可以播放中文译音。

非目标：

- 不在本阶段实现虚拟声卡安装或自动配置。
- 不默认调系统主音量。
- 不要求第一版 Web Audio 立即替换为 Rust 原生播放，但稳定同传版本应迁移到 Rust audio render。
- 不在 Gateway 侧尝试用模型过滤回灌音频；回灌应在客户端音频捕获层解决。

## 3. 当前代码基线

当前 Rust 音频采集路径在 `apps/desktop/src-tauri/src/audio/wasapi.rs`：

- `start_loopback_capture` 启动单个全局采集线程。
- `run_capture_loop` 通过默认或指定 render endpoint 创建 `IAudioClient`。
- 初始化参数使用 `AUDCLNT_STREAMFLAGS_LOOPBACK`，因此捕获的是 endpoint 混音。
- 采集线程输出统一的 16 kHz mono PCM16 帧，经 Tauri 事件 `audio-frame` 发给前端。
- 默认输出设备变化由 `DefaultOutputDeviceTracker` 检测。

该路径可以继续服务字幕模式。process-exclude 需要新增捕获模式，而不是直接改掉现有路径。

## 4. 设计方案

### 4.1 捕获模式

在 Tauri/Rust 层扩展 `AudioCaptureConfig`：

```rust
pub enum AudioCaptureMode {
    EndpointLoopback,
    ProcessExcludeLoopback,
}

pub struct AudioCaptureConfig {
    pub device_id: Option<String>,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub frame_duration_ms: u16,
    pub mode: AudioCaptureMode,
    pub excluded_process_id: Option<u32>,
}
```

前端行为：

- `subtitle` 模式继续传 `EndpointLoopback`。
- `interpretation` 且 `interpretation.echoAvoidance = "process_exclude"` 时传 `ProcessExcludeLoopback`。
- `excluded_process_id` 默认由 Rust 使用 `GetCurrentProcessId()` 获取，不信任前端传入的 PID。

协议层已有 `interpretation.echoAvoidance`，需要补客户端能力上报，而不是只靠用户选择。

### 4.2 能力探测

新增 Tauri command，例如 `get_audio_capture_capabilities`：

```ts
type AudioCaptureCapabilities = {
  endpointLoopback: true;
  processExcludeLoopback: {
    supported: boolean;
    reason?: "unsupported_os" | "activation_failed" | "not_windows";
    minimumBuild: 20348;
    currentBuild?: number;
  };
};
```

探测策略：

- Windows：通过系统版本 API 获取 build number，build >= 20348 才尝试 process loopback。
- build 达标时做一次轻量 activation probe：使用 `ActivateAudioInterfaceAsync` + `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK` + `AUDIOCLIENT_ACTIVATION_PARAMS`，排除当前 PID。
- 非 Windows：返回 unsupported，本项目首发 Windows，主要用于开发态兜底。

UI 与 Gateway 协商：

- 客户端 `session.start` 中继续发送 `mode: "interpretation"` 和 `interpretation.echoAvoidance`。
- 若本机不支持 process-exclude，客户端不应声明 `process_exclude` 已可用。
- Gateway 可接受 `outputAudio: false` 的同传字幕降级；若 `outputAudio: true` 且 echo avoidance 不安全，则返回明确错误或要求客户端降级。

### 4.3 process-exclude 捕获路径

新增 Rust 模块或函数：

```text
audio/
  wasapi.rs                       # 保留 endpoint loopback 公共转换、重采样、frame emitter
  wasapi_process_loopback.rs       # 新增 process-exclude activation 与 capture client 创建
```

核心流程：

1. 初始化 MTA COM。
2. 读取当前进程 PID。
3. 构造 `AUDIOCLIENT_ACTIVATION_PARAMS`：
   - `ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`
   - `ProcessLoopbackParams.TargetProcessId = current_pid`
   - `ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`
4. 将 activation params 包装为 `PROPVARIANT`。
5. 调用 `ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, IAudioClient::IID, params, completion_handler)`。
6. 等待 `IActivateAudioInterfaceCompletionHandler` 回调，取得 `IAudioClient`。
7. 对返回的 `IAudioClient` 执行 `GetMixFormat`、`Initialize`、`GetService<IAudioCaptureClient>`、`Start`。
8. 复用当前 packet pump、格式转换和 frame emitter。

实现注意：

- process loopback 不绑定具体物理 endpoint，因此不再依赖 `IMMDeviceEnumerator.GetDefaultAudioEndpoint` 创建 capture client。
- 仍要保留默认输出设备变化状态提示，因为用户实际听到的源音频会随设备变化，且旧 endpoint 模式仍需要。
- activation 是异步 COM 回调，Rust 侧建议封装一个小的 completion handler，把结果通过 channel 返回采集线程。
- 当前 `windows = 0.58` 已有绑定；如果实现 completion handler 时遇到宏或接口实现限制，再评估升级 `windows` crate，但不应为了规划先升级依赖。

### 4.4 译音播放关系

第一版已使用 Web Audio 播放中文译音。process-exclude 排除的是 LinguaBridge 当前进程树，WebView 播放通常在 Tauri/WebView2 子进程内，应被目标进程树排除；但这必须实测确认。

稳定版建议改为 Rust 原生 WASAPI shared render：

- 更容易保证播放进程归属在 LinguaBridge 进程树。
- 可以加入 jitter buffer、音量控制、stop flush 和 underrun 统计。
- 便于后续实现同传音量滑杆和可选输出设备。

迁移顺序建议：

1. 先实现 process-exclude 捕获，验证 Web Audio 是否被排除。
2. 若 WebView2 子进程排除不稳定，再把译音播放迁到 Rust 原生 render。
3. 不要先做原声 ducking；等回灌规避稳定后再评估。

## 5. 降级策略

推荐默认策略：

| 场景 | 行为 |
| --- | --- |
| Windows 11 / Windows 10 Build 20348+，probe 成功 | 同传可播放中文译音，采集使用 process-exclude loopback。 |
| build 达标但 activation 失败 | 同传默认降级为“中文字幕 + 不播放译音”，显示可恢复错误和诊断码。 |
| Windows 10 Build < 20348 | 同传默认降级为“中文字幕 + 不播放译音”；开放高级风险模式，用户显式确认后允许“播放译音 + endpoint loopback”。 |
| 用户选择独立音频路由 | 可允许译音播放，但 UI 必须提示需要用户确认设备隔离。 |
| subtitle 模式 | 继续 endpoint loopback，不受该改造影响。 |

已确认产品决策：

- 2026-06-06 负责人确认：旧 Windows 10 也开放用户手动风险模式。理由是 Windows 11 当前市占率已足够高，主体验应优先围绕 Windows 11 / Build 20348+ 的 process-exclude 能力打磨；旧系统不阻断高级用户试用。
- 市场依据：StatCounter Global Stats 的 Desktop Windows Version Market Share Worldwide 显示，2026 年 4 月 Windows 11 为 70.35%，Windows 10 为 28.47%。

风险模式产品约束：

- 不作为默认值，不在首次启动时自动开启。
- 开关放在高级音频设置中，文案明确说明“可能把中文译音重新送入同传模型，导致重复翻译、回声和额外用量”。
- 开启前要求用户显式确认；关闭同传或重启应用后可以保留用户选择，但每次检测到系统不支持 process-exclude 时仍展示状态提示。
- 启用风险模式时，客户端应把 `interpretation.echoAvoidance` 标记为 `disabled`，并在本地会话诊断和 usage metadata 中记录 `echoRiskAccepted=true`。
- Gateway 不因为 `echoAvoidance=disabled` 拒绝同传音频，但应把该状态写入日志和会话元数据，便于回溯成本异常。

## 6. 验收标准

### 6.1 功能验收

- `get_audio_capture_capabilities` 能返回当前系统 build、process-exclude 支持状态和失败原因。
- 同传模式在支持系统上自动使用 process-exclude loopback。
- 字幕模式仍使用 endpoint loopback，默认输出设备切换提示不退化。
- 不支持系统上，客户端不会静默进入“播放译音 + endpoint loopback”组合。

### 6.2 回灌验收

测试材料：

- 源音频：英文技术视频或固定英文 wav。
- 译音：LinguaBridge 播放的中文 PCM。
- 控制样本：只播放中文译音，不播放源音频。

通过标准：

- process-exclude 模式下，只播放中文译音时，发送给 Gateway 的音频 RMS 接近静音阈值，且 ASR 不产生稳定中文文本。
- 同时播放英文源音频和中文译音时，捕获文本以英文源音频为主，不出现持续中文回灌片段。
- endpoint loopback 对照组应能捕获译音，用于证明测试有效。

建议记录指标：

- 捕获帧 RMS / peak。
- Gateway ASR 输出语言分布。
- LiveTranslate 首句延迟、稳态延迟。
- 回灌触发次数。
- process-exclude activation 成功率。

### 6.3 设备矩阵

最低矩阵：

| 系统 | 设备 | 期望 |
| --- | --- | --- |
| Windows 11 当前稳定版 | 内置扬声器 / 有线耳机 | process-exclude 成功，译音不回灌。 |
| Windows 11 当前稳定版 | 蓝牙耳机 | process-exclude 成功，设备切换状态可解释。 |
| Windows 10 Build 20348+ | 默认输出设备 | process-exclude 成功或明确 activation 失败原因。 |
| Windows 10 19045 | 默认输出设备 | 能力探测显示 unsupported，不默认播放译音。 |

## 7. 实施拆分

### PR 1：能力探测与协议/状态

- Rust 增加 `AudioCaptureMode`、`AudioCaptureCapabilities`。
- 新增 Tauri command `get_audio_capture_capabilities`。
- 前端开始页展示同传回灌规避状态。
- 同传启动前根据能力选择 `process_exclude`、安全降级，或用户已确认的风险模式。

验收：不改采集实现也能正确显示支持状态；旧系统只有在用户显式确认后才会进入风险组合。

### PR 2：process-exclude activation spike

- 新增 `wasapi_process_loopback`。
- 封装 `ActivateAudioInterfaceAsync` completion handler。
- 能启动 process loopback capture 并复用现有 frame emitter。
- 加入开发诊断日志和错误码。

验收：Windows 11 上可采集系统原声，并排除当前进程树播放音频。

### PR 3：同传默认接入 process-exclude

- `interpretation` 模式默认使用 `ProcessExcludeLoopback`。
- 不支持时按降级策略处理 `outputAudio`。
- Gateway/客户端错误文案对齐。

验收：同传播放中文译音时不回灌；字幕模式无回归。

### PR 4：稳定性与播放层补强

- 若 Web Audio 排除不稳定，迁移译音播放到 Rust WASAPI shared render。
- 增加 jitter buffer、音量滑杆、stop flush。
- 增加回灌诊断指标。

验收：长时间播放无明显 underrun，停止会话后不会残留译音播放。

## 8. 风险与处理

| 风险 | 处理 |
| --- | --- |
| `ActivateAudioInterfaceAsync` 的 Rust completion handler 实现复杂 | 先参考 Microsoft C++ sample 做最小封装；必要时隔离到独立模块，不污染现有 endpoint loopback。 |
| WebView2 子进程未被稳定排除 | 用控制样本验证；失败后把译音播放迁到 Rust render。 |
| 旧 Windows 10 占比高 | Alpha 收集系统 build；旧系统默认字幕降级，不开放语音同传。 |
| process loopback 不绑定 endpoint，用户对“采集哪个设备”理解变化 | UI 文案从“设备采集”改为“系统音频采集”，设备选择只影响 endpoint fallback。 |
| 误判导致成本浪费 | 同传 output audio 需独立用量事件；回灌检测异常时可自动停止译音播放。 |

## 9. 下一步

建议下一张 PR 先做 PR 1：能力探测与状态展示。这样不会先碰复杂 COM 异步捕获，也能立刻防止不支持系统进入高风险同传播放路径。
