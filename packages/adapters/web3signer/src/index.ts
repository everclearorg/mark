import { Signer, providers, utils, Bytes, TypedDataDomain, TypedDataField } from 'ethers5';
import { Web3SignerApi } from './api';
import { publicKeyToAddress } from 'viem/accounts';

export class Web3Signer extends Signer {
  private static MESSAGE_PREFIX = '\x19Ethereum Signed Message:\n';

  private static getAddressFromPublicKey(publicKey: string): string {
    return publicKeyToAddress(publicKey as `0x${string}`);
  }

  private static prepareEthereumSignedMessage(message: Bytes | string): Bytes {
    if (typeof message === 'string') {
      message = utils.toUtf8Bytes(message);
    }
    return utils.concat([
      utils.toUtf8Bytes(Web3Signer.MESSAGE_PREFIX),
      utils.toUtf8Bytes(message.length.toString()),
      message,
    ]);
  }

  public address?: string;
  public provider?: providers.Provider;
  private readonly api: Web3SignerApi;

  constructor(
    public readonly web3SignerUrl: string,
    provider?: providers.Provider,
  ) {
    super();
    this.web3SignerUrl = web3SignerUrl;
    this.provider = provider;
    this.api = new Web3SignerApi(web3SignerUrl);
  }

  public connect(provider: providers.Provider): Web3Signer {
    this.provider = provider;
    return new Web3Signer(this.web3SignerUrl, provider);
  }

  public async getAddress(): Promise<string> {
    const publicKey = await this.api.getPublicKey();
    const address = Web3Signer.getAddressFromPublicKey(publicKey);
    this.address = address;
    return address;
  }

  public async signMessage(message: Bytes | string): Promise<string> {
    const identifier = await this.api.getPublicKey();
    const data = Web3Signer.prepareEthereumSignedMessage(message);
    const digestBytes = utils.hexZeroPad(data, data.length);

    return await this.api.sign(identifier, digestBytes);
  }

  public async signTransaction(transaction: providers.TransactionRequest): Promise<string> {
    const tx = await utils.resolveProperties(transaction);
    const baseTx: utils.UnsignedTransaction = Object.assign(
      {
        to: tx.to || undefined,
        nonce: tx.nonce ? +tx.nonce.toString() : undefined,
        gasLimit: tx.gasLimit || undefined,
        data: tx.data || undefined,
        value: tx.value || undefined,
        chainId: tx.chainId || undefined,
      },
      // If an EIP-1559 transaction, use the EIP-1559 specific fields.
      tx.type === 2
        ? {
            maxFeePerGas: tx.maxFeePerGas,
            maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
            type: 2,
          }
        : {
            gasPrice: tx.gasPrice,
            type: 0,
          },
    );

    const identifier = await this.api.getPublicKey();
    const digestBytes = utils.serializeTransaction(baseTx);

    const signature = await this.api.sign(identifier, digestBytes);
    return utils.serializeTransaction(baseTx, signature);
  }

  public async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, Array<TypedDataField>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    // Get the public key/address to sign with
    const identifier = await this.api.getPublicKey();

    // Determine the primaryType (the main message type, excluding EIP712Domain)
    const primaryType = Object.keys(types).find((key) => key !== 'EIP712Domain') || '';

    // Construct the complete typedData object according to EIP-712
    const typedData = {
      types,
      primaryType,
      domain: domain as unknown as Record<string, string>,
      message: value as unknown as Record<string, string>,
    };

    return await this.api.signTypedData(identifier, typedData);
  }

  public async sendTransaction(transaction: providers.TransactionRequest): Promise<providers.TransactionResponse> {
    // exclude funcSig
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
    const { funcSig, ...tx } = transaction as unknown as any;
    return await super.sendTransaction(tx);
  }
}
