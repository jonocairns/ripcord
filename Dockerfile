FROM oven/bun:1.3.5 AS build

WORKDIR /app

COPY . .

RUN bun install --frozen-lockfile
RUN cd apps/server && bun run build

FROM oven/bun:1.3.5

ARG TARGETARCH
ENV RUNNING_IN_DOCKER=true
ENV SHARKORD_TRUST_PROXY=true

COPY --from=build /app/apps/server/build/out/sharkord-linux-x64 /tmp/sharkord-linux-x64
COPY --from=build /app/apps/server/build/out/sharkord-linux-arm64 /tmp/sharkord-linux-arm64

RUN set -eux; \
    case "$TARGETARCH" in \
      amd64)  cp /tmp/sharkord-linux-x64 /usr/local/bin/sharkord ;; \
      arm64)  cp /tmp/sharkord-linux-arm64 /usr/local/bin/sharkord ;; \
      *) echo "Unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    chmod +x /usr/local/bin/sharkord; \
    rm -rf /tmp/sharkord-linux-*

ENTRYPOINT ["/usr/local/bin/sharkord"]
