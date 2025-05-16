FROM public.ecr.aws/lambda/nodejs:18 AS node

WORKDIR /tmp/build

# Copy package files
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn

# Copy workspace package files
COPY packages/admin/package.json ./packages/admin/
COPY packages/adapters/cache/package.json ./packages/adapters/cache/
COPY packages/adapters/logger/package.json ./packages/adapters/logger/
COPY packages/core/package.json ./packages/core/

# Install dependencies
RUN yarn install --immutable

# Copy source code
COPY packages/admin/ ./packages/admin/
COPY packages/adapters/cache/ ./packages/adapters/cache/
COPY packages/adapters/logger/ ./packages/adapters/logger/
COPY packages/core/ ./packages/core/

# Build the packages
RUN yarn workspace @mark/core build && \
    yarn workspace @mark/logger build && \
    yarn workspace @mark/cache build && \
    yarn workspace @mark/admin build

# Final stage
FROM public.ecr.aws/lambda/nodejs:18

# Set up Lambda environment
WORKDIR ${LAMBDA_TASK_ROOT}

# Copy built files from the build stage
COPY --from=build /tmp/build/node_modules ${LAMBDA_TASK_ROOT}/node_modules
COPY --from=build /tmp/build/packages/admin/dist/* ${LAMBDA_TASK_ROOT}/
COPY --from=build /tmp/build/packages/core/dist ${LAMBDA_TASK_ROOT}/packages/core/dist
COPY --from=build /tmp/build/packages/adapters/logger/dist ${LAMBDA_TASK_ROOT}/packages/adapters/logger/dist
COPY --from=build /tmp/build/packages/adapters/cache/dist ${LAMBDA_TASK_ROOT}/packages/adapters/cache/dist

# Create symlinks for local imports
RUN cd ${LAMBDA_TASK_ROOT}/node_modules/@mark && \
    ln -s ../../packages/core/dist core && \
    ln -s ../../packages/adapters/logger/dist logger && \
    ln -s ../../packages/adapters/cache/dist cache

# Add Datadog Lambda layer (optional, but based on your poller setup it seems you're using Datadog)
COPY --from=public.ecr.aws/datadog/lambda-extension:74 /opt/extensions/ /opt/extensions

# Command to run
CMD ["index.handler"] 