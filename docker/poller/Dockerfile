# Use the official Node.js image as a base
FROM node:20

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and yarn.lock files
COPY packages/poller/package.json packages/poller/yarn.lock ./

# Install dependencies
RUN yarn install --frozen-lockfile

# Copy the rest of the application code
COPY packages/poller/src ./src

# Build the application
RUN yarn build

# Set the command to run the Lambda function
CMD ["node", "dist/index.js"]