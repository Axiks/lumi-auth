# syntax=docker.io/docker/dockerfile:1
# Standalone build — context = repo ROOT.
#   docker build -t lumi-auth .
#
# No build step — runs straight from TypeScript via tsx (mirrors apps/bot's pattern in the
# lumispace monorepo). No database of its own — a stateless proxy in front of Kratos
# (admin API), the Telegram Bot API, and S3.

FROM node:25-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --no-fund --omit=dev

FROM base AS runner
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs nodejs

COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs package.json ./
COPY --chown=nodejs:nodejs tsconfig.json ./
COPY --chown=nodejs:nodejs src ./src

# Internal REST + /health — Docker network only, never published to the host.
EXPOSE 8082

USER nodejs
CMD ["npx", "tsx", "src/main.ts"]
