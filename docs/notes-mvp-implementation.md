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

- 当前版本使用 mock model provider，不调用真实阿里云模型，也不会在客户端保存云服务密钥。
- Windows WASAPI loopback 先保留 Rust 模块边界和 Tauri command，真实采集作为 Phase 0 Spike 后续实现。
- 本地开发可使用内存存储验证邀请码、用量和会话；PostgreSQL/OSS 删除闭环会在 Alpha 数据层实现时补齐。
- 数据保留策略维持 PRD 确认的默认 30 天，不新增关闭云端保存开关。

## 3. 开发入口

```bash
npm install
npm run typecheck
npm run build
npm run dev:gateway
npm run dev:desktop
```

需要真实桌面客户端时，还需要安装 Tauri v2 的系统依赖、Rust 工具链和 Windows WebView2。

## 4. Phase 0 待验证

- Windows WASAPI loopback：默认输出设备、蓝牙耳机切换、空音频、采样率转换。
- 字幕浮窗：置顶、多显示器、DPI 缩放、锁定和透明度。
- ASR + Qwen-MT：5 段技术视频样本延迟和术语表现。
- LiveTranslate：与 ASR + MT 对比延迟、分段和术语质量。
- 会话落盘：音频、字幕、修订历史、导出文件、删除路径。
- 邀请码和用量：激活、额度、append-only usage events、后台成本口径。
