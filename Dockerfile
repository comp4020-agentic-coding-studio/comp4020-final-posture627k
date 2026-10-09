# syntax = docker/dockerfile:1

# Runs the real app: a Node/Hono server, executed directly via Node's native
# TypeScript support (no build step). Must serve HTTP on 0.0.0.0:$PORT (PORT
# comes from fly.toml) and publish README.md at /readme/ (spec/README.md says
# what's checked).
FROM node:24.21.0-alpine

WORKDIR /app

# pnpm isn't bundled in the base image; install the version this repo pins.
RUN npm install --global pnpm@11.9.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY server.ts db.ts realtime.ts README.md ./
COPY poker ./poker
COPY card-clash ./card-clash

ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080

CMD ["node", "server.ts"]
