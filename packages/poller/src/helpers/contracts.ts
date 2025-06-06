import { MarkConfiguration } from '@mark/core';
import { createPublicClient, getContract, http, Abi, Chain, Address } from 'viem';

const erc20Abi = [
  {
    constant: true,
    inputs: [],
    name: 'name',
    outputs: [
      {
        name: '',
        type: 'string',
      },
    ],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: false,
    inputs: [
      {
        name: '_spender',
        type: 'address',
      },
      {
        name: '_value',
        type: 'uint256',
      },
    ],
    name: 'approve',
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    payable: false,
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'totalSupply',
    outputs: [
      {
        name: '',
        type: 'uint256',
      },
    ],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: false,
    inputs: [
      {
        name: '_from',
        type: 'address',
      },
      {
        name: '_to',
        type: 'address',
      },
      {
        name: '_value',
        type: 'uint256',
      },
    ],
    name: 'transferFrom',
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    payable: false,
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'decimals',
    outputs: [
      {
        name: '',
        type: 'uint8',
      },
    ],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: true,
    inputs: [
      {
        name: '_owner',
        type: 'address',
      },
    ],
    name: 'balanceOf',
    outputs: [
      {
        name: 'balance',
        type: 'uint256',
      },
    ],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'symbol',
    outputs: [
      {
        name: '',
        type: 'string',
      },
    ],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: false,
    inputs: [
      {
        name: '_to',
        type: 'address',
      },
      {
        name: '_value',
        type: 'uint256',
      },
    ],
    name: 'transfer',
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    payable: false,
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    constant: true,
    inputs: [
      {
        name: '_owner',
        type: 'address',
      },
      {
        name: '_spender',
        type: 'address',
      },
    ],
    name: 'allowance',
    outputs: [
      {
        name: '',
        type: 'uint256',
      },
    ],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    payable: true,
    stateMutability: 'payable',
    type: 'fallback',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: 'owner',
        type: 'address',
      },
      {
        indexed: true,
        name: 'spender',
        type: 'address',
      },
      {
        indexed: false,
        name: 'value',
        type: 'uint256',
      },
    ],
    name: 'Approval',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: 'from',
        type: 'address',
      },
      {
        indexed: true,
        name: 'to',
        type: 'address',
      },
      {
        indexed: false,
        name: 'value',
        type: 'uint256',
      },
    ],
    name: 'Transfer',
    type: 'event',
  },
];

const hubStorageAbi = [
  {
    type: 'function',
    name: 'assetHash',
    inputs: [
      {
        name: '_tickerHash',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: '_domain',
        type: 'uint32',
        internalType: 'uint32',
      },
    ],
    outputs: [
      {
        name: '_assetHash',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'custodiedAssets',
    inputs: [
      {
        name: '_assetHash',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [
      {
        name: '_amount',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'adoptedForAssets',
    inputs: [
      {
        name: '_assetHash',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [
      {
        name: '_config',
        type: 'tuple',
        internalType: 'struct IHubStorage.AssetConfig',
        components: [
          {
            name: 'tickerHash',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'adopted',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'domain',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'approval',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'strategy',
            type: 'uint8',
            internalType: 'enum IEverclear.Strategy',
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const;

export const multicallAbi = [
  {
    name: 'aggregate3Value',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'value', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
  {
    name: 'aggregate3',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

const HUB_MAINNET_ADDR = '0xa05A3380889115bf313f1Db9d5f335157Be4D816';
const HUB_TESTNET_ADDR = '0x4C526917051ee1981475BB6c49361B0756F505a8';

export const getMulticallAddress = (chainId: string, config: MarkConfiguration): Address => {
  const chainConfig = config.chains[chainId];

  if (!chainConfig) {
    throw new Error(`Chain configuration not found for chain ID: ${chainId}`);
  }

  return chainConfig.deployments.multicall3 as Address;
};

export const getProviderUrl = (chainId: string, config: MarkConfiguration): string | undefined => {
  return chainId === config.hub.domain ? config.hub.providers[0] : config.chains[chainId]?.providers[0];
};

// Singleton map for viem clients
const viemClients = new Map<string, ReturnType<typeof createPublicClient>>();

export const createClient = (chainId: string, config: MarkConfiguration) => {
  if (viemClients.has(chainId)) {
    return viemClients.get(chainId)!;
  }

  const providerURL = getProviderUrl(chainId, config);
  if (!providerURL) {
    throw new Error(`No RPC configured for given domain: ${chainId}`);
  }

  const client = createPublicClient({
    chain: chainId as unknown as Chain,
    transport: http(providerURL, {
      batch: {
        wait: 200,
      },
      fetchOptions: {
        keepalive: true,
      },
    }),
    batch: { multicall: { wait: 200 } },
  });

  // Cache the client for reuse
  viemClients.set(chainId, client);
  return client;
};

// Cleanup function for viem clients
export const cleanupViemClients = (): void => {
  viemClients.clear();
  console.log('Viem clients cleaned up successfully');
};

export const getHubStorageContract = (config: MarkConfiguration) => {
  const client = createClient(config.hub.domain, config);

  return getContract({
    address: config.environment === 'mainnet' ? HUB_MAINNET_ADDR : HUB_TESTNET_ADDR,
    abi: hubStorageAbi as unknown as Abi,
    client,
  });
};

export const getERC20Contract = async (config: MarkConfiguration, chainId: string, address: `0x${string}`) => {
  const client = createClient(chainId, config);
  return getContract({
    address: address,
    abi: erc20Abi as unknown as Abi,
    client,
  });
};

export const feeAdapterAbi = [
  {
    inputs: [
      { name: '_fee', type: 'uint256' },
      {
        name: '_params',
        type: 'tuple[]',
        components: [
          { name: 'destinations', type: 'uint32[]' },
          { name: 'receiver', type: 'address' },
          { name: 'inputAsset', type: 'address' },
          { name: 'outputAsset', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'maxFee', type: 'uint24' },
          { name: 'ttl', type: 'uint48' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    name: 'newOrder',
    outputs: [
      { name: '_orderId', type: 'bytes32' },
      { name: '_intentIds', type: 'bytes32[]' },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: 'orderId',
        type: 'bytes32',
      },
      {
        indexed: true,
        name: 'sender',
        type: 'bytes32',
      },
      {
        indexed: false,
        name: 'intentIds',
        type: 'bytes32[]',
      },
      {
        indexed: false,
        name: 'tokenFee',
        type: 'uint256',
      },
      {
        indexed: false,
        name: 'nativeFee',
        type: 'uint256',
      },
    ],
    name: 'OrderCreated',
    type: 'event',
  },
] as const;
