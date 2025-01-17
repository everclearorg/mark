FROM public.ecr.aws/lambda/nodejs:20 as build

# Set working directory
WORKDIR /tmp/build

# Install system dependencies
RUN yum install -y python3 make gcc gcc-c++ git

# Install yarn
RUN npm install -g yarn

# Copy workspace configuration files
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn

# Copy all workspace package.json files
COPY packages/core/package.json ./packages/core/
COPY packages/poller/package.json ./packages/poller/
COPY packages/adapters/logger/package.json ./packages/adapters/logger/
COPY packages/adapters/chainservice/package.json ./packages/adapters/chainservice/
COPY packages/adapters/everclear/package.json ./packages/adapters/everclear/
COPY packages/adapters/web3signer/package.json ./packages/adapters/web3signer/

# Install dependencies
RUN yarn install --frozen-lockfile

# Copy source files
COPY packages/core ./packages/core
COPY packages/poller ./packages/poller
COPY packages/adapters/logger ./packages/adapters/logger
COPY packages/adapters/chainservice ./packages/adapters/chainservice
COPY packages/adapters/everclear ./packages/adapters/everclear
COPY packages/adapters/web3signer ./packages/adapters/web3signer
COPY tsconfig.json ./

# Build all packages
RUN yarn build

# Runtime stage
FROM public.ecr.aws/lambda/nodejs:20 as runtime

# Set environment variables
ENV NODE_ENV=production

# Copy built files from build stage
COPY --from=build /tmp/build/packages/poller/dist ${LAMBDA_TASK_ROOT}
COPY --from=build /tmp/build/node_modules ${LAMBDA_TASK_ROOT}/node_modules

# Set the Lambda handler
CMD ["index.handler"]