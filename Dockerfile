# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
RUN --mount=type=cache,target=/root/.yarn/berry/cache yarn install --immutable

FROM dependencies AS check
COPY tsconfig.json .oxlintrc.json .oxfmtrc.json ./
COPY src ./src
COPY tests ./tests
COPY script ./script
RUN --network=none yarn check

FROM dependencies AS production-dependencies
RUN --network=none --mount=type=cache,target=/root/.yarn/berry/cache yarn workspaces focus --production

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER 10001:10001
EXPOSE 5566
STOPSIGNAL SIGTERM
CMD ["node", "src/main.ts"]
