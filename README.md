# mark

Mark, the profit insensitive market making bot.

## Getting Started

1. Clone the repository:

```sh
git clone https://github.com/everclearorg/mark.git
cd mark
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

## Local Image

The poller image can be run locally.

1. Build the image
```
DOCKER_BUILDKIT=1 docker build -f docker/poller/Dockerfile -t mark-poller:local .
```

2. Run the image 
```
docker run -p 9000:8080 mark-poller:local
```

3. Send an invocation request
```
curl -X POST http://localhost:9000/2015-03-31/functions/function/invocations -d '{}'
```
