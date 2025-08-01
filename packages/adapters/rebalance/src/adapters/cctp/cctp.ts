import {
  encodeFunctionData,
  erc20Abi,
  createPublicClient,
  fallback,
  http,
  keccak256,
  decodeAbiParameters,
  pad,
  TransactionReceipt,
} from 'viem';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { ChainConfiguration, RebalanceRoute, SupportedBridge } from '@mark/core';
import { Logger } from '@mark/logger';
import {
  USDC_CONTRACTS,
  TOKEN_MESSENGERS_V1,
  TOKEN_MESSENGERS_V2,
  MESSAGE_TRANSMITTERS_V1,
  MESSAGE_TRANSMITTERS_V2,
  CHAIN_ID_TO_DOMAIN,
  CHAIN_ID_TO_NUMERIC_DOMAIN,
} from './constants';

const receiveMessageAbi = [
  {
    type: 'function',
    name: 'receiveMessage',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'message', type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
    ],
    outputs: [],
  },
];

export class CctpBridgeAdapter implements BridgeAdapter {
  constructor(
    protected readonly version: 'v1' | 'v2',
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: Logger,
  ) {}

  type(): SupportedBridge {
    return this.version === 'v1' ? SupportedBridge.CCTPV1 : SupportedBridge.CCTPV2;
  }
  // Fees: https://developers.circle.com/cctp
  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    if (
      !Object.values(USDC_CONTRACTS)
        .map((a) => a.toLowerCase())
        .includes(route.asset.toLowerCase())
    ) {
      throw new Error(`Asset ${route.asset} is not a supported asset for CCTP`);
    }
    // No fees for CCTP standard transfers, so just return the input amount
    return amount;
  }

  async getReceivedAmountFast(amount: string, route: RebalanceRoute): Promise<string> {
    if (this.version === 'v1') {
      throw new Error('Fast transfer is not supported for CCTP v1');
    }

    if (
      !Object.values(USDC_CONTRACTS)
        .map((a) => a.toLowerCase())
        .includes(route.asset.toLowerCase())
    ) {
      throw new Error(`Asset ${route.asset} is not a supported asset for CCTP`);
    }

    // Use direct mapping from chain ID to numeric domain
    const originDomain = CHAIN_ID_TO_NUMERIC_DOMAIN[route.origin];
    const destinationDomain = CHAIN_ID_TO_NUMERIC_DOMAIN[route.destination];
    if (!originDomain || !destinationDomain) {
      throw new Error(`Invalid origin or destination domain: ${route.origin} or ${route.destination}`);
    }

    const url = `https://iris-api.circle.com/v2/burn/USDC/fees/${originDomain}/${destinationDomain}`;
    const options = { method: 'GET', headers: { 'Content-Type': 'application/json' } };

    try {
      const res = await fetch(url, options);
      const json = await res.json();
      // Expecting an array of objects with minimumFee
      if (Array.isArray(json) && json.length > 0) {
        const maxFee = json.reduce(
          (max, curr) => (typeof curr.minimumFee === 'number' && curr.minimumFee > max ? curr.minimumFee : max),
          0,
        );
        return maxFee.toString();
      }
      return amount;
    } catch (err) {
      console.error('error:', err);
      return amount;
    }
  }

  async send(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
    fastTransfer: boolean = false,
  ): Promise<MemoizedTransactionRequest[]> {
    if (
      !Object.values(USDC_CONTRACTS)
        .map((a) => a.toLowerCase())
        .includes(route.asset.toLowerCase())
    ) {
      throw new Error(`Asset ${route.asset} is not a supported asset for CCTP`);
    }

    const originDomainName = CHAIN_ID_TO_DOMAIN[route.origin];
    const usdcContract = USDC_CONTRACTS[originDomainName];
    if (!usdcContract) {
      throw new Error(`USDC contract not found for origin domain ${originDomainName}`);
    }

    const circleDomainId = CHAIN_ID_TO_NUMERIC_DOMAIN[route.destination];
    if (circleDomainId === undefined || circleDomainId === null) {
      throw new Error(`Circle domain not found for destination chain ${route.destination}`);
    }

    const tokenMessenger =
      this.version === 'v1' ? TOKEN_MESSENGERS_V1[originDomainName] : TOKEN_MESSENGERS_V2[originDomainName];
    if (!tokenMessenger) {
      throw new Error(`Token messenger not found for origin domain ${originDomainName}`);
    }

    // Approval
    let approvalTx: MemoizedTransactionRequest | undefined;
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

    // Burn (depositForBurn)
    const paddedSender = pad(sender as `0x${string}`, { size: 32 }); // bytes32
    const paddedRecipient = pad(recipient as `0x${string}`, { size: 32 }); // bytes32
    let burnData;
    if (this.version === 'v1') {
      burnData = encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'depositForBurn',
            stateMutability: 'nonpayable',
            inputs: [
              { name: 'amount', type: 'uint256' },
              { name: 'destinationDomain', type: 'uint32' },
              { name: 'mintRecipient', type: 'bytes32' },
              { name: 'burnToken', type: 'address' },
            ],
            outputs: [{ name: '', type: 'bool' }],
          },
        ],
        functionName: 'depositForBurn',
        args: [BigInt(amount), circleDomainId, paddedRecipient as `0x${string}`, usdcContract as `0x${string}`],
      });
    } else {
      // Calculating maxFee as 1 BPS of amount for fast transfer and 0 for standard transfer
      const maxFee = fastTransfer ? (BigInt(amount) * BigInt(100)) / BigInt(1000000) : BigInt(0);
      // Setting minFinalityThreshold to 1000 for fast transfer and 2000 for standard transfer
      const minFinalityThreshold = fastTransfer ? 1000 : 2000;
      burnData = encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'depositForBurn',
            stateMutability: 'nonpayable',
            inputs: [
              { name: 'amount', type: 'uint256' },
              { name: 'destinationDomain', type: 'uint32' },
              { name: 'mintRecipient', type: 'bytes32' },
              { name: 'burnToken', type: 'address' },
              { name: 'destinationCaller', type: 'bytes32' },
              { name: 'maxFee', type: 'uint256' },
              { name: 'minFinalityThreshold', type: 'uint32' },
            ],
            outputs: [],
          },
        ],
        functionName: 'depositForBurn',
        args: [
          BigInt(amount),
          circleDomainId,
          paddedSender as `0x${string}`,
          usdcContract as `0x${string}`,
          paddedRecipient as `0x${string}`, // destinationCaller could be different
          maxFee,
          minFinalityThreshold, // minFinalityThreshold (1000 or less for Fast Transfer)
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

    return [approvalTx, burnTx].filter((x): x is MemoizedTransactionRequest => !!x);
  }

  async readyOnDestination(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<boolean> {
    // Poll the attestation endpoint for the message hash
    const { messageHash } = await this.extractMessageHash(originTransaction);
    if (!messageHash) return false;

    const originDomain = CHAIN_ID_TO_NUMERIC_DOMAIN[route.origin];
    if (!originDomain) {
      throw new Error(`Invalid origin domain: ${route.origin}`);
    }

    const attestationReady = await this.pollAttestation(messageHash, originDomain.toString());
    return attestationReady;
  }

  async destinationCallback(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt, // TransactionReceipt
  ): Promise<MemoizedTransactionRequest | void> {
    // Get messageBytes and attestation
    const { messageHash, messageBytesV1 } = await this.extractMessageHash(originTransaction);
    if (!messageHash) {
      throw new Error('Message hash not found');
    }

    const domainId =
      this.version === 'v1' ? route.origin.toString() : CHAIN_ID_TO_NUMERIC_DOMAIN[route.origin].toString();
    if (!domainId) {
      throw new Error(`Invalid domain ID: ${route.origin}`);
    }

    let { messageBytes, attestation } = await this.fetchAttestation(messageHash, domainId);
    if (messageBytes === 'v1' && messageBytesV1) messageBytes = messageBytesV1;
    if (messageBytes === undefined) {
      throw new Error('Message bytes not found');
    }

    const destinationDomainName = CHAIN_ID_TO_DOMAIN[route.destination];
    const messageTransmitter =
      this.version === 'v1'
        ? MESSAGE_TRANSMITTERS_V1[destinationDomainName]
        : MESSAGE_TRANSMITTERS_V2[destinationDomainName];

    const mintTx: MemoizedTransactionRequest = {
      memo: RebalanceTransactionMemo.Mint,
      transaction: {
        to: messageTransmitter as `0x${string}`,
        data: encodeFunctionData({
          abi: receiveMessageAbi,
          functionName: 'receiveMessage',
          args: [messageBytes ?? '', attestation],
        }),
        value: BigInt(0),
      },
    };
    return mintTx;
  }

  // --- Helper methods ---
  private async extractMessageHash(
    originTransaction: TransactionReceipt,
  ): Promise<{ messageBytesV1: string; messageHash: string }> {
    if (this.version === 'v1') {
      // The event topic for MessageSent(bytes)
      const eventTopic = '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036';
      const log = originTransaction.logs.find((l) => l.topics && l.topics[0] === eventTopic);
      if (!log) {
        throw new Error('Message sent event not found');
      }

      // Decode the message bytes
      const messageBytesV1 = decodeAbiParameters([{ type: 'bytes' }], log.data)[0];
      return {
        messageBytesV1,
        messageHash: keccak256(messageBytesV1),
      };
    } else {
      return {
        messageBytesV1: 'v2',
        messageHash: originTransaction.transactionHash,
      };
    }
  }

  private async pollAttestation(messageHash: string, domain: string): Promise<boolean> {
    if (this.version === 'v1') {
      // V1: https://iris-api.circle.com/attestations/{messageHash}
      try {
        const response = await fetch(`https://iris-api.circle.com/attestations/${messageHash}`);
        if (!response.ok) {
          // 404 is expected when attestation isn't ready yet
          if (response.status === 404) {
            return false;
          }
          throw new Error(`Attestation fetch failed with status: ${response.status}`);
        }
        const attestationResponse = await response.json();
        return attestationResponse.status === 'complete';
      } catch (e) {
        // Network errors or other issues
        this.logger.warn(`Failed to poll attestation: ${e}`);
        return false;
      }
    } else {
      // V2: https://iris-api.circle.com/v2/messages/{domain}?transactionHash={messageHash}
      try {
        const axios = (await import('axios')).default;
        const url = `https://iris-api.circle.com/v2/messages/${domain}?transactionHash=${messageHash}`;
        const response = await axios.get(url);
        return response.data?.messages?.[0]?.status === 'complete';
      } catch (e: any) {
        // 404 is expected when attestation isn't ready yet
        if (e.response?.status === 404) {
          return false;
        }
        // Log other errors but don't throw
        this.logger.warn(`Failed to poll attestation: ${e.message || e}`);
        return false;
      }
    }
  }

  /// @notice Attestation query for V1 uses messageHash and V2 uses transactionHash
  private async fetchAttestation(
    messageHash: string,
    domain: string,
  ): Promise<{ messageBytes: string; attestation: string }> {
    if (this.version === 'v1') {
      // V1: https://iris-api.circle.com/attestations/{messageHash}
      try {
        const response = await fetch(`https://iris-api.circle.com/attestations/${messageHash}`);
        if (!response.ok) throw new Error('Attestation fetch failed');
        const attestationResponse = await response.json();
        if (attestationResponse.status === 'complete') {
          return {
            messageBytes: 'v1',
            attestation: attestationResponse.attestation,
          };
        } else {
          throw new Error('Attestation not complete');
        }
      } catch (e) {
        throw new Error(`Attestation fetch failed: ${e}`);
      }
    } else {
      // V2: https://iris-api.circle.com/v2/messages/{domain}?transactionHash={transactionHash}
      try {
        const axios = (await import('axios')).default;
        const url = `https://iris-api.circle.com/v2/messages/${domain}?transactionHash=${messageHash}`;
        const response = await axios.get(url);
        if (response.data?.messages?.[0]?.status === 'complete') {
          return {
            messageBytes: response.data.messages[0].message,
            attestation: response.data.messages[0].attestation,
          };
        } else {
          throw new Error('Attestation not complete');
        }
      } catch (e) {
        throw new Error(`Attestation fetch failed: ${e}`);
      }
    }
  }
}
