FROM node:18-alpine

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
RUN npm install

COPY . .
RUN npm run build
RUN npm prune --omit=dev

ENV SERVER_URL=http://jlyl-cloud-server:3002
ENV POLL_INTERVAL=2000

CMD ["node", "dist/index.js"]
