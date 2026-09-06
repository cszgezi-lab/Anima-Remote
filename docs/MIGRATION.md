# 现有 SillyTavern Anima 数据迁移

## 当前结论：暂不迁移

服务器现有目录 `/home/ubuntu/SillyTavern/docker/plugins/anima-rag` 属于正在运行的 SillyTavern 插件。它不是 Anima Remote 的独立租户数据目录。当前迁移方案要求一个明确的、经过测试的迁移 CLI，能够把旧的向量、BM25、会话和设置映射到指定用户租户；本次施工检查中没有 `server/migrate.js` 或 `server/bin/anima-migrate.js`，所以必须停在“暂不迁移”。

本项目不把 `cp -a`、`rsync`、手工改 collection 名称或直接绑定旧插件目录称为迁移。不要把旧目录挂载到 `deploy/data`，不要在旧插件和 Remote 两个进程都运行时写同一批文件。

## 只读安全核实

下面命令只检查来源，不复制、不删除、不修改现有 SillyTavern：

```bash
cd /srv/anima-remote
ST_DOCKER_DIR=/home/<server-user>/SillyTavern/docker
./deploy/anima.sh migration-check "$ST_DOCKER_DIR"
test -f server/migrate.js || test -f server/bin/anima-migrate.js
```

第二条失败时，结论就是“暂不迁移”。此时安全的下一步只有：备份旧插件目录、记录文件清单和磁盘空间、继续使用原 SillyTavern 插件，等待迁移 CLI 与双用户/回滚测试完成。不要为了让新容器启动而删除旧插件或修改现有 Compose。

## 未来迁移必须满足的顺序

只有在迁移 CLI 已存在并且它的文档明确写出 source、target、tenant、`--dry-run` 和校验结果时，才可以考虑下面流程。这里的命令结构是门禁清单，不是对当前 checkout 中不存在的 CLI 的假装调用。

### 1. 通知并停写

先通知使用者进入维护窗口；停止旧 SillyTavern，使旧 Anima 不再写向量、BM25 或会话。迁移期间新 Remote 也必须停止写入：

```bash
ST_DOCKER_DIR=/home/<server-user>/SillyTavern/docker
sudo docker compose -f "$ST_DOCKER_DIR/docker-compose.yml" stop sillytavern
cd /srv/anima-remote
./deploy/anima.sh down
```

记录 `docker compose ps` 和新服务状态，确认没有任何第二个进程持有旧文件。只要无法证明停写，就不能继续。

### 2. 备份旧源并校验

备份必须覆盖旧插件目录及其下的 `vectors`、`data)、BM25 和配置性文件；备份文件放在源目录之外，权限设为仅管理员可读：

```bash
ST_DOCKER_DIR=/home/<server-user>/SillyTavern/docker
SOURCE="$ST_DOCKER_DIR/plugins/anima-rag"
BACKUP_DIR=/srv/anima-backups
sudo install -d -m 700 "$BACKUP_DIR"
sudo tar --xattrs --acls -czf "$BACKUP_DIR/anima-rag-source-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" \
  -C "$ST_DOCKER_DIR/plugins" anima-rag
sudo sha256sum "$BACKUP_DIR"/anima-rag-source-*.tar.gz
sudo find "$SOURCE" -maxdepth 2 -type f -printf '%P\n' | sort | head -n 200
```

把实际生成的归档文件名和 SHA-256 写入维护记录；不要把归档上传到聊天或公共仓库。若备份失败，先恢复旧服务，不能继续迁移。

### 3. 只做 dry-run

先查看迁移 CLI 的帮助和版本，确认它不会写入 source 或 target：

```bash
cd /srv/anima-remote
docker compose --project-directory . --env-file deploy/.env -f deploy/docker-compose.yml \
  run --rm --no-deps --no-ports anima-remote node /app/server/migrate.js --help
```

只有帮助中明确存在 dry-run 参数时，才按该 CLI 的实际文档执行；示例形式如下，`<documented-options>` 必须替换为真实参数，不能照抄：

```bash
docker compose --project-directory . --env-file deploy/.env -f deploy/docker-compose.yml \
  run --rm --no-deps --no-ports \
  -v "$SOURCE:/mnt/anima-rag-source:ro" \
  anima-remote node /app/server/migrate.js \
  --source /mnt/anima-rag-source --target /var/lib/anima \
  --tenant <owner-tenant-id> --dry-run <documented-options>
```

dry-run 必须只读挂载 source，报告待处理 collection、BM25 库、会话、设置、冲突、预计空间和目标租户；它不能创建或删除目标文件。报告中任一跨租户或未映射对象都应中止。

### 4. 正式导入与验证

dry-run 通过后仍需再次确认备份 SHA-256、旧容器停写、Remote 停写、目标目录为空且与旧目录不同。正式导入只能写 `deploy/data`，不能写 `/home/ubuntu/SillyTavern/docker/plugins/anima-rag`。

导入后使用一个专用 owner token 做小范围验证：同一 collection 的数量、时间戳、标签、BM25 查询、会话和设置版本逐项对照；再用第二个 token 验证看不到 owner 的数据。验证未完成前，不得把旧服务切回双写状态。

## 回滚

迁移后的 Remote 有任何数据或隔离问题：

```bash
cd /srv/anima-remote
./deploy/anima.sh down
```

不要删除新 `deploy/data`，先将它完整保留为问题证据。恢复旧服务前确认旧源归档可读、旧目录没有被新服务挂载，然后启动原 SillyTavern：

```bash
ST_DOCKER_DIR=/home/<server-user>/SillyTavern/docker
sudo docker compose -f "$ST_DOCKER_DIR/docker-compose.yml" up -d sillytavern
sudo docker compose -f "$ST_DOCKER_DIR/docker-compose.yml" ps
```

如果旧目录已被人为改动，必须先在维护窗口内把它移到一个可恢复的备份名，再从已校验的源归档恢复；不要使用 `rm -rf`，不要在不确认目标路径的情况下递归删除。迁移 CLI 完成前，最安全的状态仍是旧插件单独运行，Remote 空数据单独验证。
