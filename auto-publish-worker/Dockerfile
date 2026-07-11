FROM node:18-alpine

# 设置时区为 Asia/Shanghai
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apk del tzdata

ENV TZ=Asia/Shanghai

# 安装 Chromium 及 Playwright 运行所需依赖
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

# 设置 npm 国内镜像源
RUN npm config set registry https://registry.npmmirror.com

COPY package*.json ./
COPY tsconfig.json ./
RUN npm install --no-cache

# 验证 Playwright 版本
RUN npx playwright --version

COPY . .
RUN npm run build
RUN npm prune --omit=dev

ENV SERVER_URL=http://jlyl-cloud-server:3002
ENV POLL_INTERVAL=30000
ENV WORKER_PORT=3004

CMD ["node", "dist/index.js"]
