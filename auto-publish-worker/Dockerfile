FROM node:18-alpine

# v2.5.20：替换为阿里云 Alpine 镜像源（原 dl-cdn.alpinelinux.org 在服务器上被拒访问）
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories

# 设置时区为 Asia/Shanghai
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apk del tzdata

ENV TZ=Asia/Shanghai

# 安装 Chromium 及 Playwright 运行所需依赖
# v3.13.17：新增 mesa 软件渲染栈——GPU 进程 EGL 初始化此前必败退出（无显卡且无
#   SwiftShader），与 wxgzh loginpage renderer 崩溃时刻精确重合（<100ms，多轮实锤）。
#   mesa-dri-gallium-drivers 提供 swrast/llvmpipe 软件光栅化驱动，配合 surfaceless
#   平台让 EGL 真正初始化成功 → GPU 进程存活 → 崩溃链从根上消除
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    mesa-dri-gallium-drivers \
    mesa-egl \
    mesa-gles \
    mesa-gbm

# v3.13.17：无显示环境下 EGL 走 surfaceless 平台（headless 标准姿势）
ENV EGL_PLATFORM=surfaceless

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
