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

COPY package*.json ./
COPY tsconfig.json ./
RUN npm install

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# 安装Playwright Chromium
RUN npx playwright install chromium

ENV WORKER_PORT=3003
ENV SERVER_URL=http://jlyl-cloud-server:3002

EXPOSE 3003

CMD ["node", "dist/index.js"]
