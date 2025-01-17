FROM public.ecr.aws/lambda/nodejs:18 AS node

# ----------------------------------------
# Build stage
# ----------------------------------------

FROM node AS build
RUN yum update -y
RUN yum install -y git python3 python3-pip make gcc gcc-c++ python3-devel
RUN npm install --global yarn@1.22.19

ENV HOME=/tmp/build \
    PATH=/tmp/build/node_modules/.bin:./node_modules/.bin:${PATH}

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
COPY yarn.lock /tmp/build/

# Install dependencies with frozen lockfile
RUN YARN_ENABLE_SCRIPTS=0 yarn install --frozen-lockfile

# Copy source files
COPY packages/core /tmp/build/packages/core
COPY packages/poller /tmp/build/packages/poller
COPY packages/adapters/logger /tmp/build/packages/adapters/logger
COPY packages/adapters/chainservice /tmp/build/packages/adapters/chainservice
COPY packages/adapters/everclear /tmp/build/packages/adapters/everclear
COPY packages/adapters/web3signer /tmp/build/packages/adapters/web3signer
COPY tsconfig.json /tmp/build/

# Build packages
RUN yarn build

# ----------------------------------------
# Runtime stage
# ----------------------------------------

FROM node AS runtime

ENV NODE_ENV=production

# Copy built files from build stage
COPY --from=build /tmp/build/packages/poller/dist ${LAMBDA_TASK_ROOT}
COPY --from=build /tmp/build/node_modules ${LAMBDA_TASK_ROOT}/node_modules

CMD ["index.handler"]