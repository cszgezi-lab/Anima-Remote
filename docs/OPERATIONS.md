# Anima Remote 运维

所有命令都在项目目录执行；下面的 `/srv/anima-remote` 只是路径示例。Remote 的 `deploy/data` 必须独立于现有 SillyTavern 插件目录。

## 日常检查

```bash
cd /srv/anima-remote
./deploy/anima.sh status
./deploy/anima.sh health
./deploy/anima.sh logs --tail=200
sudo tailscale serve status
```

本机 `http://127.0.0.1:18000/healthz` 只用于服务器诊断；手机端必须使用 Tailscale Serve 输出的 HTTPS MagicDNS URL。无 token 访问 `/v1/me` 返回 `401` 是预期。

## 备份与恢复

备份会短暂停止 Remote 写入，完成后恢复原运行状态；归档包含 token 哈希、设置和记忆，必须按敏感数据保管：

```bash
cd /srv/anima-remote
./deploy/anima.sh backup
sha256sum deploy/backups/anima-*.tar.gz
```

恢复前确认 SHA-256；恢复会把当前数据移到可回退的时间戳目录：

```bash
./deploy/anima.sh restore deploy/backups/anima-<verified-archive>.tar.gz --confirm
./deploy/anima.sh status
./deploy/anima.sh health
```

不要执行 `docker compose down -v`，不要删除 `deploy/data`，不要把归档解到旧 SillyTavern 插件目录。

## 升级与回滚

```bash
cd /srv/anima-remote
./deploy/anima.sh backup
git pull --ff-only
docker compose --project-directory . --env-file deploy/.env -f deploy/docker-compose.yml config
test -f server/standalone.js
docker compose --project-directory . --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
./deploy/anima.sh status
./deploy/anima.sh health
```

新版本不健康时，保留日志和备份，切到已验证提交或标签后重建：

```bash
cd /srv/anima-remote
./deploy/anima.sh backup
git status --short
git switch --detach <known-good-commit-or-tag>
docker compose --project-directory . --env-file deploy/.env -f deploy/docker-compose.yml config
docker compose --project-directory . --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
./deploy/anima.sh health
```

有未提交修改时不要用 `git reset --hard` 覆盖；先由管理员保存并处理。源码回滚与数据恢复是两件事。

## 令牌与访问控制

```bash
cd /srv/anima-remote
./deploy/anima.sh token-list
./deploy/anima.sh token-create friend-two
./deploy/anima.sh token-revoke-id <id-from-token-list>
sudo tailscale serve status
```

`token-list` 不显示原文，`token-create` 只在创建时显示一次。每个人一个 token；离开 Tailnet 时同时移除 grants 成员并撤销 token。

改 Serve 前先看现有配置；确认不会覆盖其他服务后才执行：

```bash
sudo tailscale serve --help
sudo tailscale serve --bg --https=443 http://127.0.0.1:18000
sudo tailscale serve status
```

Tailscale 1.52+ 推荐该形态，但不同版本以 `tailscale serve --help` 为准。不要使用 `tailscale funnel` 公开服务，除非另有安全评审。

## 故障边界

- 容器不健康：先看 `logs`，确认 `server/standalone.js` 和数据目录权限；不要把旧插件入口接入。
- HTTPS 打不开：查 `tailscale serve status`、Tailnet HTTPS 证书和 grants；不要打开 Android cleartext。
- `401`：检查对应 token 是否复制错误或已撤销。
- `403`：检查 grants、CORS 和 provider allowlist；不要把私网出站策略改为允许来试错。
- 迁移/恢复/升级时：确认旧 SillyTavern 与 Remote 不会同时写同一 Vectra/BM25 文件。迁移门禁见 [MIGRATION.md](MIGRATION.md)。
