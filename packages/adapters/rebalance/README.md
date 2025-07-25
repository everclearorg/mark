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
- Resuming failed or incomplete transactions

#### Basic Usage

```bash
# Test a new bridge transaction
yarn dev adapter <type> [options]

# Resume an existing bridge transaction
yarn dev resume [options]
```

#### Supported Adapters

Currently supported bridge types:

- `across` - Across Protocol bridge

#### Command Options

For `adapter` command:

- `-a, --amount <amount>` - Amount to test with (in human-readable units, e.g., 0.01)
- `-o, --origin <chainId>` - Origin chain ID (default: 1 for Ethereum mainnet)
- `-d, --destination <chainId>` - Destination chain ID (default: 10 for Optimism)
- `-t, --token <address>` - Token address to test with (default: WETH on Ethereum)

For `resume` command:

- `-o, --origin <chainId>` - Origin chain ID (required)
- `-h, --hash <txHash>` - Transaction hash to resume from (required)
- `-d, --destination <chainId>` - Destination chain ID (default: 10)
- `-a, --amount <amount>` - Original amount (in human units, default: 0.01)
- `-t, --token <address>` - Token address used in the transaction

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

4. Resume a failed or incomplete transaction:

```bash
yarn dev resume -o 1 -h 0x123... -a 0.01
```

5. Resume a specific token transaction:

```bash
yarn dev resume -o 1 -h 0x123... -a 0.01 -t 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
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

#### Error Handling

The script includes comprehensive error handling for:

- Missing environment variables
- Invalid chain configurations
- Asset not found
- Insufficient token allowance
- Transaction failures
- Timeout during polling
- Invalid transaction hashes
- Chain-specific transaction receipt formats

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

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request
