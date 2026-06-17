# jlyl-cloud 部署文档

## 聚量引力RaaS 云端服务

本项目是 GEO报告页面的云端版本，独立部署在云服务器上，7×24 小时运行。

> 部署触发时间：2026-06-18

## 架构

```
用户浏览器
    ↓
Nginx (80/443) - report.jlyl.net.cn
    ↓
Docker Compose
    ├── Web (Next.js) :3001 - GEO报告前端
    ├── Server (Express) :3002 - API服务
    └── PostgreSQL :5432 - 数据库（限制512M内存）
```

## 首次部署步骤

### 1. 服务器初始化（在服务器上执行）

```bash
# 创建项目目录
mkdir -p /opt/jlyl-cloud
cd /opt/jlyl-cloud

# 初始化 git
git init
git remote add origin https://github.com/Vasvons/jlyl-raas-cloud.git

# 创建 .env 文件
cat > .env << 'EOF'
DB_PASSWORD=你的数据库密码
JWT_SECRET=你的JWT密钥_建议使用随机字符串
ADMIN_PASSWORD=你的管理员密码
EOF

# 拉取代码
git pull origin main
```

### 2. 配置 GitHub Secrets

在 GitHub 仓库 `Vasvons/jlyl-raas-cloud` 的 Settings → Secrets and variables → Actions 中添加：

| Secret 名称 | 值 | 说明 |
|---|---|---|
| `SSH_PRIVATE_KEY` | 你的 SSH 私钥 | 用于 GitHub Actions 连接服务器 |
| `SERVER_HOST` | `47.108.200.21` | 服务器 IP |
| `SERVER_USER` | `root` | SSH 用户名 |
| `DB_PASSWORD` | 你的数据库密码 | 与 .env 中一致 |
| `JWT_SECRET` | 你的JWT密钥 | 与 .env 中一致 |
| `ADMIN_PASSWORD` | 你的管理员密码 | 与 .env 中一致 |

### 3. 配置域名 DNS

在你的域名管理后台（jlyl.net.cn）添加 DNS 解析：

| 记录类型 | 主机记录 | 记录值 |
|---|---|---|
| A | report | 47.108.200.21 |

等待 DNS 生效（通常几分钟到几小时）。

### 4. 配置 Nginx

```bash
# 复制 Nginx 配置
cp /opt/jlyl-cloud/docker/nginx.conf /etc/nginx/conf.d/jlyl-cloud.conf

# 测试配置
nginx -t

# 重载 Nginx
nginx -s reload
```

### 5. 推送代码触发部署

```bash
# 在本地推送代码到 GitHub
git push origin main

# GitHub Actions 会自动：
# 1. SSH 连接服务器
# 2. 拉取最新代码
# 3. 构建 Docker 镜像
# 4. 启动/更新服务
```

### 6. 验证部署

```bash
# 检查服务状态
cd /opt/jlyl-cloud
docker-compose ps

# 检查健康状态
curl http://localhost:3002/health

# 访问前端
curl http://localhost:3001
```

访问 `http://report.jlyl.net.cn` 应该能看到登录页面。

默认管理员账号：
- 用户名：`admin`
- 密码：你在 .env 中设置的 `ADMIN_PASSWORD`

## 日常维护

### 查看日志

```bash
# 查看所有服务日志
docker-compose logs -f

# 查看特定服务日志
docker-compose logs -f server
docker-compose logs -f web
docker-compose logs -f db
```

### 重启服务

```bash
cd /opt/jlyl-cloud
docker-compose restart
```

### 更新代码

```bash
# 推送代码到 GitHub 后，GitHub Actions 会自动部署
# 也可以手动在服务器上执行：
cd /opt/jlyl-cloud
git pull origin main
docker-compose up -d --build
```

### 备份数据库

```bash
# 手动备份
docker exec jlyl-cloud-db pg_dump -U jlyl jlyl_cloud > backup_$(date +%Y%m%d).sql

# 自动备份（添加到 crontab）
# 每天凌晨3点备份
0 3 * * * docker exec jlyl-cloud-db pg_dump -U jlyl jlyl_cloud > /opt/backups/jlyl_cloud_$(date +\%Y\%m\%d).sql
```

### 恢复数据库

```bash
docker exec -i jlyl-cloud-db psql -U jlyl jlyl_cloud < backup_20260618.sql
```

## 端口说明

| 端口 | 服务 | 访问方式 |
|---|---|---|
| 80 | Nginx | 公网访问 |
| 443 | Nginx (HTTPS) | 公网访问 |
| 3001 | Web 前端 | 仅本地访问（通过 Nginx 代理） |
| 3002 | API 服务 | 仅本地访问（通过 Nginx 代理） |
| 5432 | PostgreSQL | 仅本地访问 |

## 资源限制

| 服务 | 内存限制 | 说明 |
|---|---|---|
| PostgreSQL | 512M | 配置参数优化 |
| Server (API) | 512M | Node.js 服务 |
| Web (前端) | 256M | Next.js 服务 |
| **总计** | **~1.3G** | 服务器4G内存够用 |

## 故障排查

### 服务无法启动

```bash
# 查看错误日志
docker-compose logs server
docker-compose logs db

# 检查端口占用
netstat -tlnp | grep -E '3001|3002|5432'
```

### 数据库连接失败

```bash
# 检查数据库状态
docker-compose ps db
docker exec jlyl-cloud-db pg_isready -U jlyl

# 检查数据库日志
docker-compose logs db
```

### Nginx 502 错误

```bash
# 检查后端服务是否运行
docker-compose ps
curl http://localhost:3002/health
curl http://localhost:3001

# 重启服务
docker-compose restart
```

## 升级服务器配置

当数据量超过 5000万条时，建议：

1. 升级服务器到 4核8G
2. 修改 docker-compose.yml 移除 `mem_limit` 限制
3. 调整 PostgreSQL 参数：
   ```
   shared_buffers=1GB
   effective_cache_size=2GB
   work_mem=16MB
   ```
