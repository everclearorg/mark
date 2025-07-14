import {
  encodeFunctionData,
  erc20Abi,
  createPublicClient,
  fallback,
  http,
  zeroAddress,
  keccak256,
  decodeAbiParameters,
} from 'viem';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { RebalanceRoute, SupportedBridge } from '@mark/core';
import { Logger } from '@mark/logger';
import { USDC_CONTRACTS, TOKEN_MESSENGERS_V1, TOKEN_MESSENGERS_V2, MESSAGE_TRANSMITTERS_V1, MESSAGE_TRANSMITTERS_V2, DOMAINS, MAX_FEE, CHAIN_ID_TO_DOMAIN } from './constants';

const receiveMessageAbi = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [],
  },
];

export class CctpBridgeAdapter implements BridgeAdapter {
  constructor(
    protected readonly version: 'v1' | 'v2',
    protected readonly chains: Record<string, any>, // Use your ChainConfiguration type
    protected readonly logger: Logger,
  ) {}

  type(): SupportedBridge {
    return SupportedBridge.CCTP;
  }

  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    // No fees for CCTP, so just return the input amount
    return amount;
  }

  async send(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<MemoizedTransactionRequest[]> {
    // 1. Approval (if needed)
    // 2. Burn (depositForBurn)
    const originDomainName = CHAIN_ID_TO_DOMAIN[route.origin];
    const destinationDomainName = CHAIN_ID_TO_DOMAIN[route.destination];

    const usdcContract = USDC_CONTRACTS[originDomainName];
    if (!usdcContract) {
      throw new Error(`USDC contract not found for origin domain ${originDomainName}`);
    }

    const tokenMessenger = this.version === 'v1' ? TOKEN_MESSENGERS_V1[originDomainName] : TOKEN_MESSENGERS_V2[originDomainName];
    if (!tokenMessenger) {
      throw new Error(`Token messenger not found for origin domain ${originDomainName}`);
    }

    let approvalTx: MemoizedTransactionRequest | undefined;


      // Get the approval transaction if required
      if (route.asset.toLowerCase() !== zeroAddress.toLowerCase()) {
        const providers = this.chains[route.origin.toString()]?.providers ?? [];
        if (!providers.length) {
          throw new Error(`No providers found for origin chain ${route.origin}`);
        }
        const client = createPublicClient({ transport: fallback(providers.map((p: string) => http(p))) });
        const allowance = await client.readContract({
          address: route.asset as `0x${string}`,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [sender as `0x${string}`, tokenMessenger as `0x${string}`],
        });

        if (allowance < BigInt(amount)) {
          approvalTx = {
            memo: RebalanceTransactionMemo.Approval,
            transaction: {
              to: route.asset as `0x${string}`,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'approve',
                args: [tokenMessenger as `0x${string}`, BigInt(amount)],
              }),
              value: BigInt(0),
            },
          };
        }
      }

    // Burn (depositForBurn)
    const paddedRecipient = recipient.padStart(66, '0'); // bytes32
    let burnData;
    if (this.version === 'v1') {
      burnData = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "depositForBurn",
          stateMutability: "nonpayable",
          inputs: [
            { name: "amount", type: "uint256" },
            { name: "destinationDomain", type: "uint32" },
            { name: "mintRecipient", type: "bytes32" },
            { name: "burnToken", type: "address" },
          ],
          outputs: [{ name: "", type: "bool" }],
        },
      ],
      functionName: "depositForBurn",
      args: [BigInt(amount), route.destination, paddedRecipient as `0x${string}`, usdcContract as `0x${string}`],
    });
    } else {
      burnData = encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "depositForBurn",
            stateMutability: "nonpayable",
            inputs: [
              { name: "amount", type: "uint256" },
              { name: "destinationDomain", type: "uint32" },
              { name: "mintRecipient", type: "bytes32" },
              { name: "burnToken", type: "address" },
              { name: "destinationCaller", type: "bytes32" },
              { name: "maxFee", type: "uint256" },
              { name: "minFinalityThreshold", type: "uint32" },
            ],
            outputs: [],
          },
        ],
        functionName: "depositForBurn",
        args: [
          BigInt(amount),
          route.destination,
          paddedRecipient as `0x${string}`,
          usdcContract as `0x${string}`,
          paddedRecipient as `0x${string}`, // destinationCaller could be different
          MAX_FEE,
          // TODO: May need to chane this to slower
          1000, // minFinalityThreshold (1000 or less for Fast Transfer)
        ],
      });
    }

    const burnTx: MemoizedTransactionRequest = {
      memo: RebalanceTransactionMemo.Rebalance,
      transaction: {
        to: tokenMessenger as `0x${string}`,
        data: burnData,
        value: BigInt(0),
      },
    };

    // You may want to check allowance and only return approvalTx if needed
    return [approvalTx, burnTx].filter((x): x is MemoizedTransactionRequest => !!x);
  }

  async readyOnDestination(
    amount: string,
    route: RebalanceRoute,
    originTransaction: any, // TransactionReceipt
  ): Promise<boolean> {
    // Poll the attestation endpoint for the message hash
    const messageHash = await this.extractMessageHash(originTransaction);
    if (!messageHash) return false;

    const attestationReady = await this.pollAttestation(messageHash, route.origin.toString());
    return attestationReady;
  }

  async destinationCallback(
    route: RebalanceRoute,
    originTransaction: any, // TransactionReceipt
  ): Promise<MemoizedTransactionRequest | void> {
    // Get messageBytes and attestation
    const messageHash = await this.extractMessageHash(originTransaction);
    if (!messageHash) return;

    const { messageBytes, attestation } = await this.fetchAttestation(messageHash, route.origin.toString());
    const destinationDomainName = CHAIN_ID_TO_DOMAIN[route.destination];

    const messageTransmitter = this.version === 'v1'
      ? MESSAGE_TRANSMITTERS_V1[destinationDomainName]
      : MESSAGE_TRANSMITTERS_V2[destinationDomainName];

    const mintTx: MemoizedTransactionRequest = {
      memo: RebalanceTransactionMemo.Wrap, // Or a new memo type for mint
      transaction: {
        to: messageTransmitter as `0x${string}`,
        data: encodeFunctionData({
          abi: receiveMessageAbi,
          functionName: 'receiveMessage',
          args: [messageBytes, attestation],
        }),
        value: BigInt(0),
      },
    };

    return mintTx;
  }

  // --- Helper methods ---

  private async extractMessageHash(originTransaction: any): Promise<string | undefined> {
    // The event topic for MessageSent(bytes)
    // The keccak256 hash of 'MessageSent(bytes)' is:
    const eventTopic = '0x6d4ce63c7d2e1e2e2e2c1e6b2a4e8b3689464d8e9d8c2c1e6b2a4e8b3689464d'; // Replace with actual hash
    // If you have getEventSelector, use:
    // const eventTopic = getEventSelector('MessageSent(bytes)');
    const log = originTransaction.logs.find((l: any) => l.topics && l.topics[0] === eventTopic);
    if (!log) return undefined;
    // Decode the message bytes
    const [messageBytes] = decodeAbiParameters([{ type: 'bytes' }], log.data);
    // Hash the message bytes to get the message hash
    return keccak256(messageBytes);
  }

  private async pollAttestation(messageHash: string, domain: string): Promise<boolean> {
    if (this.version === 'v1') {
      // V1: https://iris-api.circle.com/attestations/{messageHash}
      try {
        const response = await fetch(`https://iris-api.circle.com/attestations/${messageHash}`);
        if (!response.ok) return false;
        const attestationResponse = await response.json();
        return attestationResponse.status === 'complete';
      } catch {
        return false;
      }
    } else {
      // V2: https://iris-api.circle.com/v2/messages/{domain}?transactionHash={messageHash}
      try {
        const axios = (await import('axios')).default;
        const url = `https://iris-api.circle.com/v2/messages/${domain}?transactionHash=${messageHash}`;
        const response = await axios.get(url);
        return response.data?.messages?.[0]?.status === 'complete';
      } catch {
        return false;
      }
    }
  }

  private async fetchAttestation(messageHash: string, domain: string): Promise<{ messageBytes: string, attestation: string }> {
    if (this.version === 'v1') {
      // V1: https://iris-api.circle.com/attestations/{messageHash}
      let attestationResponse: any = { status: 'pending' };
      let attempts = 0;
      const maxAttempts = 360; // 30 minutes
      while (attestationResponse.status !== 'complete' && attempts < maxAttempts) {
        try {
          const response = await fetch(`https://iris-api.circle.com/attestations/${messageHash}`);
          if (!response.ok) {
            await new Promise((r) => setTimeout(r, 5000));
            attempts++;
            continue;
          }
          attestationResponse = await response.json();
          if (attestationResponse.status === 'complete') {
            return {
              messageBytes: attestationResponse.message,
              attestation: attestationResponse.attestation,
            };
          }
        } catch (error) {
          await new Promise((r) => setTimeout(r, 5000));
        }
        attempts++;
        await new Promise((r) => setTimeout(r, 5000));
      }
      throw new Error(`Failed to get attestation after ${maxAttempts} attempts`);
    } else {
      // V2: https://iris-api.circle.com/v2/messages/{domain}?transactionHash={messageHash}
      const axios = (await import('axios')).default;
      const url = `https://iris-api.circle.com/v2/messages/${domain}?transactionHash=${messageHash}`;
      while (true) {
        try {
          const response = await axios.get(url);
          if (response.status === 404) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            continue;
          }
          if (response.data?.messages?.[0]?.status === 'complete') {
            return {
              messageBytes: response.data.messages[0].message,
              attestation: response.data.messages[0].attestation,
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 5000));
        } catch (error) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }
  }
}
