FROM public.ecr.aws/lambda/nodejs:20 AS node

# ----------------------------------------
# Build stage
# ----------------------------------------

FROM node AS build
RUN dnf update -y
RUN dnf install -y git

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
COPY yarn.lock /tmp/build/

# Install dependencies including devDependencies
RUN yarn install --immutable && \
    yarn workspaces foreach -A run rebuild

# Copy source files
COPY packages/core /tmp/build/packages/core
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
COPY tsconfig.json /tmp/build/

# Build packages
# Build core first to ensure declaration files are available
RUN yarn workspace @mark/core build && \
    yarn build

# ----------------------------------------
# Runtime stage
# ----------------------------------------

FROM node AS runtime

# Install dbmate for database migrations
RUN curl -fsSL -o /usr/local/bin/dbmate https://github.com/amacneil/dbmate/releases/latest/download/dbmate-linux-amd64 && \
    chmod +x /usr/local/bin/dbmate

ENV NODE_ENV=production \
    PORT=8080

WORKDIR ${LAMBDA_TASK_ROOT}

# Copy only the necessary files from build
COPY --from=build /tmp/build/node_modules ${LAMBDA_TASK_ROOT}/node_modules
COPY --from=build /tmp/build/packages/poller/dist ${LAMBDA_TASK_ROOT}/
COPY --from=build /tmp/build/packages/core/dist ${LAMBDA_TASK_ROOT}/packages/core/dist
COPY --from=build /tmp/build/packages/adapters/rebalance/dist ${LAMBDA_TASK_ROOT}/packages/adapters/rebalance/dist
COPY --from=build /tmp/build/packages/adapters/logger/dist ${LAMBDA_TASK_ROOT}/packages/adapters/logger/dist
COPY --from=build /tmp/build/packages/adapters/chainservice/dist ${LAMBDA_TASK_ROOT}/packages/adapters/chainservice/dist
COPY --from=build /tmp/build/packages/adapters/everclear/dist ${LAMBDA_TASK_ROOT}/packages/adapters/everclear/dist
COPY --from=build /tmp/build/packages/adapters/prometheus/dist ${LAMBDA_TASK_ROOT}/packages/adapters/prometheus/dist
COPY --from=build /tmp/build/packages/adapters/web3signer/dist ${LAMBDA_TASK_ROOT}/packages/adapters/web3signer/dist
COPY --from=build /tmp/build/packages/adapters/cache/dist ${LAMBDA_TASK_ROOT}/packages/adapters/cache/dist
COPY --from=build /tmp/build/packages/adapters/database/dist ${LAMBDA_TASK_ROOT}/packages/adapters/database/dist

# Copy database migrations from build stage
COPY --from=build /tmp/build/packages/adapters/database/db ${LAMBDA_TASK_ROOT}/db

# Create symlinks for workspace dependencies
RUN cd ${LAMBDA_TASK_ROOT}/node_modules/@mark && \
    rm -rf core logger chainservice everclear prometheus web3signer cache rebalance database && \
    ln -s ../../packages/core/dist core && \
    ln -s ../../packages/adapters/logger/dist logger && \
    ln -s ../../packages/adapters/rebalance/dist rebalance && \
    ln -s ../../packages/adapters/chainservice/dist chainservice && \
    ln -s ../../packages/adapters/everclear/dist everclear && \
    ln -s ../../packages/adapters/prometheus/dist prometheus && \
    ln -s ../../packages/adapters/web3signer/dist web3signer && \
    ln -s ../../packages/adapters/cache/dist cache && \
    ln -s ../../packages/adapters/database/dist database

COPY --from=public.ecr.aws/datadog/lambda-extension:74 /opt/extensions/ /opt/extensions

CMD [ "src/index.handler" ]
EXPOSE 8080
