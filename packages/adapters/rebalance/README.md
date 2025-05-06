# Mark Bridge Adapters

This package contains bridge adapters for the Mark protocol, allowing for cross-chain asset transfers.

## Development

### Prerequisites

- Node.js 18+
- Yarn
- A private key with test funds on the networks you want to test with

### Environment Setup

1. Create a `.env` file in the root directory:

```bash
PRIVATE_KEY=your_private_key_here
```

### Testing Bridge Adapters

The `dev` script provides a CLI interface for testing bridge adapters. It supports testing different bridge protocols and includes features like:

- Testing received amount calculations
- Sending bridge transactions
- Handling token approvals
- Polling for transaction readiness
- Executing callback transactions

#### Basic Usage

```bash
yarn dev adapter <type> [options]
```

#### Supported Adapters

Currently supported bridge types:

- `across` - Across Protocol bridge

#### Command Options

- `-a, --amount <amount>` - Amount to test with (in human-readable units, e.g., 0.01)
- `-o, --origin <chainId>` - Origin chain ID (default: 1 for Ethereum mainnet)
- `-d, --destination <chainId>` - Destination chain ID (default: 10 for Optimism)
- `-t, --token <address>` - Token address to test with (default: WETH on Ethereum)

#### Examples

1. Test Across bridge with default WETH:

```bash
yarn dev adapter across -a 0.01
```

2. Test Across bridge with a specific token:

```bash
yarn dev adapter across -a 0.01 -t 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
```

3. Test with custom chains:

```bash
yarn dev adapter across -a 0.01 -o 1 -d 137
```

#### Output

The script provides detailed logging of each step in the process:

1. Initial setup and configuration
2. Asset and chain validation
3. Amount conversion and fee calculation
4. Token approval (if needed)
5. Bridge transaction
6. Polling for transaction readiness
7. Callback transaction (if required)

Example output:

```
Starting bridge adapter test
Created route
Found origin chain config
Found asset config
Converted amount to wei
Received amount calculated
Got transaction request
Current token allowance
Approving token spend...
Bridge transaction sent
Bridge transaction confirmed
Starting to poll for transaction readiness...
Transaction is ready on destination chain
```

#### Adding New Adapters

To add support for a new bridge adapter:

1. Create a new adapter class implementing the `BridgeAdapter` interface
2. Add the adapter type to the `SupportedBridge` type
3. Add a new case in the switch statement in `dev.ts`

Example:

```typescript
case 'newbridge':
    adapter = new NewBridgeAdapter(
        'https://newbridge-api.example.com',
        configs.chains,
        logger
    );
    break;
```
