# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
RUN --mount=type=cache,target=/root/.yarn/berry/cache yarn install --immutable

FROM dependencies AS check
COPY tsconfig.json tsconfig.build.json .oxlintrc.json .oxfmtrc.json ./
COPY src ./src
COPY tests ./tests
COPY script ./script
COPY deploy ./deploy
RUN --network=none yarn check

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN --network=none yarn build

FROM dependencies AS production-dependencies
RUN --network=none --mount=type=cache,target=/root/.yarn/berry/cache yarn workspaces focus --production

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends tor ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o debian-tor -g debian-tor /var/lib/tor
WORKDIR /app
ENV NODE_ENV=production \
    PROXY_BIND=0.0.0.0:5566 \
    TOR_SOCKS_ADDRS=127.0.0.1:9050
LABEL org.opencontainers.image.licenses="MIT"
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY --from=build /app/dist ./dist
COPY deploy/torrc /etc/tor/torrc
COPY --chmod=755 deploy/start.sh /usr/local/bin/start-proxy
USER debian-tor
VOLUME ["/var/lib/tor"]
EXPOSE 5566
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start-proxy"]
