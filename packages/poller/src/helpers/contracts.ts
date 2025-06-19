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
    type: 'constructor',
    inputs: [
      {
        name: '_spoke',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_feeRecipient',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_feeSigner',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_xerc20Module',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_owner',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'PERMIT2',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract IPermit2',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'acceptOwnership',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'feeRecipient',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'feeSigner',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'newIntent',
    inputs: [
      {
        name: '_destinations',
        type: 'uint32[]',
        internalType: 'uint32[]',
      },
      {
        name: '_receiver',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: '_inputAsset',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_outputAsset',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: '_amount',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: '_maxFee',
        type: 'uint24',
        internalType: 'uint24',
      },
      {
        name: '_ttl',
        type: 'uint48',
        internalType: 'uint48',
      },
      {
        name: '_data',
        type: 'bytes',
        internalType: 'bytes',
      },
      {
        name: '_feeParams',
        type: 'tuple',
        internalType: 'struct IFeeAdapter.FeeParams',
        components: [
          {
            name: 'fee',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'deadline',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'sig',
            type: 'bytes',
            internalType: 'bytes',
          },
        ],
      },
    ],
    outputs: [
      {
        name: '_intentId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: '_intent',
        type: 'tuple',
        internalType: 'struct IEverclear.Intent',
        components: [
          {
            name: 'initiator',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'receiver',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'inputAsset',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'outputAsset',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'maxFee',
            type: 'uint24',
            internalType: 'uint24',
          },
          {
            name: 'origin',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'nonce',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'timestamp',
            type: 'uint48',
            internalType: 'uint48',
          },
          {
            name: 'ttl',
            type: 'uint48',
            internalType: 'uint48',
          },
          {
            name: 'amount',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'destinations',
            type: 'uint32[]',
            internalType: 'uint32[]',
          },
          {
            name: 'data',
            type: 'bytes',
            internalType: 'bytes',
          },
        ],
      },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'newIntent',
    inputs: [
      {
        name: '_destinations',
        type: 'uint32[]',
        internalType: 'uint32[]',
      },
      {
        name: '_receiver',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_inputAsset',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_outputAsset',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_amount',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: '_maxFee',
        type: 'uint24',
        internalType: 'uint24',
      },
      {
        name: '_ttl',
        type: 'uint48',
        internalType: 'uint48',
      },
      {
        name: '_data',
        type: 'bytes',
        internalType: 'bytes',
      },
      {
        name: '_permit2Params',
        type: 'tuple',
        internalType: 'struct IEverclearSpoke.Permit2Params',
        components: [
          {
            name: 'nonce',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'deadline',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'signature',
            type: 'bytes',
            internalType: 'bytes',
          },
        ],
      },
      {
        name: '_feeParams',
        type: 'tuple',
        internalType: 'struct IFeeAdapter.FeeParams',
        components: [
          {
            name: 'fee',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'deadline',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'sig',
            type: 'bytes',
            internalType: 'bytes',
          },
        ],
      },
    ],
    outputs: [
      {
        name: '_intentId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: '_intent',
        type: 'tuple',
        internalType: 'struct IEverclear.Intent',
        components: [
          {
            name: 'initiator',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'receiver',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'inputAsset',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'outputAsset',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'maxFee',
            type: 'uint24',
            internalType: 'uint24',
          },
          {
            name: 'origin',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'nonce',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'timestamp',
            type: 'uint48',
            internalType: 'uint48',
          },
          {
            name: 'ttl',
            type: 'uint48',
            internalType: 'uint48',
          },
          {
            name: 'amount',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'destinations',
            type: 'uint32[]',
            internalType: 'uint32[]',
          },
          {
            name: 'data',
            type: 'bytes',
            internalType: 'bytes',
          },
        ],
      },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'newIntent',
    inputs: [
      {
        name: '_destinations',
        type: 'uint32[]',
        internalType: 'uint32[]',
      },
      {
        name: '_receiver',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_inputAsset',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_outputAsset',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_amount',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: '_maxFee',
        type: 'uint24',
        internalType: 'uint24',
      },
      {
        name: '_ttl',
        type: 'uint48',
        internalType: 'uint48',
      },
      {
        name: '_data',
        type: 'bytes',
        internalType: 'bytes',
      },
      {
        name: '_feeParams',
        type: 'tuple',
        internalType: 'struct IFeeAdapter.FeeParams',
        components: [
          {
            name: 'fee',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'deadline',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'sig',
            type: 'bytes',
            internalType: 'bytes',
          },
        ],
      },
    ],
    outputs: [
      {
        name: '_intentId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: '_intent',
        type: 'tuple',
        internalType: 'struct IEverclear.Intent',
        components: [
          {
            name: 'initiator',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'receiver',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'inputAsset',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'outputAsset',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'maxFee',
            type: 'uint24',
            internalType: 'uint24',
          },
          {
            name: 'origin',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'nonce',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'timestamp',
            type: 'uint48',
            internalType: 'uint48',
          },
          {
            name: 'ttl',
            type: 'uint48',
            internalType: 'uint48',
          },
          {
            name: 'amount',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'destinations',
            type: 'uint32[]',
            internalType: 'uint32[]',
          },
          {
            name: 'data',
            type: 'bytes',
            internalType: 'bytes',
          },
        ],
      },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'newOrder',
    inputs: [
      {
        name: '_fee',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: '_deadline',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: '_sig',
        type: 'bytes',
        internalType: 'bytes',
      },
      {
        name: '_params',
        type: 'tuple[]',
        internalType: 'struct IFeeAdapter.OrderParameters[]',
        components: [
          {
            name: 'destinations',
            type: 'uint32[]',
            internalType: 'uint32[]',
          },
          {
            name: 'receiver',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'inputAsset',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'outputAsset',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'amount',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxFee',
            type: 'uint24',
            internalType: 'uint24',
          },
          {
            name: 'ttl',
            type: 'uint48',
            internalType: 'uint48',
          },
          {
            name: 'data',
            type: 'bytes',
            internalType: 'bytes',
          },
        ],
      },
    ],
    outputs: [
      {
        name: '_orderId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: '_intentIds',
        type: 'bytes32[]',
        internalType: 'bytes32[]',
      },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'newOrderSplitEvenly',
    inputs: [
      {
        name: '_numIntents',
        type: 'uint32',
        internalType: 'uint32',
      },
      {
        name: '_fee',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: '_deadline',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: '_sig',
        type: 'bytes',
        internalType: 'bytes',
      },
      {
        name: '_params',
        type: 'tuple',
        internalType: 'struct IFeeAdapter.OrderParameters',
        components: [
          {
            name: 'destinations',
            type: 'uint32[]',
            internalType: 'uint32[]',
          },
          {
            name: 'receiver',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'inputAsset',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'outputAsset',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'amount',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxFee',
            type: 'uint24',
            internalType: 'uint24',
          },
          {
            name: 'ttl',
            type: 'uint48',
            internalType: 'uint48',
          },
          {
            name: 'data',
            type: 'bytes',
            internalType: 'bytes',
          },
        ],
      },
    ],
    outputs: [
      {
        name: '_orderId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: '_intentIds',
        type: 'bytes32[]',
        internalType: 'bytes32[]',
      },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'owner',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'pendingOwner',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'renounceOwnership',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'returnUnsupportedIntent',
    inputs: [
      {
        name: '_asset',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_amount',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: '_recipient',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'spoke',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract IEverclearSpokeV3',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'transferOwnership',
    inputs: [
      {
        name: 'newOwner',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'updateFeeRecipient',
    inputs: [
      {
        name: '_feeRecipient',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'updateFeeSigner',
    inputs: [
      {
        name: '_feeSigner',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'xerc20Module',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'FeeRecipientUpdated',
    inputs: [
      {
        name: '_updated',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: '_previous',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'FeeSignerUpdated',
    inputs: [
      {
        name: '_updated',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: '_previous',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'IntentWithFeesAdded',
    inputs: [
      {
        name: '_intentId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: '_initiator',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: '_tokenFee',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: '_nativeFee',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OrderCreated',
    inputs: [
      {
        name: '_orderId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: '_initiator',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: '_intentIds',
        type: 'bytes32[]',
        indexed: false,
        internalType: 'bytes32[]',
      },
      {
        name: '_tokenFee',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: '_nativeFee',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OwnershipTransferStarted',
    inputs: [
      {
        name: 'previousOwner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'newOwner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OwnershipTransferred',
    inputs: [
      {
        name: 'previousOwner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'newOwner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'AddressEmptyCode',
    inputs: [
      {
        name: 'target',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'AddressInsufficientBalance',
    inputs: [
      {
        name: 'account',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'ECDSAInvalidSignature',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ECDSAInvalidSignatureLength',
    inputs: [
      {
        name: 'length',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'ECDSAInvalidSignatureS',
    inputs: [
      {
        name: 's',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
  },
  {
    type: 'error',
    name: 'FailedInnerCall',
    inputs: [],
  },
  {
    type: 'error',
    name: 'FeeAdapter_InvalidDeadline',
    inputs: [],
  },
  {
    type: 'error',
    name: 'FeeAdapter_InvalidSignature',
    inputs: [],
  },
  {
    type: 'error',
    name: 'MultipleOrderAssets',
    inputs: [],
  },
  {
    type: 'error',
    name: 'OwnableInvalidOwner',
    inputs: [
      {
        name: 'owner',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'OwnableUnauthorizedAccount',
    inputs: [
      {
        name: 'account',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'SafeERC20FailedDecreaseAllowance',
    inputs: [
      {
        name: 'spender',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'currentAllowance',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'requestedDecrease',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'SafeERC20FailedOperation',
    inputs: [
      {
        name: 'token',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
] as const;
