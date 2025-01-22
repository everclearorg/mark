import { MarkConfiguration } from '@mark/core';
import { createPublicClient, getContract, http, Abi, Chain } from 'viem';

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

export const getProviderUrl = (chainId: string, config: MarkConfiguration): string | undefined => {
  return config.chains[chainId]?.providers[0];
};

export const createClient = (chainId: string, config: MarkConfiguration) => {
  const providerURL = getProviderUrl(chainId, config);
  if (!providerURL) {
    throw new Error(`No RPC configured for given domain: ${chainId}`);
  }

  return createPublicClient({
    chain: chainId as unknown as Chain,
    transport: http(providerURL),
  });
};

export const getHubStorageContract = async (config: MarkConfiguration) => {
  const client = createClient('25327', config);

  return getContract({
    address: hub_address as `0x${string}`,
    abi: abi as unknown as Abi,
    client,
  });
};

export const getERC20Contract = async (config: MarkConfiguration, chainId: string, address: `0x${string}`) => {
  const client = createClient(chainId, config);
  return getContract({
    address: address,
    abi: abi as unknown as Abi,
    client,
  });
};
