FROM node:18-alpine

# v2.5.20：替换为阿里云 Alpine 镜像源（原 dl-cdn.alpinelinux.org 在服务器上被拒访问）
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories

# 设置时区为 Asia/Shanghai
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apk del tzdata

ENV TZ=Asia/Shanghai

# 安装 Chromium 及 Playwright 运行所需依赖（alpine 的 chromium 包会自动拉取大部分依赖）
# 参考: https://playwright.dev/docs/browsers#google-chrome--microsoft-edge
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# 告知 Playwright 使用系统已安装的 Chromium，不再下载
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# 设置 npm 国内镜像源（避免 Docker 构建时访问 npmjs.org 超时）
RUN npm config set registry https://registry.npmmirror.com

COPY package*.json ./
COPY tsconfig.json ./
# 加 --no-cache 强制 npm 不使用本地缓存（避免 Docker 层缓存命中旧版本）
RUN npm install --no-cache

# 验证 Playwright 版本（构建日志可见，便于排查 headless: 'new' 不支持问题）
RUN npx playwright --version

COPY . .
RUN npm run build
RUN npm prune --omit=dev

ENV SERVER_URL=http://jlyl-cloud-server:3002
ENV POLL_INTERVAL=2000

CMD ["node", "dist/index.js"]
