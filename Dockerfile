# One process: WhatsApp listener, Telegram bot, scheduler and pipeline. Data lives on /data.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Railway mounts the volume at /data; it is writable by root, so the process runs as root.
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/main.js"]
