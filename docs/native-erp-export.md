# 本机 ERP 原生导出

原生导出直接复用 `/Users/gaochenjie/Desktop/mc` 的代码，在这台 Mac 上运行，**不需要远程服务器、不需要部署生产 ERP，也不需要同事提供登录密码或 Cookie**。

只读数据库账号负责生产取数；本机内部接口的随机服务凭证负责确认请求确实来自飞书桥。这两种凭证已分别配置，均不交给模型或同事。

## 同事如何使用

直接说出业务、筛选范围和导出要求。机器人先匹配原生导出目录，通过临时脚本执行，最后将 Excel 附件发送到原来的飞书聊天，可直接预览或下载。当前是文件附件，不创建飞书云表格或永久云盘分享链接。

| 已接入类型 | 示例 | 权限与口径 |
| --- | --- | --- |
| 渠道库存列表 | “导出亚马逊渠道美国仓库中 SKU G10050LG01A-JH 的渠道库存，Excel。” | 页面权限 881；渠道必填，按当前平台、店铺站点推导国家和品类范围；保持 ERP 固定 8 列。共享库存并不授予其他店铺订单明细的访问权。 |
| 采购单商品明细 | “按 ERP 采购单导出口径，导出 2026-10-01 到 2026-10-30 包含 SKU G37007BR05A-YF 的采购单商品明细，包含采购单号、SKU、数量和预计交期。” | 页面 22 + 导出 895；最多 31 天；沿用 ERP 采购归属、供应商范围、默认排除取消单等逻辑。SKU 匹配采购单，可能包含同单其他商品。供应商和采购价字段分别要求 906/907。 |

当前只接入以上两种。其他 ERP 已有导出需要逐项登记业务、参数和授权规则；不能自动猜测 URL 或执行模型生成的任意代码。特殊统计和联合诊断证据仍使用已有受控只读导出。原生接口明确拒绝权限时，不自动改用 SQL 绕过。

原生导出上限为 **10,000 条数据、30 MB、单工作表 XLSX**。超限要求缩小筛选范围，不静默截断。旧 SQL 导出路径还受数据库网关 maxRows 约束。

## 本机执行链路

1. 飞书桥绑定真实对话用户身份，模型只能提交导出类型和筛选条件，不能指定其他用户。
2. 桥接为任务创建权限 0700 的临时目录，写入固定 `runner.mjs` 和业务参数。服务凭证通过子进程 stdin 传入，不落入脚本、参数文件、日志或模型上下文。
3. 脚本调用 `http://127.0.0.1:23419/native-export`。该端口只监听本机，不暴露普通 ERP 网页或任意文件。
4. 本机服务为每次请求启动独立 PHP CLI 进程，最多并行 4 个请求。入口是 `mc/tools/codex-export-local.php`；不会加载项目的 `dev.env`，也不会运行正常 Web 启动器、登录流程、队列或定时业务任务。
5. PHP 从现有 `~/.config/mc-ai/connections.json` 中读取 `production` / `readonly` 连接，覆盖当前进程的数据库配置，不修改项目原有环境文件。核验真实 GRANTS，拒绝 DML、DDL、可写角色授权和 GRANT OPTION；兼容现有 RDS 账号的监控、复制查看和 LOCK TABLES 权限，并为实际 PDO/mysqli 连接设置 `SET SESSION TRANSACTION READ ONLY`。导出构建器只执行查询，不使用锁表/复制管理命令。
6. PHP 对每次请求验证 HMAC、时间和一次性 nonce，再校验本人 ERP 页面、导出、字段和数据范围权限，调用本地项目现有导出构建器与 Excel 写入器。
7. 任务状态存于本机文件，使用排他锁和固定请求 ID，不写生产 `export_task` 或生产临时表。网络失败后仅查询同一任务，不自动重复创建。
8. 桥接核对文件大小、SHA256、实际工作表数和行数。下载及飞书发送前再次授权；权限撤回会阻止发送。
9. 发送成功后删除两侧临时文件。失败不发送到其他聊天，也不声称成功。

新增业务查询放在 Domain DAO 或既有遗留 Model；原生 Service 负责授权和流程，继续复用项目的 Eloquent / 旧 mysqli 两条数据访问路线。

## 本机配置与运行

桥接 `.env` 已配置以下字段，凭证内容不写在这里：

```dotenv
ERP_NATIVE_EXPORT_URL=http://127.0.0.1:23419/native-export
ERP_NATIVE_EXPORT_PROJECT_ROOT=/Users/gaochenjie/Desktop/mc
ERP_NATIVE_EXPORT_PHP_BIN=/Users/gaochenjie/Library/PhpWebStudy/env/php/php
ERP_NATIVE_EXPORT_SECRET_FILE=/Users/gaochenjie/.config/codex-feishu-bridge/native-export.secret
```

凭证文件权限 0600，位于游客项目目录之外。数据库连接来自 `GUEST_DB_CONFIG_PATH`（默认 `~/.config/mc-ai/connections.json`）。不要把凭证放进 Git 或游客可读源码目录。

本地导出服务由 LaunchAgent `com.gaochenjie.codex-erp-export` 保持运行，登录后启动、异常退出后重启。桥接本身仍由原有 LaunchAgent 管理。

```sh
./scripts/export-service.sh status
./scripts/export-service.sh restart
./scripts/service.sh status
```

导出进程和主桥接进程有独立生命周期。更新代码后应先等正在执行的任务结束再重启；本机退出登录、关机或强制系统睡眠期间无法服务。锁屏不要求退出应用，原桥接的系统保活继续生效。

`GET http://127.0.0.1:23419/health` 返回进程状态和当前请求数；它不证明数据库或全部导出功能正常。其他未登记路由一律拒绝。

## 文件保留与日志

- 桥接脚本/下载文件：`GUEST_EXPORT_ROOT/native-jobs`；发送成功立即删除，异常遗留超过 24 小时的目录在桥接启动时清理。
- PHP 导出文件：`GUEST_EXPORT_ROOT/erp-native-server`，权限 0700。发送成功 ack 后立即删除；每次认证请求检查过期文件，本机服务另每小时执行一次清理，无需远程 cron。执行中的锁会被跳过。
- 远端概念在本机模式中只是另一个本机目录；没有业务文件上传到额外服务器。
- 任务状态和锁作为幂等记录保留，不含原始导出数据；nonce 在重放窗口结束后清理。
- 日志位于 `data/native-export.out.log`、`data/native-export.err.log`，只保留服务状态和异常类型/代码位置，不记录 SQL、账号、请求体或文件内容。

## 验证与故障处理

本地回归：桥接 `npm run check`、`npm test`；ERP `php tests/regression/bridge_native_export_test.php` 和改动文件 lint。回归测试使用模拟授权和本地 HTTP 接口，不向飞书发送消息。

2026-10-30 已通过真实本机接口与生产只读连接联调：渠道库存 31 行、采购单商品明细 25 行；执行了真实 Excel 下载校验、发送前授权检查和 ack 清理。测试文件未发给任何同事。这证明本机原生导出链路可用；飞书投递沿用已有发送附件流程，尚未代同事实际发起消息验收。

如果响应“权限不足”，先核对目标页面/导出/字段权限；如果响应“暂无法确认数据授权范围”，补充渠道、国家或问题方向。如果服务不可用，查看两个服务状态及脱敏错误日志；不要切换到管理员数据库或索取同事 Cookie。

需要停用时，先等待任务结束，成对移除两个 `ERP_NATIVE_EXPORT_URL` / `ERP_NATIVE_EXPORT_SECRET_FILE` 设置并重启桥接，再停止导出服务。不要改动普通 ERP 的环境设置。
