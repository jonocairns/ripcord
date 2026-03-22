FROM oven/bun:1.3.5 AS build

ARG SHARKORD_VERSION
ENV SHARKORD_VERSION=${SHARKORD_VERSION}

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json bun.lock ./
COPY apps/client/package.json apps/client/
COPY apps/desktop/package.json apps/desktop/
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/

RUN bun install --frozen-lockfile

# Now copy source — changes here don't bust the install cache
COPY . .

RUN cd apps/server && bun run build

FROM debian:bookworm-slim

ENV RUNNING_IN_DOCKER=true
ENV SHARKORD_TRUST_PROXY=true

COPY --from=build /app/apps/server/build/out/sharkord-linux-x64 /usr/local/bin/sharkord
RUN chmod +x /usr/local/bin/sharkord

ENTRYPOINT ["/usr/local/bin/sharkord"]
