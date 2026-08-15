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
# v3.13.18：修正 v3.13.17 的致命包名错误（mesa-dri-gallium-drivers 在 Alpine 3.21
#   不存在，实为 mesa-dri-gallium；apk 报错导致镜像 build 失败 → 部署中断 → 云端
#   全线停机）。修正后的最小正确方案：
#   - chromium-swiftshader（v3.21 官方子包，已确认存在）：正是 chrome 日志里
#     "eglInitialize SwANGLE failed with EGL_NOT_INITIALIZED" 缺失的 SwiftShader
#     软件渲染库 → ANGLE 默认后端顺序（Vulkan 失败 → SwANGLE）走到 SwANGLE 即成功
#     → GPU 进程存活 → loginpage renderer 不再被拖崩
#   - swrast/mesa-gbm 无需显式安装：chromium 本身依赖 mesa-dri-gallium + mesa-gbm，
#     apk 会自动带上
#   - mesa-egl/mesa-gles（原生 GL 冗余路径）用容错安装：包名如与 3.21 不符则跳过，
#     不影响 SwANGLE 主路径，且保证镜像 build 不再因包名问题失败
RUN apk add --no-cache \
    chromium \
    chromium-swiftshader \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont && \
    (apk add --no-cache mesa-egl mesa-gles || \
     echo "WARN: mesa-egl/mesa-gles 不可用，SwANGLE 主路径已由 chromium-swiftshader 覆盖")

# 无显示环境下 EGL 走 surfaceless 平台（headless 标准姿势，对 SwANGLE 无害）
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
