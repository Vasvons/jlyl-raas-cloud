FROM node:20-slim

# 安装Chromium依赖
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 设置 npm 国内镜像源（避免 Docker 构建时访问 npmjs.org 超时）
RUN npm config set registry https://registry.npmmirror.com

COPY package*.json ./
COPY tsconfig.json ./
RUN npm install

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# 安装Playwright Chromium
RUN npx playwright install chromium

ENV SERVER_URL=http://jlyl-cloud-server:3002
ENV POLL_INTERVAL=2000

CMD ["node", "dist/index.js"]
