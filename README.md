# mark

Mark, the profit insensitive market making bot.

## Getting Started

1. Clone the repository:

```sh
git clone https://github.com/everclearorg/mark.git
cd mark
```

2. Use yarn 3.3.1 and node v18

```
yarn --version
> 3.3.1
```

```
node --version
v18.17.0
```

2. Install dependencies:

```sh
yarn install
```

3. Verify everything is working:

```sh
yarn build
yarn test
```

## Local Dev

1. Start local redis

```sh
yarn redis:up
```

2. Copy and populate the `.env`

```sh
cp packages/poller/.env.example packages/poller/.env
```

3. Start local poller in dev-mode

```sh
yarn workspace @mark/poller dev
```

4. (optional) Start monitoring services

```sh
yarn monitoring:up
```

If running with prometheus and grafana, grafana will be accessible with the user and password as `admin` at `localhost:3030` and prometheus is accessible at `localhost:9090`.

## Local Image

The poller image can be run locally.

1. Build the image

```
DOCKER_BUILDKIT=1 docker build -f docker/poller/Dockerfile -t mark-poller:local .
```

2. Create a network for peripherals

```
docker network create mark-network
```

3. Start redis

```
docker run --name redis --network mark-network -d redis

```

4. Run the Mark image with necessary env vars

```
docker run --network mark-network -p 9000:8080 \
  -e DD_API_KEY=dummy_key \
  -e DD_ENV=development \
  -e DD_SERVICE=mark-poller \
  -e DD_LAMBDA_HANDLER=packages/poller/dist/index.handler \
  -e DD_LOGS_ENABLED=true \
  -e SUPPORTED_ASSETS=0xtoken1,0xtoken2 \
  -e INVOICE_AGE=600 \
  -e SIGNER_URL=http://web3signer:9000 \
  -e SIGNER_ADDRESS=0x1234567890123456789012345678901234567890 \
  -e REDIS_HOST=redis \
  -e REDIS_PORT=6379 \
  -e EVERCLEAR_API_URL=http://everclear:3000 \
  -e RELAYER_URL=http://relayer:8080 \
  -e RELAYER_API_KEY=dummy_relayer_key \
  -e SUPPORTED_SETTLEMENT_DOMAINS=1,2,3 \
  -e LOG_LEVEL=debug \
  -e ENVIRONMENT=development \
  -e STAGE=local \
  -e CHAIN_IDS=1,137,42161 \
  -e CHAIN_1_PROVIDERS=https://eth-mainnet.g.alchemy.com/v2/dummy \
  -e CHAIN_137_PROVIDERS=https://polygon-mainnet.g.alchemy.com/v2/dummy \
  -e CHAIN_42161_PROVIDERS=https://arb-mainnet.g.alchemy.com/v2/dummy \
  -e CHAIN_1_ASSETS=0xtoken1,0xtoken2 \
  -e CHAIN_137_ASSETS=0xtoken1,0xtoken2 \
  -e CHAIN_42161_ASSETS=0xtoken1,0xtoken2 \
  --name mark-poller \
  mark-poller:local
```

5. Send an invocation request

```
curl -X POST http://localhost:9000/2015-03-31/functions/function/invocations -d '{}'
```
