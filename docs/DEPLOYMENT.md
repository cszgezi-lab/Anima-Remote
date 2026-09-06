# Anima Remote 部署

本部署包面向一台服务器上的独立 Anima Remote 服务。它使用独立的 Docker 项目和 `deploy/data` 持久化目录，不挂载、覆盖或修改现有 SillyTavern 的 `plugins/anima-rag` 目录。默认仅在服务器回环地址发布端口，再由 Tailscale Serve 提供 Tailnet 内的 HTTPS MagicDNS 入口。

## 重要门禁

镜像的正常启动命令是 `/app/server/standalone.js`。容器入口脚本会检查这个文件；如果当前代码仍只有 `server/index.js` 这个 SillyTavern 插件入口，容器会主动拒绝启动。这是有意的安全门，不能把插件入口直接当成带认证、带租户隔离的远程服务。

因此，部署前必须看到独立运行器、`GET /healthz` 和认证后的 `GET /v1/me`。若检查失败，状态应记录为“暂不部署”，不要用旧插件目录代替，也不要把现有酒馆停下来迁移数据。当前迁移门禁见 [MIGRATION.md](MIGRATION.md)。

## 目录与前置条件

在服务器准备一个独立的项目目录，例如 `/srv/anima-remote`；下面命令中的路径可替换为实际项目目录：

```bash
cd /srv/anima-remote
test -f deploy/docker-compose.yml
docker --version
docker compose version
```

需要 Docker Engine、Docker Compose v2、可用的 Tailscale 客户端和一个已启用 HTTPS 证书的 Tailnet。不要把这个项目放到现有 SillyTavern 的 Docker 目录中，也不要让两个进程共享任何 Vectra、BM25、会话或设置文件。

## 首次部署

1. 创建只供服务器使用的环境文件和数据目录：

```bash
cd /srv/anima-remote
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
mkdir -p deploy/data deploy/backups
chmod 700 deploy/data deploy/backups
```

编辑 `deploy/.env`：

```dotenv
ANIMA_BIND_IP=127.0.0.1
ANIMA_PORT=18000
ANIMA_UID=1000
ANIMA_GID=1000
ANIMA_CORS_ORIGINS=null,tauri://localhost,https://tauri.localhost
ANIMA_OUTBOUND_ALLOWLIST=provider.example
ANIMA_OUTBOUND_ALLOW_HTTP=false
ANIMA_OUTBOUND_ALLOW_PRIVATE=false
```

用 `id -u`、`id -g` 的输出填写 `ANIMA_UID`、`ANIMA_GID`，使容器能写入 `deploy/data`。把 `provider.example` 替换为实际使用的 Embedding、Rerank、总结等服务的精确主机名；不要用 `*`，不要把 API key 写进该文件。空白名单会拒绝全部提供商出站。`ANIMA_CORS_ORIGINS` 也只保留实际 WebView 发送的 Origin；CORS 不是认证机制。

如果必须调用同一服务器上已有的私网提供商（例如精确地址 `100.96.176.24:8050`），需要同时把该精确主机加入白名单，并显式启用 HTTP/私网出站。此模式只能使用精确主机，不能配 `*` 或通配子域；先确认服务仍只在 Tailnet 内：

```dotenv
ANIMA_OUTBOUND_ALLOWLIST=100.96.176.24
ANIMA_OUTBOUND_ALLOW_HTTP=true
ANIMA_OUTBOUND_ALLOW_PRIVATE=true
```

这是对默认安全策略的有意放宽。使用 SiliconFlow、OpenRouter 等公网 HTTPS 提供商时应保持两个开关为 `false`。

2. 先做静态配置和启动门禁检查：

```bash
cd /srv/anima-remote
docker compose --project-directory . --env-file deploy/.env -f deploy/docker-compose.yml config
test -f server/standalone.js
```

`docker compose config` 成功只代表 Compose 模型有效，不代表服务器入口已经存在；第二个 `test` 失败时不要继续启动。

3. 构建并启动：

```bash
cd /srv/anima-remote
docker compose --project-directory . --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
docker compose --project-directory . --env-file deploy/.env -f deploy/docker-compose.yml ps
docker compose --project-directory . --env-file deploy/.env -f deploy/docker-compose.yml logs --tail=200 anima-remote
curl --fail --silent --show-error http://127.0.0.1:18000/healthz
```

预期是容器 `healthy`，本机健康检查返回 JSON 且包含 `"ok":true`。这条回环 HTTP 只用于服务器自身验证，不能填进手机端。

## Tailscale Serve HTTPS MagicDNS

先查看这台机器已有的 Serve 配置，避免覆盖同一台机器上别的根路径服务：

```bash
sudo tailscale serve status
```

确认根路径可用于 Anima 后，在服务器执行：

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:18000
tailscale serve status
```

命令输出中的 `https://<machine-name>.<tailnet>.ts.net` 就是客户端地址。若 Tailnet 尚未允许 HTTPS 证书，Tailscale 会给出授权链接；完成授权后重新执行 Serve 命令。Serve 只把本机回环 HTTP 反向代理成 Tailnet 内 HTTPS，不需要把 Docker 端口改绑到公网。

验证时使用输出中的占位主机名替换下面的值：

```bash
curl --fail --silent --show-error https://<machine-name>.<tailnet>.ts.net/healthz
curl --include https://<machine-name>.<tailnet>.ts.net/v1/me
```

第二条在没有令牌时应返回 `401`；这证明认证门存在，不是故障。带令牌的验证只在服务器终端临时使用，不要把令牌粘进脚本、Shell 历史、日志或截图：

```bash
curl --fail --silent --show-error \
  -H 'Authorization: Bearer <one-time-copied-user-token>' \
  https://<machine-name>.<tailnet>.ts.net/v1/me
```

Tailscale 1.52+ 的推荐命令形态是 `sudo tailscale serve --bg --https=443 http://127.0.0.1:<port>`；不同客户端版本的参数可能不同，始终以 `tailscale serve --help` 为准，并用 `tailscale serve status` 核验最终配置。Serve 需要在 Tailnet 中启用 HTTPS 证书。

## Android release 约束

TauriTavern Android release 禁止 cleartext HTTP。手机端的 Anima 服务器地址必须是：

```text
https://<machine-name>.<tailnet>.ts.net
```

以下地址只允许用于服务器本机诊断，不能作为正式手机地址：

```text
http://127.0.0.1:18000
http://<tailscale-ip>:18000
```

手机和朋友的设备都必须先加入同一个 Tailnet，并能解析该 MagicDNS 主机名。不要为了绕过证书问题打开 Android cleartext，也不要把 18000 端口暴露到 `0.0.0.0`。

## 每个人独立令牌

令牌文件只保存 scrypt 哈希；创建时输出的原始令牌只出现一次。服务器目录内执行：

```bash
cd /srv/anima-remote
./deploy/anima.sh token-create owner-phone
./deploy/anima.sh token-list
```

把 `token-create` 输出的 token 通过密码管理器交给对应的人，不能贴在群聊、仓库或截图中。朋友使用另一个标签创建另一个 token：

```bash
./deploy/anima.sh token-create friend-one
```

撤销时优先使用创建时返回的不可变 ID：

```bash
./deploy/anima.sh token-revoke-id <token-id-from-token-list>
./deploy/anima.sh token-list
```

同一个 token 代表同一个用户租户。不要把 owner token 复制给朋友；相同角色名、聊天名和 collection ID 在不同 token 下仍然应落在不同的向量、BM25、会话和设置命名空间。

## Tailnet grants 示例

新部署优先使用 Tailscale grants。下面示例只允许指定 Tailnet 用户组访问标记为 `tag:anima-server` 的服务器 443 端口；需由 Tailnet 管理员把占位登录名替换为实际身份，并在管理控制台校验语法：

```json
{
  "grants": [
    {
      "src": ["group:anima-users"],
      "dst": ["tag:anima-server"],
      "ip": ["tcp:443"]
    }
  ],
  "groups": {
    "group:anima-users": [
      "owner@example.invalid",
      "friend-one@example.invalid"
    ]
  },
  "tagOwners": {
    "tag:anima-server": ["autogroup:admin"]
  }
}
```

若管理控制台要求旧 ACL 格式，再按控制台提示转换；不要同时盲目粘贴两套规则。ACL/grants 只控制设备/用户到服务端口的网络可达性，不能替代 Anima bearer token。朋友离开 Tailnet 时先移除 grants 成员，再撤销其 Anima token；两步都做。

## 升级

升级前先执行一次备份并确认健康检查。源码升级采用可回滚的 Git 提交或标签：

```bash
cd /srv/anima-remote
./deploy/anima.sh backup
git pull --ff-only
docker compose --project-directory . --env-file deploy/.env -f deploy/docker-compose.yml config
test -f server/standalone.js
docker compose --project-directory . --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
docker compose --project-directory . --env-file deploy/.env -f deploy/docker-compose.yml ps
curl --fail --silent --show-error http://127.0.0.1:18000/healthz
```

不要执行 `docker compose down -v`，不要删除 `deploy/data`。升级后如果健康检查失败，按 [OPERATIONS.md](OPERATIONS.md) 的回滚流程处理。
