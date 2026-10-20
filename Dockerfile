# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS check
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
RUN --mount=type=cache,target=/root/.yarn/berry/cache yarn install --immutable
COPY tsconfig.json .oxlintrc.json .oxfmtrc.json ./
COPY src ./src
COPY tests ./tests
COPY script ./script
RUN --network=none yarn check
RUN --network=none --mount=type=cache,target=/root/.yarn/berry/cache yarn workspaces focus --production

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=check /app/node_modules ./node_modules
COPY --from=check /app/package.json ./package.json
COPY --from=check /app/src ./src
USER 10001:10001
EXPOSE 5566
STOPSIGNAL SIGTERM
CMD ["node", "src/main.ts"]
