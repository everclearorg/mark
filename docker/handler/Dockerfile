FROM node:20 AS base

# ----------------------------------------
# Build stage
# ----------------------------------------

FROM base AS build
RUN apt-get update && apt-get install -y git python3 python3-pip make gcc g++ python3-dev

# Install node-gyp globally
RUN npm install --global node-gyp

# Enable corepack to use Yarn 3
RUN corepack enable

ENV HOME=/tmp/build \
    PATH=/tmp/build/node_modules/.bin:./node_modules/.bin:${PATH} \
    PYTHON=/usr/bin/python3 \
    NODE_ENV=development \
    NODE_OPTIONS="--max-old-space-size=4096" \
    YARN_ENABLE_IMMUTABLE_INSTALLS=false \
    YARN_ENABLE_SCRIPTS=true \
    YARN_CACHE_FOLDER=/tmp/yarn-cache \
    SKIP_OPTIONAL_DEPENDENCIES=true \
    BUFFERUTIL_SKIP_INSTALL=true \
    UTF_8_VALIDATE_SKIP_INSTALL=true

WORKDIR /tmp/build

# Copy yarn configuration files first (including Yarn 3 binary)
COPY .yarn /tmp/build/.yarn/
COPY .yarnrc.yml /tmp/build/
COPY package.json /tmp/build/

# Copy all package.json files
COPY packages/core/package.json /tmp/build/packages/core/
COPY packages/agent/package.json /tmp/build/packages/agent/
COPY packages/handler/package.json /tmp/build/packages/handler/
COPY packages/poller/package.json /tmp/build/packages/poller/
COPY packages/admin/package.json /tmp/build/packages/admin/
COPY packages/adapters/rebalance/package.json /tmp/build/packages/adapters/rebalance/
COPY packages/adapters/logger/package.json /tmp/build/packages/adapters/logger/
COPY packages/adapters/chainservice/package.json /tmp/build/packages/adapters/chainservice/
COPY packages/adapters/everclear/package.json /tmp/build/packages/adapters/everclear/
COPY packages/adapters/web3signer/package.json /tmp/build/packages/adapters/web3signer/
COPY packages/adapters/cache/package.json /tmp/build/packages/adapters/cache/
COPY packages/adapters/prometheus/package.json /tmp/build/packages/adapters/prometheus/
COPY packages/adapters/database/package.json /tmp/build/packages/adapters/database/
COPY packages/adapters/webhooks/package.json /tmp/build/packages/adapters/webhooks/
COPY yarn.lock /tmp/build/

# Install dependencies including devDependencies
# Note: --mode=skip-build skips preinstall/postinstall scripts during install
# This avoids the "npx only-allow pnpm" check in @eth-optimism/core-utils
# Then we run rebuild to build native modules with our build tools
RUN yarn install --immutable --mode=skip-build && \
    yarn workspaces foreach -A run rebuild

# Copy source files
COPY packages/core /tmp/build/packages/core
COPY packages/agent /tmp/build/packages/agent
COPY packages/handler /tmp/build/packages/handler
COPY packages/poller /tmp/build/packages/poller
COPY packages/admin /tmp/build/packages/admin
COPY packages/adapters/rebalance /tmp/build/packages/adapters/rebalance
COPY packages/adapters/logger /tmp/build/packages/adapters/logger
COPY packages/adapters/chainservice /tmp/build/packages/adapters/chainservice
COPY packages/adapters/everclear /tmp/build/packages/adapters/everclear
COPY packages/adapters/web3signer /tmp/build/packages/adapters/web3signer
COPY packages/adapters/cache /tmp/build/packages/adapters/cache
COPY packages/adapters/prometheus /tmp/build/packages/adapters/prometheus
COPY packages/adapters/database /tmp/build/packages/adapters/database
COPY packages/adapters/webhooks /tmp/build/packages/adapters/webhooks
COPY tsconfig.json /tmp/build/

# Build packages
# Build core first to ensure declaration files are available
RUN yarn workspace @mark/core build && \
    yarn build

# ----------------------------------------
# Runtime stage
# ----------------------------------------

FROM base AS runtime

# Install dbmate for database migrations
# Pin to specific version and verify SHA256 checksum for supply chain security
ARG DBMATE_VERSION=v2.29.3
ARG DBMATE_SHA256=2bb1554a32d9c0bd544841d3523eae64fd60a58d7720c5d82900043dc5e87a6c
RUN set -eux; \
    curl -fsSL -o /tmp/dbmate \
        https://github.com/amacneil/dbmate/releases/download/${DBMATE_VERSION}/dbmate-linux-amd64; \
    echo "${DBMATE_SHA256}  /tmp/dbmate" | sha256sum -c -; \
    mv /tmp/dbmate /usr/local/bin/dbmate; \
    chmod +x /usr/local/bin/dbmate

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Copy only the necessary files from build
COPY --from=build /tmp/build/node_modules /app/node_modules
COPY --from=build /tmp/build/packages/handler/dist/. /app/
COPY --from=build /tmp/build/packages/core/dist /app/packages/core/dist
COPY --from=build /tmp/build/packages/agent/dist /app/packages/agent/dist
COPY --from=build /tmp/build/packages/poller/dist /app/packages/poller/dist
COPY --from=build /tmp/build/packages/adapters/rebalance/dist /app/packages/adapters/rebalance/dist
COPY --from=build /tmp/build/packages/adapters/logger/dist /app/packages/adapters/logger/dist
COPY --from=build /tmp/build/packages/adapters/chainservice/dist /app/packages/adapters/chainservice/dist
COPY --from=build /tmp/build/packages/adapters/everclear/dist /app/packages/adapters/everclear/dist
COPY --from=build /tmp/build/packages/adapters/prometheus/dist /app/packages/adapters/prometheus/dist
COPY --from=build /tmp/build/packages/adapters/web3signer/dist /app/packages/adapters/web3signer/dist
COPY --from=build /tmp/build/packages/adapters/cache/dist /app/packages/adapters/cache/dist
COPY --from=build /tmp/build/packages/adapters/database/dist /app/packages/adapters/database/dist
COPY --from=build /tmp/build/packages/adapters/webhooks/dist /app/packages/adapters/webhooks/dist

# Copy database migrations from build stage
COPY --from=build /tmp/build/packages/adapters/database/db /app/db

# Create symlinks for workspace dependencies
RUN cd /app/node_modules/@mark && \
    rm -rf core logger chainservice everclear prometheus web3signer cache rebalance database agent poller webhooks && \
    ln -s ../../packages/core/dist core && \
    ln -s ../../packages/adapters/logger/dist logger && \
    ln -s ../../packages/adapters/rebalance/dist rebalance && \
    ln -s ../../packages/adapters/chainservice/dist chainservice && \
    ln -s ../../packages/adapters/everclear/dist everclear && \
    ln -s ../../packages/adapters/prometheus/dist prometheus && \
    ln -s ../../packages/adapters/web3signer/dist web3signer && \
    ln -s ../../packages/adapters/cache/dist cache && \
    ln -s ../../packages/adapters/database/dist database && \
    ln -s ../../packages/agent/dist agent && \
    ln -s ../../packages/poller/dist poller && \
    ln -s ../../packages/adapters/webhooks/dist webhooks

EXPOSE 3000

# Start the handler server
CMD ["node", "index.js"]
