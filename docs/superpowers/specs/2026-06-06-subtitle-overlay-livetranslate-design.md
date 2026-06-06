# Subtitle Overlay and LiveTranslate Stability Design

## 背景

LinguaBridge 当前桌面端默认以 `interpretation` 模式启动真实会话。主窗口保存完整实时字幕流，悬浮窗通过 `overlay-subtitle-sync` 事件同步最近字幕。

当前用户反馈有两个体验问题：

- 悬浮窗换行和滚动不足，长字幕经常超出窗口边界；需要只保留前一句和当下句子，并自动滚动。
- 中文同传短句不稳定，经常在句子中间停止；需要规划修复 LiveTranslate 文本流处理。

本设计不改变 MVP 产品方向、数据保留策略、云厂商或协议范围。目标是先优化现有桌面字幕体验与 Gateway LiveTranslate 事件处理，不引入新模型或新第三方服务。

## 目标

- 悬浮窗只展示“上一句 + 当前句”，保持跟读视野轻量稳定。
- 主窗口继续保留完整字幕流，用于调试、复盘和后续导出观察。
- 悬浮窗和主窗口在新字幕、修订字幕到达时自动滚动到最新内容。
- 长中文/英文字幕自然换行；即使两句超过悬浮窗高度，也应滚动到当前句底部，而不是裁掉不可见。
- LiveTranslate 文本事件按 `item_id` 聚合，避免把增量片段误当完整句覆盖。
- 同传字幕在未稳定前保持 `draft`，只在完成事件或稳定策略满足后进入 `final`。

## 非目标

- 不改变首发 Windows PC 客户端形态。
- 不改隐私授权、音频落盘、字幕落盘或删除机制。
- 不新增云厂商、模型供应商或客户端直连模型服务。
- 不重做统一句子分割协议，不改变 `subtitle.segment.updated` 的 payload 结构。
- 不在本轮实现正式后台运营、限流或支付能力。

## 方案选择

采用方案 A + B：

- A：先修 UI 显示和滚动，悬浮窗只显示两句，主窗口保留完整流。
- B：为 Alibaba Cloud LiveTranslate session 增加文本缓冲，按事件类型和 `item_id` 稳定 source/target 文本。

暂不采用方案 C，即把 ASR/MT/LiveTranslate 全部重构为统一 sentence segmenter。该方案长期更干净，但会扩大协议、落盘和导出影响面，不适合当前体验修复。

## 字幕显示设计

### 悬浮窗字幕选择

新增或抽出一个纯函数，例如 `selectOverlaySegments(segments)`：

- 输入为主窗口完整 `SubtitleSegmentEvent[]`。
- 先按 `startAtMs`、`endAtMs` 和原数组顺序稳定排序。
- 当前句定义为排序后的最新段，优先保留正在更新的 `draft`，否则保留最新 `final` 或 `revised`。
- 上一句定义为当前句之前最近的不同 `segmentId`。
- 输出最多两段：上一句在前，当前句在后。

`publishOverlaySubtitles()`、`readCachedOverlaySubtitles()` 和 `OverlayWindow` 订阅回调都使用同一选择函数，避免主窗口发布和浮窗本地缓存规则分叉。

### 悬浮窗布局

`.caption-stage` 从居中 grid 改为滚动字幕视口：

- 使用 `overflow-y: auto`，隐藏或弱化滚动条。
- 内容底部对齐，当前句靠近下方。
- 每个 `.caption-line` 保持自然换行，使用稳定的 `line-height` 和 `overflow-wrap: anywhere`。
- 当前句视觉权重高于上一句；上一句降低透明度或字号，不新增解释性文案。
- 长句超过可视高度时，不裁切字幕内容；自动滚动到当前句底部。

`OverlayWindow` 增加底部锚点 `ref`。每次 `visibleSegments`、`lineMode` 或 `fontSize` 变化后调用 `scrollIntoView({ block: "end" })`。

### 主窗口滚动

`liveSubtitleSegments` 继续保留完整流，不做裁剪。

主窗口 `.subtitle-stream` 增加末尾锚点。每次完整字幕流长度、最新段修订号或最新段文本变化后自动滚动到底。用户仍可手动向上查看历史；本轮不增加“锁定滚动”开关，保持实现简单。

## LiveTranslate 文本稳定设计

### 当前问题假设

当前 `AlibabaCloudLiveTranslateSession` 直接读取 `response.text.text`、`response.text.done`、`response.audio_transcript.text` 和 `response.audio_transcript.done` 的 `text/transcript/stash` 字段，并立刻写入 `segment.targetText`。

如果服务端事件是增量 delta、临时片段或包含 `stash` 的组合文本，直接覆盖可能导致：

- 新增片段覆盖完整草稿，字幕看起来停在半句。
- 较短临时文本回退显示，用户误以为句子中断。
- source completed 到达后 target 尚未 done，却提前以 `final` 状态发给 UI。

`ctx7` 对 LiveTranslate 当前事件语义检索未返回有效文档：一个结果被验证码阻挡，另一个返回不相关模型条目。因此实现必须先用真实日志和合成测试固化字段行为。

### 缓冲模型

为 LiveTranslate 增加按 `item_id` 管理的文本状态，例如：

- `sourceDraft`
- `sourceFinal`
- `targetDraft`
- `targetFinal`
- `sourceCompleted`
- `targetCompleted`
- `lastUpdatedAtMs`
- `revision`

source 事件处理：

- `conversation.item.input_audio_transcription.text` 更新 source draft。
- `conversation.item.input_audio_transcription.completed` 更新 source final，并标记 source completed。
- 若新 draft 短于旧 draft，且不是 completed 事件，不回退显示。

target 事件处理：

- `response.text.text` 和 `response.audio_transcript.text` 更新 target draft。
- `response.text.done` 和 `response.audio_transcript.done` 更新 target final，并标记 target completed。
- 对非 done 事件，如果文本短于当前 target draft 且不是当前 draft 的合理前缀延续，不回退显示。
- 对可能的增量字段，优先把同一 item 的文本累积成完整 draft；如果真实日志证明事件字段已经是完整快照，则保持最大稳定快照。

### 状态输出

`emitSegment()` 根据缓冲状态决定 status：

- source 或 target 未完成时输出 `draft`。
- source completed 且 target completed 时输出 `final`。
- 若 source completed 后 target 长时间没有 done，但 target draft 非空，可以保持 `draft` 并继续刷新，不提前 final。

同传链路目前不接 `SubtitleEngine` 的 revision timer。本轮只修 LiveTranslate 自身分段稳定性，不引入上下文修订，避免扩大范围。

### 诊断日志

在 debug 级别记录 LiveTranslate 文本事件的安全摘要：

- event type
- item id 是否存在
- source/target 文本长度
- 是否 completed
- 是否发生短文本回退保护

日志不能输出 API key、Authorization header、完整音频或敏感凭证。

## 测试设计

### 桌面端单元测试

新增针对 overlay 字幕选择规则的测试：

- 空数组返回空数组。
- 一段字幕只返回一段。
- 多段字幕返回上一句和当前句。
- 同一 `segmentId` 的 draft/final/revised 更新不会重复占两行。
- 排序不依赖输入数组偶然顺序。

如当前 desktop 测试基础薄弱，先新增纯函数并纳入 TypeScript typecheck；后续再补 Vitest 或 node test 需要单独评估。

### Gateway 单元测试

为 `AlibabaCloudLiveTranslateSession` 的文本归并逻辑抽纯函数或小类，并测试：

- 增量 target 事件可以累积为完整中文句。
- 非 done 短文本不会覆盖更长 draft。
- source completed 但 target 未 completed 时仍为 `draft`。
- source 和 target 都 completed 后输出 `final`。
- 缺失 `item_id` 时仍能归到当前 item，但不会混淆多个有明确 `item_id` 的段。

### 手工验证

- 悬浮窗默认 980x220、最小 560x140、大字号 44px 下，播放长中文句时当前句可见且自动滚到底。
- 双语模式下英文原文不把中文当前句挤出可视区。
- 主窗口持续接收 10 段字幕后自动滚到最新段，历史段仍存在。
- 真实 LiveTranslate 测试时记录至少 5 段技术课程样本，观察短句是否仍半句停止，并检查 debug 日志中的事件字段形态。

## 风险与缓解

- LiveTranslate 真实事件字段可能与当前假设不同。缓解：先抽缓冲逻辑并用真实日志校准，避免在 UI 层掩盖服务端文本问题。
- 自动滚动可能影响用户回看主窗口历史。缓解：本轮保持简单；如果内测反馈强烈，再增加“用户手动上滚时暂停自动滚动”的小功能。
- 两句字幕在极小悬浮窗和超大字号下仍可能超过可视区。缓解：容器滚动到底，保证当前句末尾可见；不强制缩小用户字号。
- 同传 final 延迟可能略增加。缓解：draft 持续刷新，final 只作为稳定状态；优先避免半句误完成。

## 验收标准

- 悬浮窗最多显示两句：上一句和当前句。
- 悬浮窗长句不会被外层 `overflow: hidden` 静默裁掉，当前句到达或修订后自动滚动到可见位置。
- 主窗口完整字幕流不被裁剪，并在新字幕到达时滚到底。
- LiveTranslate 合成测试覆盖短文本回退、增量累积和 final 判定。
- `npm run typecheck --workspaces --if-present` 通过。
- Gateway 相关测试通过；如真实阿里云凭证不可用，最终说明真实链路仅完成手工验证规划，未宣称云端行为已通过。
