import { ProcessInvoicesConfig } from 'src/invoice/processInvoices';
import { createPublicClient, http, getContract, Abi, Chain } from 'viem';

const abi = [
  {
    name: 'assetHash',
    type: 'function',
    inputs: [{ type: 'bytes32' }, { type: 'uint32' }],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'custodiedAssets',
    type: 'function',
    inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },
];

const hub_address = '0x121344';

export const getProviderUrl = (chainId: string, config: any): string | undefined => {
  return config.chains[chainId]?.providers[0];
};

const createClient = (chainId: string, config: ProcessInvoicesConfig) => {
  const providerURL = getProviderUrl(chainId, config);
  if (!providerURL) {
    throw new Error(`No RPC configured for given domain: ${chainId}`);
  }

  return createPublicClient({
    chain: chainId as unknown as Chain,
    transport: http(providerURL),
  });
};

export const getHubStorageContract = async (config: ProcessInvoicesConfig) => {
  const client = createClient('hub_chain_id', config);
  return getContract({
    address: hub_address as `0x${string}`,
    abi: abi as unknown as Abi,
    client,
  });
};
