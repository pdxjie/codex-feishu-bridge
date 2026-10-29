# Codex 飞书桥接服务

在运行 Codex Desktop 的 Mac 上启动一个飞书机器人，通过飞书列出、切换和继续本机 Codex 会话。

当前 MVP 已实现：

- 飞书长连接接收消息，无需暴露公网端口。
- 管理员 `open_id` 保留完整 Desktop 权限；其他企业成员可进入隔离的 ERP 只读访客模式。
- 分页列出 Codex 项目，并分页浏览每个项目下的全部活跃及已归档会话。
- 在指定项目下创建新会话、自由切换会话、发送任务和中断任务。
- 飞书消息通过 Codex Desktop 自己的会话通道投递，会立即显示在电脑端的同一个会话中，不再由旁路 App Server 写入或自动分叉。
- 支持多个不同会话并行工作；同一会话保持单写入顺序，避免上下文分叉和记忆错乱。
- 通过持续更新同一张飞书卡片，近实时展示 Desktop 中的公开思考摘要、计划、工具状态和回复。
- 每个飞书任务结束后自动推送最终回复，并在消息最前面标注会话标题。
- 命令执行和文件修改使用飞书审批卡片，审批 10 分钟超时后自动拒绝。
- SQLite 保存用户当前会话、消息去重和任务路由。
- 新会话目录受白名单限制，并解析符号链接防止目录越界。

> Codex App Server 目前仍是实验性协议。本项目将所有协议调用集中在 `src/codex/`，升级 Codex 后应先运行健康检查和测试。

为了通过 Desktop 的本地进程身份校验，项目还会在 `~/.codex/config.toml` 注册一个无工具的轻量 MCP 常驻进程 `feishu_desktop_bridge`。它由 Codex Desktop 自己启动，只在本机用户目录创建权限为 `0600` 的 Unix socket，不监听网络端口。

## 运行要求

- macOS 上已安装并登录 Codex Desktop。
- Node.js 24；项目提供 `.nvmrc`。
- 飞书企业自建应用，已启用机器人和长连接。

当前机器已经验证可使用的内置 Codex CLI 路径为：

```text
/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
```

## 1. 配置飞书应用

在飞书开放平台创建“企业自建应用”，然后：

1. 启用机器人能力。
2. 在“事件与回调”中选择“使用长连接接收事件/回调”。
3. 订阅事件 `im.message.receive_v1`（接收消息）。
4. 订阅回调 `card.action.trigger`（卡片操作）。
5. 按控制台提示开通接收消息和“以应用身份发送消息”等权限。若希望访客会话标题显示真实姓名，还需开通用户基本信息只读权限（否则安全回退为 `同事-xxxx`）。
6. 发布应用版本，并让需要使用的成员可见。

群聊中只有 `@机器人` 的消息会按飞书配置推送；单聊可以直接发送。

## 2. 配置本地环境

```bash
cd ~/Desktop/codex-feishu-bridge
nvm use
cp .env.example .env
```

编辑 `.env`：

- `FEISHU_APP_ID`、`FEISHU_APP_SECRET`：飞书应用凭证。
- `FEISHU_ALLOWED_OPEN_IDS`：管理员用户 `open_id`，多个值用逗号分隔；这些用户可以操作本机 Desktop 会话。
- `FEISHU_GUEST_MODE_ENABLED=true`：让其他可联系机器人的成员自动进入访客模式，无需逐个配置白名单。
- `FEISHU_TENANT_KEY`：可选；配置后访客必须来自这个飞书企业。
- `GUEST_WORKSPACE_ROOT`：访客唯一允许读取的 ERP 项目目录。
- `GUEST_DB_CONFIG_PATH`、`GUEST_DB_CONNECTION`：访客生产只读数据库配置；连接必须同时标记为 `production` 和 `readonly`。
- `GUEST_MAX_CONCURRENT_TURNS`：全局访客任务并发上限。
- `ALLOWED_WORKSPACE_ROOTS`：允许创建 Codex 会话的根目录。
- `DEFAULT_WORKSPACE`：执行 `/codex new` 时的默认目录。

如果暂时不知道自己的 `open_id`，可以先填一个占位值并启动服务，然后给机器人发送消息。服务日志会输出被拒绝用户的 `openId`，复制到 `.env` 后重启即可。

## 3. 验证和启动

```bash
npm install
npm run check
npm test
npm run codex:check
npm start
```

`npm run codex:check` 会连接真实的本机 Codex App Server，并打印项目及会话统计，但不会修改会话。

### macOS 常驻运行（推荐）

直接运行 `npm start` 依赖当前终端保持打开。要让飞书随时唤醒本机 Codex，请安装项目附带的 LaunchAgent：

```bash
./scripts/service.sh install
./scripts/service.sh status
```

服务会在当前 macOS 用户登录后自动启动，异常退出时自动重启。常用命令：

```bash
./scripts/service.sh restart   # 修改代码或配置后重启
./scripts/service.sh logs      # 查看最近日志
./scripts/service.sh stop      # 停止服务
```

日志保存在 `data/bridge.out.log` 和 `data/bridge.err.log`，两者均已被 `.gitignore` 中的 `data/` 规则忽略。

## 飞书命令

```text
/codex sessions              列出项目及项目会话
/codex projects              列出项目及项目会话
/codex project <项目ID>       打开指定项目
/codex current               查看当前会话
/codex use <会话ID>           切换会话
/codex new                   准备在当前项目中新建会话
/codex new <绝对目录>         准备在该 Codex Desktop 项目中新建会话
/codex stop                  停止当前任务
/codex help                  查看帮助
```

项目卡片可以进入项目、翻页浏览全部会话，并在项目中准备新会话。点击“新建会话”后，下一条普通文字会成为 Desktop 真实会话的首条任务；这可避免生成只存在于独立 App Server 内存中、Desktop 无法恢复的临时空会话。选择已有会话后，普通文字消息会直接发送给该会话。

会话归类优先使用 Codex 保存的正式 `projectId`。旧会话没有项目归属时，会按工作目录匹配项目根目录；嵌套项目选择最长的根目录，仍无法匹配的会话进入“未归类会话”。选择已归档会话时会先恢复归档，再切换到该会话。

## 管理员与访客模式

`FEISHU_ALLOWED_OPEN_IDS` 中的用户是管理员，继续使用现有 Codex Desktop 项目、会话和实时互通能力。开启访客模式后，其他能够联系企业自建机器人的成员自动使用受限的只读执行器：

- 每位访客第一次直接聊天时，会在 Desktop 的“自主排查”项目下创建且只创建一个固定会话，标题为 `自主排查@飞书姓名`；后续问题始终进入这个会话。
- 访客没有项目/会话列表、切换或新建入口；所有 `/codex ...` 命令只会提示直接发送问题，无法枚举管理员或其他同事的会话。
- 只读执行器共享 Desktop 的项目与会话索引，以便会话在电脑端实时可见；启动时会显式停用管理员的全部 MCP、应用工具、浏览器、Shell、多代理、远程插件和 worktree。
- 内置 Shell、文件修改、浏览器、应用工具、多代理和 worktree 能力均被关闭。
- 访客只获得桥接服务注册的源码搜索、源码片段读取、目录浏览、表结构、`EXPLAIN` 和只读查询工具。
- 源码工具只接受 `GUEST_WORKSPACE_ROOT` 内的相对路径，解析符号链接后再次校验，并拦截 `.env`、密钥、证书和数据库凭据文件。
- 生产查询固定使用配置的只读连接；只允许单条 `SELECT`、`SHOW`、`DESCRIBE` 或 `EXPLAIN`，限制返回行数并脱敏敏感字段。
- 访客权限请求会自动拒绝，不能通过飞书审批获得更高权限。

访客无需也不能管理 Codex 项目或会话，只需直接聊天。企业自建应用仍应在飞书后台限制为本企业成员可见；如需额外防护，可配置 `FEISHU_TENANT_KEY`。

## 同一会话互通与多任务并行

Codex 的同一个会话同一时间只能有一个执行任务，但不同会话可以并行工作：

- 飞书普通文字会通过 Desktop 的 `send_message_to_thread` 通道写入当前选中的真实会话，电脑端会立即看到这条用户消息。
- 任务仍在运行时，同一会话不会自动创建分支；机器人会提示等待完成或切换到其他会话。
- 需要并行时，先用 `/codex sessions` 切换到另一个会话后发送任务。不同会话可同时执行。
- Desktop 产生的公开进度、回复和最终结果会按原会话路由回飞书。
- 每个任务完成、失败或中断后都会自动推送结果卡片，卡片标题及正文首行会显示对应会话标题。

这样飞书与电脑端看到的是同一份历史，不会因隐藏的并行分支产生上下文或记忆错乱。

## 实时进度

任务提交后，桥接服务会创建一张带会话标题的“Codex 正在工作”卡片，并以 rollout 增量事件约每 400ms 读取新进度、约每 900ms 更新飞书卡片，同时用 Desktop 快照兜底最终状态。卡片可能包含：

- 模型公开提供的思考摘要；
- 当前执行计划及各步骤状态；
- 命令、文件修改和工具调用状态；
- Codex 已公开输出的回复增量。

飞书机器人消息并不是浏览器 SSE 连接，因此这里使用“Desktop 会话快照 + 飞书消息更新”实现近实时效果。服务不会转发模型原始隐式思维文本，也不会展示命令正文或命令输出，只同步公开的思考摘要和进度，避免泄露内部推理和潜在敏感数据。任务结束后，进度卡片会标记为已结束，并另外发送一张最终结果卡片以触发完成通知。

## 安全说明

- `.env` 已加入 `.gitignore`，不要提交飞书密钥。
- App Server 使用本地标准输入输出；Desktop helper 只使用权限为 `0600` 的本机 Unix socket，均不监听公网端口。
- 未配置在 `FEISHU_ALLOWED_OPEN_IDS` 中的用户在访客模式关闭时无法执行任务；开启后只能进入隔离的只读 ERP 诊断通道。
- 只提供“仅本次允许”审批，不提供会话级永久授权。
- 没有飞书路由的审批请求会自动拒绝。
- 同一个会话不会被桥接服务自动派生；忙碌时需要等待或显式切换其他会话。

## 项目结构

```text
src/
  codex/        Codex App Server JSONL-RPC 客户端和协议适配
  feishu/       飞书长连接、消息发送和交互卡片
  guest/        访客隔离运行时和源码/数据库只读工具
  app.ts        会话路由、命令、审批和任务生命周期
  config.ts     环境配置和工作目录安全校验
  store.ts      SQLite 状态存储
  doctor.ts     Codex 只读健康检查
```

官方参考：[Codex App Server](https://developers.openai.com/codex/app-server/)
