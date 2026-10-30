# larkpilot

把本地 Claude Code 接入飞书：在飞书里直接和 Claude 对话，本地终端的 Claude 任务结束时推送飞书通知。

## 功能

- **飞书机器人**：群内 @机器人 或私聊发消息，调用本地 `claude` CLI 处理，回复以流式卡片实时输出（含 thinking 过程展示）
- **会话续聊**：每个「会话 + 用户」 维护独立的 Claude 会话（4 小时有效）；回复机器人的卡片可直接继续该轮对话；`/session-new` 强制开启新会话
- **任务队列**：全局最多 2 个任务并发，同一会话内串行执行；排队时即时提示
- **任务中止**：对机器人的消息点 ❌（CrossMark 表情）即可中止运行中或排队中的任务
- **hook 通知**：本地交互式 Claude Code 的 `Notification` / `Stop` / `StopFailure` 事件推送飞书卡片通知，所有 hook 事件落库 `agent_hook_log` 表
- **ask 单次任务**：`larkpilot ask` 把内容交给 Claude 执行并将结果发送到指定飞书会话（跨进程串行队列）

## 环境要求

- Node.js >= 22（better-sqlite3 v13 要求）
- [Claude Code](https://claude.com/claude-code) CLI 已安装并登录；守护进程 PATH 找不到 `claude` 时（如 fnm 管理），用 `claudePath` 配置绝对路径
- 飞书开放平台[企业自建应用](https://open.feishu.cn/)：开启机器人能力，事件订阅使用长连接模式（无需公网回调地址），拿到 App ID / App Secret
- 主要在 Windows 上开发运行（任务中止使用 `taskkill`）

## 安装

```bash
npm install
npm install -g .   # 注册全局 larkpilot 命令（或 npm link）
```

## 快速开始

```bash
# 1. 写入飞书应用配置
larkpilot config set appId <appId> appSecret <appSecret>

# 2. 启动机器人后台服务
larkpilot chat start

# 3.（可选）安装本地 Claude Code 的 hook 通知，并指定通知目标会话
larkpilot hook install -g
larkpilot config set hookChatId <chatId>
```

在飞书里把机器人拉进群（或私聊），@它 发消息即可。

## CLI

| 命令 | 说明 |
| --- | --- |
| `larkpilot chat start / stop / restart / status` | 机器人后台服务的启停与状态（pid 文件管理，日志见 `~/.larkpilot/larkpilot.log`） |
| `larkpilot ask --chatId <id> --content <text>` | 提交单次 Claude 任务，结果发送到指定会话（异步串行队列） |
| `larkpilot hook install [-g]` | 把 hook 命令写入 Claude 的 `settings.json`（`-g` 全局，否则当前项目） |
| `larkpilot hook stdin` | 从 stdin 读取 hook 数据（由 Claude Code 调用，落库并按事件类型通知） |
| `larkpilot config set <key> <value> ...` | 写入配置项（key value 成对，可多组） |
| `larkpilot config list` | 查看当前配置（secret 打码） |

## 配置项

配置存在 `~/.larkpilot/larkpilot.db`，改动即时生效（机器人无需重启）。

| key | 说明 |
| --- | --- |
| `appId` / `appSecret` | 飞书自建应用凭证（必填） |
| `hookChatId` | hook 通知的目标会话 ID |
| `claudePath` | `claude` 可执行文件绝对路径，覆盖默认 PATH 查找 |
| `disable_chat_ids` | JSON 数组，关闭这些会话里的机器人，如 `["oc_xxx"]`（解析失败时保持开启） |
| `chat_prompt_<chatId>` | 附加到该会话每条消息后的自定义指令 |

## 机器人使用

- 直接发消息：沿用该会话的 Claude 上下文
- `/session-new [问题]`：开启新会话；带问题时立即在新会话中执行
- `/effort-<level> 问题`：前缀指定推理力度，可选 `low / medium / high / xhigh / max`，缺省 `medium`
- 回复机器人的卡片：继续该卡片对应的对话
- 点 ❌：中止对应任务（运行中杀进程树，排队中移出队列）
- 发送文件/图片等资源会自动下载并附上本地路径给 Claude

> ⚠️ 机器人以 `--permission-mode bypassPermissions` 运行本地 Claude，即拥有本机的完整执行权限，请仅在可信会话中使用。

## 数据目录 `~/.larkpilot/`

| 路径 | 内容 |
| --- | --- |
| `larkpilot.db` | 配置、消息-会话映射、hook 日志（sqlite，WAL） |
| `larkpilot.log` | 运行日志（按天滚动，历史存为 `larkpilot.log.<date>`） |
| `chats/` | 机器人对话启动 Claude 的工作目录，**自定义SKILL可安装在此目录下** |
| `chat-session.json` | 已执行的 Claude 会话 ID（TTL 4 小时） |
| `files/` | 消息资源下载目录 |
| `ask-queue/` | ask 任务队列（json 任务文件 + 锁文件） |
| `larkpilot.pid` | 守护进程 pid |

## 代码结构

```
index.js   CLI 入口（commander）：服务启停、ask 队列、hook、config
chat.js    机器人守护进程：飞书长连接、会话管理、任务队列、流式卡片渲染
common.js  共享模块：sqlite、配置读写、任务日志、claude 命令解析、编码处理
hook.js    hook 数据处理与安装：事件落库、飞书卡片通知
test/      单元测试（node:test）
```
