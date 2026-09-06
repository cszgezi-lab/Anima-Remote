# Anima Remote 验收测试

这个目录是零第三方依赖的 `node:test` 测试包，只检查 `Anima-Remote` 项目本身；它不启动、修改或依赖现有生产 SillyTavern。默认运行静态契约测试。只有同时提供 `ANIMA_TEST_URL`、`ANIMA_TEST_TOKEN_A` 和 `ANIMA_TEST_TOKEN_B` 时，远程黑盒测试才会运行；否则黑盒用例会明确显示为 skipped，静态用例仍然执行。

## 运行

要在本机自动启动隔离的临时服务、生成两枚临时令牌并执行完整黑盒测试，可运行：

```text
npm --prefix integration-tests run test:local
```

临时令牌不会输出，服务退出后测试数据目录会被删除。

在项目根目录执行：

```text
npm --prefix integration-tests test
npm --prefix integration-tests run test:static
npm --prefix integration-tests run test:blackbox
```

运行黑盒前，应准备一个专门的临时/验收服务，并在当前终端临时设置环境变量。不要把令牌写入仓库、fixture、命令历史或截图：

PowerShell 示例（令牌值请从密码管理器等安全途径注入，不要照抄到文件）：

```powershell
$env:ANIMA_TEST_URL = "https://<tailscale-serve-host>"
$env:ANIMA_TEST_TOKEN_A = <token-a>
$env:ANIMA_TEST_TOKEN_B = <token-b>
npm --prefix integration-tests run test:blackbox
```

`ANIMA_TEST_URL` 必须是 HTTPS；仅 `http://localhost`、`http://127.0.0.1` 和 `http://[::1]` 被视为本地测试例外。手机正式连接不能使用 `http://100.x.x.x`，应使用 Tailscale Serve 或其他明确配置的 HTTPS 反向代理地址。

## 黑盒覆盖范围

黑盒会覆盖：

- 未认证 `healthz`、无令牌 `401`、认证 `me`；
- `OPTIONS` 的 CORS 预检；
- 两枚令牌使用同一随机逻辑 ID 时的知识库列表、导出、查询、覆盖和删除隔离；
- global settings 的递增 revision、陈旧 revision 的 `409`、历史记录和递归秘密字段过滤；
- 代理转发对 loopback 私网目标的拒绝。

测试数据使用 `anima-it-<随机前缀>`，知识库使用 BM25-only 导入，不调用外部 embedding 服务。测试结束会尽力删除两租户的随机知识库，并把随机 settings 文档清为空值；服务异常时不能保证清理，因此请只使用专门的验收服务。

测试代码不打印请求令牌，也没有明文令牌 fixture。黑盒失败信息只包含方法、逻辑路径和 HTTP 状态，不回显响应正文。未设置完整环境变量时，测试不会请求任何服务器。

## 结果解释

- `pass`：对应契约通过。
- `skip`：没有完整设置三个黑盒环境变量；这是预期的离线运行结果，不代表黑盒通过。
- `fail`：实现尚未满足契约，或验收服务配置/状态不正确。测试包不会自动切换到生产服务器，也不会替用户修改服务。
