# Change Log

## 1.0.5（2026-11-13）

- 新增：流式卡片 loading banner —— 新配置 `lark_stream_loading_banner_img`（JSON：`{"default":"img_key","heavy":"img_key"}`），会话前 5 轮用 `default`、第 6 轮起用 `heavy`，卡片定稿（滚动换卡 / 执行结束）时移除（19a3544）
- 优化：chat 进程 `isAlive` 判定 —— 在 signal-0 探测基础上校验进程命令行（Windows 走 PowerShell `Get-CimInstance`，Unix 走 `ps`），防止 pid 回收后被无关进程误判为机器人进程；新增 `test/is-alive.test.js`（8206a99）
- 修复：在 `/session-new` 新开会话上点 ❌ 中止时，若 claude 尚未将 transcript 落盘，则丢弃该 session ID 而非持久化，避免下次 `--resume` 报 "No conversation found with session ID"（479e7e5）
- 新增：`chat_session_ttl` 配置（秒，缺省 `3600`），会话超时失效时间可调，非法值回退缺省（7e80e02）

## 1.0.4（2026-11-06）

- 新增：`max_concurrent` 配置，全局最大并发任务数（缺省 `2`，非法值回退缺省）
- 新增：`lark_stream_throttle_ms` 配置，卡片流式更新节流间隔（毫秒，缺省 `200`）
- 新增：按群聊配置 `chat_<chatId>`（JSON：`prompt` / `disabled` / `model` / `stream_end_at`），替代原 `disable_chat_ids` 与 `chat_prompt_<chatId>` 两个配置项
- 新增：`/model <model>` 指令设置该群聊调用的 claude 模型（全群生效）
- 新增：`/stream_end_at_enable` / `/stream_end_at_disable` 指令，控制该群聊执行结束后是否单独 @ 提问者并回复最后一张卡片（默认开启）（bcbeb59）

## 1.0.3（2026-11-02）

- 变更：回复机器人卡片可续聊原会话的判定放宽 —— 会话过期后 7 日内（`REPLY_SESSION_GRACE_MS`）仍可通过回复卡片续聊（358dbdc）
- 变更：更新 .gitignore（ee24ebe）
- 变更：package.json 描述更新为「飞书智能助手 + 本地Agent（Claude Code）」，keywords 增加 `claude code`（1995f95）

## 1.0.2（2026-10-30）

- 变更：package.json 补充 GitHub repository 地址，仅版本号与元数据更新（817c820）

## 1.0.1（2026-10-30）

- 架构：新增 `chat.js` 机器人守护进程 —— 飞书长连接、按「会话 + 用户」维度的 Claude 会话续聊（TTL 4 小时）、全局任务队列（并发 2、同会话串行）、❌（CrossMark）中止任务、流式卡片实时输出（含 thinking 过程）
- 新增：`hook.js` —— 本地 Claude Code 的 `Notification` / `Stop` / `StopFailure` hook 事件推送飞书卡片通知，事件落库 `agent_hook_log` 表
- 新增：`larkpilot ask` 单次任务命令，结果发送到指定飞书会话（跨进程串行队列）
- 新增：`larkpilot hook install [-g]`、`larkpilot hook stdin`、`larkpilot config set/list` 子命令；原 `cli.js` 并入 `index.js`
- 新增：README、LICENSE、单元测试（node:test）
- 配置：配置项存 sqlite（`~/.larkpilot/larkpilot.db`），改动即时生效无需重启；支持 `hookChatId`、`claudePath`、`disable_chat_ids`、`chat_prompt_<chatId>`（f081f20）

## 1.0.0（2026-10-18）

- 首个版本：飞书 claude 机器人基础版（`index.js`，长连接模式）
- 新增：`cli.js` 命令行入口（`start` / `stop` 等后台服务管理、pid 文件）
- 新增：`common.js` 共享模块（数据目录、配置读写、进程存活判定、任务日志）（7d5435c、774e895）
