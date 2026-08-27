# xDNS · DNS 管理平台
# 多阶段构建：Stage 1 构建前端，Stage 2 仅生产依赖 + 构建产物
FROM node:22-alpine AS build

WORKDIR /app
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci

COPY web/ ./web/
RUN cd web && npm run build

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# 后端只有 express 一个依赖，锁文件保证可复现安装
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src/ ./src/
COPY --from=build /app/web/dist ./web/dist

# 数据目录（SQLite 数据库挂载点）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3090/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
