import { NxtpError, axiosPost, axiosGet } from '@connext/nxtp-utils';
import { Bytes } from 'ethers';

// TODO: This class might benefit from some error handling / logging and response sanitization logic.
/**
 * Simple class for wrapping axios calls to the web3signer API.
 */
export class Web3SignerApi {
  private static ENDPOINTS = {
    SIGN: 'api/v1/eth1/sign',
    SERVER_STATUS: 'upcheck',
    PUBLIC_KEY: 'api/v1/eth1/publicKeys'
  };

  private static JSON_RPC_METHODS = {
    SIGN_TYPED_DATA: 'eth_signTypedData',
  };

  constructor(private readonly url: string) {}

  public async sign(identifier: string, data: string | Bytes): Promise<string> {
    const endpoint = Web3SignerApi.ENDPOINTS.SIGN;
    let response = await axiosPost(this.formatUrl(endpoint, identifier), {
      data,
    });
    response = this.sanitizeResponse(response, endpoint);
    return response.data;
  }

  public async getServerStatus(): Promise<string> {
    const endpoint = Web3SignerApi.ENDPOINTS.SERVER_STATUS;
    let response = await axiosGet(this.formatUrl(endpoint));
    response = this.sanitizeResponse(response, endpoint);
    return response.data[0];
  }

  public async getPublicKey(): Promise<string> {
    const endpoint = Web3SignerApi.ENDPOINTS.PUBLIC_KEY;
    let response = await axiosGet(this.formatUrl(endpoint));
    response = this.sanitizeResponse(response, endpoint);
    return response.data[0];
  }

  public async signTypedData(
    identifier: string,
    typedData: {
      types: Record<string, Array<{ name: string; type: string }>>;
      primaryType: string;
      domain: Record<string, any>;
      message: Record<string, any>;
    }
  ): Promise<string> {
    const payload = {
      jsonrpc: "2.0",
      method: Web3SignerApi.JSON_RPC_METHODS.SIGN_TYPED_DATA,
      params: [identifier, typedData],
      id: 1
    };
    
    let response = await axiosPost(this.url, payload);
    
    if (!response || !response.data || !response.data.result) {
      throw new NxtpError(
        'Received bad response from web3signer instance for signTypedData.',
        { response }
      );
    }
    
    return response.data.result;
  }

  private formatUrl(
    endpoint: (typeof Web3SignerApi.ENDPOINTS)[keyof typeof Web3SignerApi.ENDPOINTS],
    identifier?: string,
  ): string {
    let url = `${this.url}/${endpoint}`;
    if (identifier) {
      url += `/${identifier}`;
    }
    return url;
  }

  private sanitizeResponse(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response: any,
    endpoint: (typeof Web3SignerApi.ENDPOINTS)[keyof typeof Web3SignerApi.ENDPOINTS],
  ) {
    if (!response || !response.data || response.data.length === 0) {
      throw new NxtpError(
        'Received bad response from web3signer instance; make sure your key file is configured correctly.',
        {
          response,
          endpoint,
        },
      );
    }
    return response;
  }
}
