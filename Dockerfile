# syntax=docker/dockerfile:1

FROM node:26-slim AS base
RUN npm install --global pnpm@12.1.0
WORKDIR /app
COPY package.json pnpm-lock.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json config.schema.json ./
USER node
# Node is PID 1 here; the CLI installs its own SIGINT/SIGTERM handlers, so `docker stop`
# and Ctrl-C still shut it down gracefully.
ENTRYPOINT ["node", "dist/cli.js"]
