FROM oven/bun:1.4.4-alpine AS build

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/core/package.json packages/core/package.json
COPY apps/bun-runtime/package.json apps/bun-runtime/package.json
COPY apps/cloudflare-runtime/package.json apps/cloudflare-runtime/package.json
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build:bun

FROM oven/bun:1.4.4-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATABASE_PATH=/data/aihat.sqlite

RUN addgroup -S -g 10001 aihat \
  && adduser -S -D -u 10001 -G aihat aihat \
  && mkdir -p /data \
  && chown aihat:aihat /data

COPY --from=build --chown=aihat:aihat /app/dist ./dist
COPY --from=build --chown=aihat:aihat /app/migrations ./migrations

USER aihat
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["bun", "dist/apps/bun-runtime/src/index.js"]
