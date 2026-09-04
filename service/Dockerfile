# File Server Dockerfile
FROM oven/bun:1.3.14 AS base
WORKDIR /app

# Install dependencies
FROM base AS install
RUN mkdir -p /temp/dev
COPY service/package.json service/bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

RUN mkdir -p /temp/prod
COPY service/package.json service/bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# Build all entry points
FROM base AS builder
COPY --from=install /temp/dev/node_modules node_modules
COPY service/src ./src
COPY service/scripts ./scripts
COPY shared /shared
COPY service/tsconfig.json ./
RUN bun build ./src/file-server.ts --minify --outdir .build --target bun --external '@opentelemetry/*'
RUN bun build ./src/api-server.ts --minify --outdir .build-api --target bun --external '@opentelemetry/*'
RUN bun build ./scripts/rehydrate-session-cache.ts --minify --outdir .build-migrations --target bun --external '@opentelemetry/*'
RUN bun build ./src/worker-server.ts --minify --outdir .build-worker --target bun --external '@opentelemetry/*'
RUN bun build ./src/egress-gateway.ts --minify --outdir .build-egress-gateway --target bun --external '@opentelemetry/*'

FROM oven/bun:1.3.14 AS production-base
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/*

# File server production
FROM production-base AS production
ENV NODE_ENV=production
WORKDIR /app
COPY --from=install /temp/prod/node_modules ./node_modules
COPY --from=builder /app/.build ./.build
CMD ["bun", "run", ".build/file-server.js"]

# API server (HTTP on port 3112)
FROM production-base AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=install /temp/prod/node_modules ./node_modules
COPY --from=builder /app/.build-api ./.build-api
COPY --from=builder /app/.build-migrations ./.build-migrations
COPY --from=builder /app/src/*.py ./src/
CMD ["bun", "run", ".build-api/api-server.js"]

# Worker server (job processor, health on port 3113)
FROM production-base AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=install /temp/prod/node_modules ./node_modules
COPY --from=builder /app/.build-worker ./.build-worker
COPY --from=builder /app/src/*.py ./src/
CMD ["bun", "run", ".build-worker/worker-server.js"]

# Egress gateway (sandbox outbound delegation)
FROM production-base AS egress-gateway
ENV NODE_ENV=production
WORKDIR /app
COPY --from=install /temp/prod/node_modules ./node_modules
COPY --from=builder /app/.build-egress-gateway ./.build-egress-gateway
CMD ["bun", "run", ".build-egress-gateway/egress-gateway.js"]

# Development stage  
FROM base AS development
ENV NODE_ENV=development
COPY --from=install /temp/dev/node_modules node_modules
COPY service/src ./src
COPY shared /shared
COPY service/tsconfig.json ./
EXPOSE 3000 9230
CMD ["bun", "run", "--watch", "src/file-server.ts"]
