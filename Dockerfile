# Dela: сервер и веб-клиент в одном образе.
# docker run -d -p 8080:8080 -v dela-data:/data ghcr.io/olerast67/dela:latest

FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:web

FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:26-alpine
ENV NODE_ENV=production \
    DELA_DATA_DIR=/data \
    DELA_PORT=8080 \
    DELA_WEB_DIR=/app/apps/web/dist
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/core/src ./packages/core/src
COPY apps/server/src ./apps/server/src
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/src/main.ts"]
