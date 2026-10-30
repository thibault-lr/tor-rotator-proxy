FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends tor ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o debian-tor -g debian-tor /var/lib/tor
COPY deploy/torrc /etc/tor/torrc
COPY LICENSE /usr/share/doc/tor-rotator/LICENSE
USER debian-tor
EXPOSE 9050
STOPSIGNAL SIGTERM
ENTRYPOINT ["tor", "-f", "/etc/tor/torrc"]
