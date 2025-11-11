import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import axios from 'axios';
import { CoinbaseApiResponse, CoinbaseTx, CoinbaseDepositAccount } from './types';

export class CoinbaseClient {
  private static instances: Map<string, CoinbaseClient> = new Map();
  private static initializationPromises: Map<string, Promise<CoinbaseClient>> = new Map();

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly allowedRecipients: string[];
  private isValidated: boolean = false;

  // this is intended to remain in-memory for debugging/review purposes.
  // currently has no functional importance beyond that
  private accountSummary: {
    accounts: Array<{
      name?: string;
      id: string;
      type?: string;
      currency: string;
      balance: string;
    }>;
    addresses: Array<{
      accountName?: string;
      address: string;
      id: string;
      network?: string;
      transactionCount: number;
    }>;
  } = { accounts: [], addresses: [] };

  private constructor({
    apiKey,
    apiSecret,
    allowedRecipients,
    baseUrl = 'https://api.coinbase.com',
    skipValidation = false,
  }: {
    apiKey: string;
    apiSecret: string;
    allowedRecipients: string[];
    baseUrl?: string;
    skipValidation?: boolean;
  }) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.allowedRecipients = allowedRecipients.map((addr) => addr.toLowerCase());
    this.baseUrl = baseUrl;

    if (!skipValidation) {
      void this.validateConnection();
      void this.validateAccounts();
    } else {
      this.isValidated = true;
    }
  }

  /**
   * Get or create a validated CoinbaseClient instance for the given API credentials.
   * Returns an existing instance if one exists for the same apiKey and baseUrl combination,
   * otherwise creates a new instance and validates it before returning.
   *
   * @param apiKey - Coinbase API key identifier
   * @param apiSecret - Coinbase API secret key
   * @param allowedRecipients - Array of recipient addresses allowed for transactions
   * @param baseUrl - Base URL for Coinbase API (defaults to production API)
   * @returns Promise<CoinbaseClient> - Validated client instance ready for use
   */
  public static async getInstance({
    apiKey,
    apiSecret,
    allowedRecipients,
    baseUrl = 'https://api.coinbase.com',
    skipValidation = false,
  }: {
    apiKey: string;
    apiSecret: string;
    allowedRecipients: string[];
    baseUrl?: string;
    skipValidation?: boolean;
  }): Promise<CoinbaseClient> {
    const instanceKey = `${apiKey}-${baseUrl}-${skipValidation}`;

    if (CoinbaseClient.instances.has(instanceKey)) {
      return CoinbaseClient.instances.get(instanceKey)!;
    }

    if (CoinbaseClient.initializationPromises.has(instanceKey)) {
      return CoinbaseClient.initializationPromises.get(instanceKey)!;
    }

    const initPromise = (async () => {
      const instance = new CoinbaseClient({
        apiKey,
        apiSecret,
        allowedRecipients,
        baseUrl,
        skipValidation,
      });

      if (!skipValidation) {
        instance.isValidated = true;
      }
      CoinbaseClient.instances.set(instanceKey, instance);
      CoinbaseClient.initializationPromises.delete(instanceKey);

      return instance;
    })();

    CoinbaseClient.initializationPromises.set(instanceKey, initPromise);
    return initPromise;
  }

  /**
   * Check if the client is properly configured with API credentials
   */
  public isConfigured(): boolean {
    return this.isValidated;
  }

  /**
   * Generate JWT token for Coinbase API authentication
   */
  private generateJWT(method: string, path: string): string {
    const requestMethod = method.toUpperCase();
    const requestHost = 'api.coinbase.com';
    const requestPath = path;
    const algorithm = 'ES256';
    const uri = `${requestMethod} ${requestHost}${requestPath}`;

    const payload = {
      iss: 'cdp',
      nbf: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 120,
      sub: this.apiKey,
      uri,
    };

    const header = {
      alg: algorithm,
      kid: this.apiKey,
      nonce: crypto.randomBytes(16).toString('hex'),
    };

    return jwt.sign(payload, this.apiSecret, { algorithm, header });
  }

  /**
   * General-purpose page crawler for paginated Coinbase API endpoints
   * @param params.initialRequest - The initial request parameters
   * @param params.condition - Optional condition function to stop pagination early (returns true to stop)
   * @param params.maxResults - Optional maximum number of results to examine (default: 200)
   * @returns Promise with all collected results and final pagination state
   */
  private async pageCrawler<T>(params: {
    initialRequest: {
      method: string;
      path: string;
      body?: Record<string, unknown>;
    };
    condition?: (item: T, allItems: T[]) => boolean;
    maxResults?: number;
  }): Promise<{
    data: T[];
    pagination: {
      ending_before?: string;
      starting_after?: string;
      limit: number;
      order: string;
      previous_uri?: string;
      next_uri?: string;
    };
    stoppedEarly?: boolean;
    reason?: string;
  }> {
    const { initialRequest, condition, maxResults = 200 } = params;
    const allResults: T[] = [];
    let examined = 0;
    let startingAfter: string | undefined = undefined;

    // Make initial request
    const bodyParams: Record<string, string> = {
      ...(initialRequest.body || {}),
      limit: '100',
    };
    if (startingAfter) {
      bodyParams.starting_after = startingAfter;
    }

    let response = await this.makeRequest<T[]>({
      ...initialRequest,
      body: bodyParams,
    });

    // Process first page
    const firstPageData = Array.isArray(response.data) ? response.data : [];
    allResults.push(...firstPageData);
    examined += firstPageData.length;

    // Check condition on first page
    if (condition) {
      for (const item of firstPageData) {
        if (condition(item, allResults)) {
          return {
            data: allResults,
            pagination: {
              ending_before: undefined,
              starting_after: undefined,
              limit: 100,
              order: 'desc',
              previous_uri: undefined,
              next_uri: undefined,
            },
            stoppedEarly: true,
            reason: 'Condition met',
          };
        }
      }
    }

    // Continue paginating while there's a next_starting_after and we haven't hit limits
    while (response.pagination?.next_starting_after && examined < maxResults) {
      startingAfter = response.pagination.next_starting_after;

      const nextBodyParams: Record<string, string> = {
        ...(initialRequest.body || {}),
        limit: '100',
        starting_after: startingAfter,
      };

      response = await this.makeRequest<T[]>({
        ...initialRequest,
        body: nextBodyParams,
      });

      const pageData = Array.isArray(response.data) ? response.data : [];
      allResults.push(...pageData);
      examined += pageData.length;

      // Check condition on each page
      if (condition) {
        for (const item of pageData) {
          if (condition(item, allResults)) {
            return {
              data: allResults,
              pagination: {
                ending_before: undefined,
                starting_after: undefined,
                limit: 100,
                order: 'desc',
                previous_uri: undefined,
                next_uri: undefined,
              },
              stoppedEarly: true,
              reason: 'Condition met',
            };
          }
        }
      }
    }

    return {
      data: allResults,
      pagination: {
        ending_before: undefined,
        starting_after: undefined,
        limit: 100,
        order: 'desc',
        previous_uri: undefined,
        next_uri: undefined,
      },
      stoppedEarly: examined >= maxResults,
      reason: examined >= maxResults ? 'Max results reached' : 'All pages processed',
    };
  }

  /**
   * Wrapper for authenticated request to Coinbase API
   * @param params.method - The HTTP method (GET, POST)
   * @param params.path - The API endpoint path
   * @param params.body - The request body data (optional). For GET requests, this can contain query parameters.
   */
  private async makeRequest<T>(params: {
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }): Promise<CoinbaseApiResponse<T>> {
    const { method, path, body } = params;

    // Handle query parameters for GET requests
    let finalPath = path;
    let requestBody: Record<string, unknown> | undefined = undefined;

    if (method.toUpperCase() === 'GET' && body && typeof body === 'object') {
      // Validate that all query parameters are strings
      for (const [key, value] of Object.entries(body)) {
        if (typeof value !== 'string') {
          throw new Error(`Query parameter "${key}" must be a string, got ${typeof value}`);
        }
      }

      // Convert body object to query string
      const queryParams = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        queryParams.append(key, value as string);
      }

      const queryString = queryParams.toString();
      finalPath = queryString ? `${path}?${queryString}` : path;
    } else if (body && method.toUpperCase() !== 'GET') {
      requestBody = body;
    }

    // Generate JWT using the original path (without query parameters)
    const jwt = this.generateJWT(method, path);

    const url = `${this.baseUrl}${finalPath}`;

    // DEV: useful to get an executable curl version of the request
    // console.log(`curl -X ${method} '${url}' \\
    //   -H 'Authorization: Bearer ${jwt}' \\
    //   -H 'Content-Type: application/json'${requestBody ? ` \\
    //   -d '${JSON.stringify(requestBody)}'` : ''}`);

    try {
      const response = await axios({
        method,
        url,
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
        data: requestBody,
      });

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Coinbase API error: ${error.response?.status} ${error.response?.statusText} - ${JSON.stringify(error.response?.data)}`,
        );
      }
      throw error;
    }
  }

  /**
   *  List wallet accounts with full pagination support
   */
  public async getAccounts(): Promise<
    CoinbaseApiResponse<
      Array<{
        id: string;
        name?: string;
        type?: string;
        currency: {
          code: string;
          name: string;
        };
        balance: {
          amount: string;
          currency: string;
        };
      }>
    >
  > {
    const result = await this.pageCrawler<{
      id: string;
      name?: string;
      type?: string;
      currency: {
        code: string;
        name: string;
      };
      balance: {
        amount: string;
        currency: string;
      };
    }>({
      initialRequest: {
        method: 'GET',
        path: '/v2/accounts',
      },
      maxResults: 9999,
    });

    return {
      data: result.data,
      pagination: result.pagination,
    };
  }

  /**
   *  List addresses for a wallet account with full pagination support
   */
  public async listAddresses(
    accountId: string,
  ): Promise<CoinbaseApiResponse<Array<{ id: string; address: string; name?: string; network?: string }>>> {
    const result = await this.pageCrawler<{ id: string; address: string; name?: string; network?: string }>({
      initialRequest: {
        method: 'GET',
        path: `/v2/accounts/${accountId}/addresses`,
      },
    });

    return {
      data: result.data,
      pagination: result.pagination,
    };
  }

  /**
   *  Show a single on-chain address for a wallet account
   */
  public async showAddress(
    accountId: string,
    addressId: string,
  ): Promise<CoinbaseApiResponse<{ id: string; address: string; name?: string; network?: string }>> {
    return this.makeRequest<{ id: string; address: string; name?: string; network?: string }>({
      method: 'GET',
      path: `/v2/accounts/${accountId}/addresses/${addressId}`,
    });
  }

  /**
   *  List transactions (fully typed) that have been sent to a specific account
   *  Docs: https://docs.cdp.coinbase.com/coinbase-app/transfer-apis/onchain-addresses
   */
  public async listTransactions(
    accountId: string,
    params?: { limit?: number; order?: 'asc' | 'desc'; starting_after?: string; ending_before?: string },
  ): Promise<CoinbaseApiResponse<Array<CoinbaseTx>>> {
    const queryParams: Record<string, string> = {};
    if (params?.limit !== undefined) queryParams.limit = String(params.limit);
    if (params?.order) queryParams.order = params.order;
    if (params?.starting_after) queryParams.starting_after = params.starting_after;
    if (params?.ending_before) queryParams.ending_before = params.ending_before;

    return this.makeRequest<Array<CoinbaseTx>>({
      method: 'GET',

      // note: although this version of the endpoint does seem to generally function, and is listed in the docs,
      // it appears to not accept pagination parameters & thus does not work for most of our purposes which need to traverse the history
      // path: `/v2/accounts/${accountId}/addresses/${addressId}/transactions`,

      // instead, this account-level version *does* seem to support pagination, although it is not address-specific
      // also note that no address indicator is returned, so it appears impossible to filter address from the responses
      path: `/v2/accounts/${accountId}/transactions`,

      body: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    });
  }

  /**
   * Find a transaction by its on-chain hash by walking paginated results.
   * NOTE: search is insensitive to 0x prefix or casing
   * Pages through 100 results at a time using next_starting_after until found or the
   * examined results exceed the provided ceiling.
   * Defaults to examining up to 200 results.
   * @param accountId - The Coinbase ID of the account
   * @param addressId - The Coinbase ID of the address
   * @param txHash - The hash of the transaction to search for
   * @param maxExamined - The maximum number of historical results to examine before aborting
   * @returns The CoinbaseTx object if found, null otherwise
   */
  public async getTransactionByHash(
    accountId: string,
    addressId: string,
    txHash: string,
    maxExamined: number = 200,
  ): Promise<CoinbaseTx | null> {
    // Normalize hash by removing 0x prefix and converting to lowercase
    const normalizedHash = txHash.toLowerCase().replace('0x', '');

    // Helper to check if a transaction matches the target hash
    const isTargetTransaction = (tx: CoinbaseTx): boolean => {
      const anyTx = tx;
      const candidateHash = anyTx?.network?.hash;

      if (candidateHash && typeof candidateHash === 'string') {
        // Normalize candidate hash same way for comparison
        const normalizedCandidate = candidateHash.toLowerCase().replace('0x', '');
        return normalizedCandidate === normalizedHash;
      }
      return false;
    };

    const result = await this.pageCrawler<CoinbaseTx>({
      initialRequest: {
        method: 'GET',
        path: `/v2/accounts/${accountId}/addresses/${addressId}/transactions`,
      },
      condition: isTargetTransaction,
      maxResults: maxExamined,
    });

    // If we stopped early due to condition being met, return the found transaction
    if (result.stoppedEarly && result.reason === 'Condition met') {
      // Find the matching transaction in the results
      for (const tx of result.data) {
        if (isTargetTransaction(tx)) {
          return tx;
        }
      }
    }

    return null;
  }

  private coinbaseNetworks: Record<string, { chainId: string; networkGroup: string }> = {
    ethereum: { chainId: '1', networkGroup: 'ethereum' },
    optimism: { chainId: '10', networkGroup: 'ethereum' },
    unichain: { chainId: '130', networkGroup: 'ethereum' },
    polygon: { chainId: '137', networkGroup: 'ethereum' },
    base: { chainId: '8453', networkGroup: 'ethereum' },
    arbitrum: { chainId: '42161', networkGroup: 'ethereum' },
    avalanche: { chainId: '43114', networkGroup: 'ethereum' },
    solana: { chainId: '1399811149', networkGroup: 'solana' },
  };

  private supportedAssets: Record<
    string,
    { supportedNetworks: Record<string, { chainId: string; networkGroup: string }>; accountId?: string }
  > = {
    USDC: {
      supportedNetworks: {
        ethereum: this.coinbaseNetworks.ethereum,
        base: this.coinbaseNetworks.base,
        optimism: this.coinbaseNetworks.optimism,
        unichain: this.coinbaseNetworks.unichain,
        polygon: this.coinbaseNetworks.polygon,
        arbitrum: this.coinbaseNetworks.arbitrum,
        avalanche: this.coinbaseNetworks.avalanche,
        solana: this.coinbaseNetworks.solana,
      },
    },
    EURC: {
      supportedNetworks: {
        ethereum: this.coinbaseNetworks.ethereum,
        base: this.coinbaseNetworks.base,
        solana: this.coinbaseNetworks.solana,
      },
    },
    ETH: {
      supportedNetworks: {
        ethereum: this.coinbaseNetworks.ethereum,
        base: this.coinbaseNetworks.base,
        optimism: this.coinbaseNetworks.optimism,
        unichain: this.coinbaseNetworks.unichain,
        polygon: this.coinbaseNetworks.polygon,
        arbitrum: this.coinbaseNetworks.arbitrum,
      },
    },
  };

  /**
   * Check if this client support a given asset on a given network
   * Note: List is not exhaustive of what Coinbase might support beyond this
   * @param assetSymbol The asset symbol (e.g. "USDC", "ETH")
   * @param networkTag The network tag (e.g. "ethereum", "polygon")
   * @returns boolean indicating if the asset is supported on the chain
   */
  private isSupportedAsset(assetSymbol: string, networkTag: string): boolean {
    const assetSupport = this.supportedAssets[assetSymbol as keyof typeof this.supportedAssets];

    if (!assetSupport) {
      return false;
    }

    return assetSupport.supportedNetworks[networkTag] !== undefined;
  }

  /**
   * Send Crypto (POST /v2/accounts/:account_id/transactions)
   * @param params.to Blockchain address of the recipient
   * @param params.amount Amount of currency to send, expressed in units (1.5 to send 1500000000000000000 wei of ether)
   * @param params.currency Currency code for the amount being sent
   * @param params.network Network to send on (use getCoinbaseNetwork to get the network tag for a given chain ID)
   * @param params.description Optional notes to include
   * @param params.idem Optional UUIDv4 token for idempotence
   * @param params.skip_notifications Optional flag to disable notification emails
   * @param params.travel_rule_data Optional travel rule compliance data
   */
  public async sendCrypto(params: {
    to: string;
    units: string;
    currency: string;
    network: string;
    description?: string;
    idem?: string;
    skip_notifications?: boolean;
    travel_rule_data?: Record<string, unknown>;
  }): Promise<CoinbaseApiResponse<{ id: string; type: string; status: string }>> {
    if (!this.isSupportedAsset(params.currency, params.network)) {
      throw new Error(`Currency "${params.currency}" on network "${params.network}" is not supported`);
    }

    // Validate account id exists for the currency (Redundant from validateConnection checks)
    const assetInfo = this.supportedAssets[params.currency];
    if (!assetInfo?.accountId) {
      throw new Error(`No account found for currency "${params.currency}". `);
    }

    // Validate recipient address is in allowed list
    const recipientLower = params.to.toLowerCase();
    if (!this.allowedRecipients.includes(recipientLower)) {
      throw new Error(`Recipient address "${params.to}" is not in the configured allowed recipients list`);
    }

    const body = {
      type: 'send',
      to: params.to,
      amount: params.units,
      currency: params.currency,
      network: params.network,
      idem: params.idem,
      ...(params.description && { description: params.description }),
      ...(params.skip_notifications && { skip_notifications: params.skip_notifications }),
      ...(params.travel_rule_data && { travel_rule_data: params.travel_rule_data }),
    };

    return this.makeRequest<{ id: string; type: string; status: string }>({
      method: 'POST',
      path: `/v2/accounts/${assetInfo.accountId}/transactions`,
      body,
    });
  }

  /**
   * Get withdrawal fee estimate from Coinbase Exchange API
   * Note: This uses the exchange API which requires different authentication than the regular v2 API
   * @param params.currency The currency code (e.g. 'ETH')
   * @param params.cryptoAddress The destination crypto address
   * @returns Fee estimate in the withdrawal currency
   */
  public async getWithdrawalFee(params: {
    currency: string;
    crypto_address: string;
    network: string;
  }): Promise<string> {
    const timestamp = Date.now() / 1000;
    const method = 'GET';
    const path = '/withdrawals/fee-estimate';
    const queryParams = new URLSearchParams({
      currency: params.currency,
      crypto_address: params.crypto_address,
      network: params.network,
    }).toString();

    const requestPath = `${path}?${queryParams}`;

    // Exchange API uses different auth mechanism than v2
    const response = await fetch(`https://api.exchange.coinbase.com${requestPath}`, {
      method,
      headers: {
        'CB-ACCESS-KEY': this.apiKey,
        'CB-ACCESS-TIMESTAMP': timestamp.toString(),
        'CB-ACCESS-SIGN': this.generateExchangeSignature(timestamp, method, requestPath),
        'CB-ACCESS-PASSPHRASE': this.apiSecret,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get withdrawal fee: ${response.statusText}`);
    }

    const data = await response.json();
    return data.fee;
  }

  /**
   * Generate signature for Exchange API authentication
   */
  private generateExchangeSignature(timestamp: number, method: string, requestPath: string): string {
    const message = timestamp + method + requestPath;
    const key = Buffer.from(this.apiSecret, 'base64');
    return crypto.createHmac('sha256', key).update(message).digest('base64');
  }

  /**
   * Map chain ID to Coinbase network information
   * Note: This is not exhaustive of what networks Coinbase might support beyond this
   */
  public getCoinbaseNetwork(chainId: string | bigint | number): {
    chainId: string;
    networkLabel: string;
    networkGroup: string;
  } {
    const chainIdStr = typeof chainId === 'bigint' || typeof chainId === 'number' ? chainId.toString() : chainId;

    const coinbaseNetwork = Object.values(this.coinbaseNetworks).find((n) => n.chainId === chainIdStr);

    const keyIndex = Object.entries(this.coinbaseNetworks).find(([, network]) => network.chainId === chainIdStr)?.[0];

    if (!coinbaseNetwork || !keyIndex) {
      throw new Error(`Unsupported chain ID: ${chainIdStr}`);
    }

    return {
      ...coinbaseNetwork,
      networkLabel: keyIndex,
    };
  }

  /**
   * Validate API authentication & connectivity
   */
  public async validateConnection(): Promise<boolean> {
    try {
      // A lightweight call is enough to validate auth/connectivity
      await this.getAccounts();
      return true;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Validate Coinbase accounts for supported assets and prepare an account summary.
   * These are high-level checks to confirm general system liveness before client is used further.
   */
  private async validateAccounts(): Promise<boolean> {
    const accountList = await this.getAccounts();

    // Populate accountId for each supported asset and build accounts summary
    const accountsSummary: Array<{
      name?: string;
      id: string;
      type?: string;
      currency: string;
      balance: string;
    }> = [];

    for (const account of accountList.data) {
      accountsSummary.push({
        name: account.name,
        id: account.id,
        type: account.type,
        currency: account.currency.code,
        balance: `${account.balance.amount} ${account.balance.currency}`,
      });
    }

    // system expects CB "accounts" to be preconfigured. It does not set them up on its own.
    // It expects one account per supported asset.
    for (const assetSymbol of Object.keys(this.supportedAssets)) {
      const matchingAccounts = accountList.data.filter((account) => account.currency.code === assetSymbol);

      if (matchingAccounts.length === 0) {
        throw new Error(
          `A Coinbase "account" must exist for each supported asset. No account found for currency "${assetSymbol}". `,
        );
      }

      if (matchingAccounts.length > 1) {
        throw new Error(
          `Multiple accounts found for supported asset "${assetSymbol}". Expected exactly one account per supported asset. Found accounts: ${matchingAccounts.map((acc) => acc.id).join(', ')}`,
        );
      }

      this.supportedAssets[assetSymbol].accountId = matchingAccounts[0].id;
    }

    // For supported accounts, collect address details for debugger visibility
    const addressesSummary: Array<{
      accountName?: string;
      address: string;
      id: string;
      network?: string;
      transactionCount: number;
    }> = [];

    for (const account of accountList.data) {
      if (!this.supportedAssets[account.currency.code]) {
        continue;
      }

      let addresses;
      try {
        addresses = await this.listAddresses(account.id);
      } catch (error) {
        if (error instanceof Error && error.message.includes('500 Internal Server Error')) {
          addresses = { data: [] };
        } else {
          throw error;
        }
      }

      if (!Array.isArray(addresses.data)) {
        throw new Error(`No address details found for account: ${account.name}`);
      }

      for (const addr of addresses.data) {
        const details = await this.showAddress(account.id, addr.id);
        const txs = await this.listTransactions(account.id, { limit: 100 });
        const txCount = Array.isArray(txs.data) ? txs.data.length : 0;

        addressesSummary.push({
          accountName: account.name,
          address: details.data.address,
          id: details.data.id,
          network: details.data.network,
          transactionCount: txCount,
        });
      }
    }

    this.accountSummary = { accounts: accountsSummary, addresses: addressesSummary };
    return true;
  }
  /**
   * Get a withdrawal transaction by its ID
   * @param accountId - The Coinbase account ID
   * @param withdrawalId - The withdrawal transaction ID
   * @returns The withdrawal transaction details or null if not found
   */
  public async getWithdrawalById(accountId: string, withdrawalId: string): Promise<CoinbaseTx | null> {
    try {
      const response = await this.makeRequest<CoinbaseTx>({
        method: 'GET',
        path: `/v2/accounts/${accountId}/transactions/${withdrawalId}`,
      });

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get the single pre-existing deposit address and account details from Coinbase for the given asset and network.
   * NOTE: This method queries the API each time (intentionally does not use anything cached).
   */
  public async getDepositAccount(assetSymbol: string, network: string): Promise<CoinbaseDepositAccount> {
    if (!this.isSupportedAsset(assetSymbol, network)) {
      throw new Error(`Currency "${assetSymbol}" on network "${network}" is not supported`);
    }

    const accounts = await this.getAccounts();
    const account = accounts.data.find((a) => a.currency.code === assetSymbol);
    if (!account) {
      throw new Error(`No Coinbase account found for currency "${assetSymbol}"`);
    }

    let addressesResponse: CoinbaseApiResponse<Array<{ id: string; address: string; name?: string; network?: string }>>;
    try {
      addressesResponse = await this.listAddresses(account.id);
    } catch (error) {
      if (error instanceof Error && error.message.includes('500 Internal Server Error')) {
        addressesResponse = { data: [] } as CoinbaseApiResponse<
          Array<{ id: string; address: string; name?: string; network?: string }>
        >;
      } else {
        throw error;
      }
    }

    for (const addr of addressesResponse.data) {
      const details = await this.showAddress(account.id, addr.id);
      const addrNetwork = (details.data as Record<string, unknown>).network as string | undefined;

      // match network by group.
      // EG: a deposit address for "ethereum" can be used for "ethereum", "base", "optimism", etc. via networkGroup
      if (addrNetwork === this.supportedAssets[assetSymbol].supportedNetworks[network].networkGroup) {
        return {
          accountId: account.id,
          accountName: account.name,
          currencyCode: account.currency.code,
          addressId: details.data.id,
          address: details.data.address,
          network: addrNetwork,
        };
      }
    }

    throw new Error(`No deposit address available for ${assetSymbol} on ${network}`);
  }
}
