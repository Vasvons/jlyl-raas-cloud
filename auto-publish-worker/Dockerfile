# v3.13.19：切换到 Playwright 官方 Docker 镜像（终结 Alpine 系统 chromium 系列问题）
#
#   背景：wxgzh loginpage 渲染进程静默崩溃（9-13s，低内存，无 OOM，多轮参数/软件渲染
#   方案均未根治）。Alpine chromium 是 musl libc 自编译版，与 Playwright 官方支持的
#   glibc 构建存在差异（V8/Blink 引擎行为、SwiftShader 缺失、GL 初始化失败拖崩 GPU
#   进程等）。官方镜像一次解决整类问题：
#     - Ubuntu 24.04 (noble) + glibc：Playwright 唯一官方支持的一线环境
#     - 预装与 playwright@1.61.0 精确匹配的 Chromium（/ms-playwright）
#     - 内置 SwiftShader：WebGL/Canvas 软件渲染可用，GPU 进程可正常初始化
#     - 预装全部浏览器依赖 + CJK 字体（wqy-zenhei 等，比 alpine 的 freefont 更好）
#     - Node 24 + git
#   注意：PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 已移除——publishExecutor 的
#   executablePath 走 env || undefined，不设则 Playwright 自动使用自带 Chromium
FROM mcr.microsoft.com/playwright:v1.61.0-noble

# 设置时区为 Asia/Shanghai（Ubuntu 基础镜像自带 tzdata）
ENV TZ=Asia/Shanghai

# 浏览器已在镜像内（/ms-playwright），跳过 npm 安装 playwright 时的浏览器下载
# （下载走国际 CDN，国内服务器慢且易失败；镜像内版本与 package.json 精确匹配）
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# 设置 npm 国内镜像源
RUN npm config set registry https://registry.npmmirror.com

COPY package*.json ./
COPY tsconfig.json ./
# 注：不用 --no-cache（非合法 npm 参数，旧版容忍、新版 npm 可能报错；镜像层内本无缓存）
RUN npm install

# 验证 Playwright 版本
RUN npx playwright --version

COPY . .
RUN npm run build
RUN npm prune --omit=dev

ENV SERVER_URL=http://jlyl-cloud-server:3002
ENV POLL_INTERVAL=30000
ENV WORKER_PORT=3004

CMD ["node", "dist/index.js"]
