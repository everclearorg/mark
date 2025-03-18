FROM public.ecr.aws/lambda/nodejs:18 AS node

# ----------------------------------------
# Build stage
# ----------------------------------------

FROM node AS build
RUN yum update -y
RUN yum install -y git

RUN npm install --global yarn@1.22.19 node-gyp

ENV HOME=/tmp/build \
    PATH=/tmp/build/node_modules/.bin:./node_modules/.bin:${PATH} \
    PYTHON=/usr/bin/python3 \
    NODE_ENV=development \
    NODE_OPTIONS="--max-old-space-size=4096" \
    YARN_ENABLE_IMMUTABLE_INSTALLS=false \
    YARN_ENABLE_SCRIPTS=true \
    YARN_CACHE_FOLDER=/tmp/yarn-cache \
    SKIP_OPTIONAL_DEPENDENCIES=true \
    DD_SKIP_NATIVE_METRICS=true \
    DD_TRACE_ENABLED=true \
    DD_PROFILING_ENABLED=true \
    DD_VERSION=v5.42.0 \
    BUFFERUTIL_SKIP_INSTALL=true \
    UTF_8_VALIDATE_SKIP_INSTALL=true

WORKDIR /tmp/build

# Copy yarn configuration files first
COPY .yarn /tmp/build/.yarn/
COPY .yarnrc.yml /tmp/build/
COPY package.json /tmp/build/

# Copy all package.json files
COPY packages/core/package.json /tmp/build/packages/core/
COPY packages/poller/package.json /tmp/build/packages/poller/
COPY packages/adapters/logger/package.json /tmp/build/packages/adapters/logger/
COPY packages/adapters/chainservice/package.json /tmp/build/packages/adapters/chainservice/
COPY packages/adapters/everclear/package.json /tmp/build/packages/adapters/everclear/
COPY packages/adapters/web3signer/package.json /tmp/build/packages/adapters/web3signer/
COPY packages/adapters/cache/package.json /tmp/build/packages/adapters/cache/
COPY packages/adapters/prometheus/package.json /tmp/build/packages/adapters/prometheus/
COPY yarn.lock /tmp/build/

# Install dependencies including devDependencies
RUN yarn install --mode=skip-build && \
    yarn workspaces foreach -A run rebuild

# Copy source files
COPY packages/core /tmp/build/packages/core
COPY packages/poller /tmp/build/packages/poller
COPY packages/adapters/logger /tmp/build/packages/adapters/logger
COPY packages/adapters/chainservice /tmp/build/packages/adapters/chainservice
COPY packages/adapters/everclear /tmp/build/packages/adapters/everclear
COPY packages/adapters/web3signer /tmp/build/packages/adapters/web3signer
COPY packages/adapters/cache /tmp/build/packages/adapters/cache
COPY packages/adapters/prometheus /tmp/build/packages/adapters/prometheus
COPY tsconfig.json /tmp/build/

# Build packages
RUN yarn build

# ----------------------------------------
# Runtime stage
# ----------------------------------------

FROM node AS runtime

ENV NODE_ENV=production \
    PORT=8080

WORKDIR ${LAMBDA_TASK_ROOT}

# Copy the entire build directory
COPY --from=build /tmp/build ${LAMBDA_TASK_ROOT}
COPY --from=public.ecr.aws/datadog/lambda-extension:74 /opt/extensions/ /opt/extensions

EXPOSE 8080

CMD ["node_modules/datadog-lambda-js/dist/handler.handler"]