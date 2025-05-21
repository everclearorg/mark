import { axiosGet } from './axios';
import { config } from 'dotenv';
import {
  EverclearConfig,
  AssetConfiguration,
  ChainConfiguration,
  Environment,
  MarkConfiguration,
  Stage,
  HubConfig,
  RebalanceConfig,
  SupportedBridge,
} from './types/config';
import { LogLevel } from './types/logging';
import { getSsmParameter } from './ssm';
import { existsSync, readFileSync } from 'fs';

config();

export class ConfigurationError extends Error {
  constructor(
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export const DEFAULT_GAS_THRESHOLD = '5000000000000000'; // 0.005 eth
export const DEFAULT_BALANCE_THRESHOLD = '0'; // 0
export const DEFAULT_INVOICE_AGE = '1';
export const EVERCLEAR_MAINNET_CONFIG_URL = 'https://raw.githubusercontent.com/connext/chaindata/main/everclear.json';
export const EVERCLEAR_TESTNET_CONFIG_URL =
  'https://raw.githubusercontent.com/connext/chaindata/main/everclear.testnet.json';
export const EVERCLEAR_MAINNET_API_URL = 'https://api.everclear.org';
export const EVERCLEAR_TESTNET_API_URL = 'https://api.testnet.everclear.org';

export const UTILITY_CONTRACTS_DEFAULT = {
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
};
export const UTILITY_CONTRACTS_OVERRIDE: Record<string, { permit2?: string; multicall3?: string }> = {
  '324': {
    permit2: '0x0000000000225e31D15943971F47aD3022F714Fa',
    multicall3: '0xF9cda624FBC7e059355ce98a31693d299FACd963',
  },
  '2020': {
    permit2: '0x771ca29e483df5447e20a89e0f00e1daf09ef534',
  },
  // '167000': {
  //   // Contract exists here but unverified: https://taikoscan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3
  //   permit2: '0x0000000000225e31D15943971F47aD3022F714Fa',
  // },
  // '33139': {
  //   // Contract exists here but unverified: https://apescan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3
  //   permit2: '0x0000000000225e31D15943971F47aD3022F714Fa',
  // },
};

export const getEverclearConfig = async (_configUrl?: string): Promise<EverclearConfig | undefined> => {
  const configUrl = _configUrl ?? EVERCLEAR_MAINNET_CONFIG_URL;

  try {
    const res = await axiosGet(configUrl);
    if (!res.data) {
      throw new Error(`Failed to retrieve config from ${configUrl}`);
    }
    // TODO: add validation of config?
    return res.data as EverclearConfig;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (err: unknown) {
    if (configUrl === EVERCLEAR_MAINNET_CONFIG_URL) {
      return undefined;
    }
    try {
      const res = await axiosGet(EVERCLEAR_MAINNET_CONFIG_URL);
      if (res.data) return res.data as EverclearConfig;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err: unknown) {
      return undefined;
    }

    return undefined;
  }
};

export const loadRebalanceRoutes = async (): Promise<RebalanceConfig> => {
  return {
    routes: [
      // arbitrum    blast   WETH    7   160
      { origin: 42161, destination: 81457, asset: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", maximum: "7000000000000000000", slippage: 160, preferences: [SupportedBridge.Across] },
      // base  blast   WETH    7   160
      { origin: 8453, destination: 81457, asset: "0x4200000000000000000000000000000000000006", maximum: "7000000000000000000", slippage: 160, preferences: [SupportedBridge.Across] },
      // linea blast   WETH    7   160
      { origin: 59144, destination: 81457, asset: "0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f", maximum: "7000000000000000000", slippage: 160, preferences: [SupportedBridge.Across] },
      // mode  blast   WETH    7   160
      { origin: 34443, destination: 81457, asset: "0x4200000000000000000000000000000000000006", maximum: "7000000000000000000", slippage: 160, preferences: [SupportedBridge.Across] },
      // optimism    blast   WETH    7   160
      { origin: 10, destination: 81457, asset: "0x4200000000000000000000000000000000000006", maximum: "7000000000000000000", slippage: 160, preferences: [SupportedBridge.Across] },
      // polygon blast   WETH    7   160
      { origin: 137, destination: 81457, asset: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", maximum: "7000000000000000000", slippage: 160, preferences: [SupportedBridge.Across] },
      // scroll    blast   WETH    7   160
      { origin: 534352, destination: 81457, asset: "0x5300000000000000000000000000000000000004", maximum: "7000000000000000000", slippage: 160, preferences: [SupportedBridge.Across] },
      // unichain    blast   WETH    7   160
      { origin: 130, destination: 81457, asset: "0x4200000000000000000000000000000000000006", maximum: "7000000000000000000", slippage: 160, preferences: [SupportedBridge.Across] },
      // zksync    blast   WETH    7   160
      { origin: 324, destination: 81457, asset: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91", maximum: "7000000000000000000", slippage: 160, preferences: [SupportedBridge.Across] },
      // ink   blast   WETH    7   160
      { origin: 57073, destination: 81457, asset: "0x4200000000000000000000000000000000000006", maximum: "7000000000000000000", slippage: 160, preferences: [SupportedBridge.Across] },
      // arbitrum    linea   WETH    7   30
      { origin: 42161, destination: 59144, asset: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", maximum: "7000000000000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // arbitrum    linea   USDC    10000   140
      { origin: 42161, destination: 59144, asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", maximum: "10000000000", slippage: 140, preferences: [SupportedBridge.Across] },
      // arbitrum    linea   USDT    10000   50
      { origin: 42161, destination: 59144, asset: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", maximum: "10000000000", slippage: 50, preferences: [SupportedBridge.Across] },
      // base  linea   WETH    7   30
      { origin: 8453, destination: 59144, asset: "0x4200000000000000000000000000000000000006", maximum: "7000000000000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // base  linea   USDC    10000   140
      { origin: 8453, destination: 59144, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maximum: "10000000000", slippage: 140, preferences: [SupportedBridge.Across] },
      // base  linea   USDT    10000   50
      { origin: 8453, destination: 59144, asset: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", maximum: "10000000000", slippage: 50, preferences: [SupportedBridge.Across] },
      // blast linea   WETH    7   30
      { origin: 81457, destination: 59144, asset: "0x4300000000000000000000000000000000000004", maximum: "7000000000000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // mode  linea   WETH    7   30
      { origin: 34443, destination: 59144, asset: "0x4200000000000000000000000000000000000006", maximum: "7000000000000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // mode  linea   USDC    10000   140
      { origin: 34443, destination: 59144, asset: "0xd988097fb8612cc24eeC14542bC03424c656005f", maximum: "10000000000", slippage: 140, preferences: [SupportedBridge.Across] },
      // mode  linea   USDT    10000   50
      { origin: 34443, destination: 59144, asset: "0xf0F161fDA2712DB8b566946122a5af183995e2eD", maximum: "10000000000", slippage: 50, preferences: [SupportedBridge.Across] },
      // optimism    linea   WETH    7   30
      { origin: 10, destination: 59144, asset: "0x4200000000000000000000000000000000000006", maximum: "7000000000000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // optimism    linea   USDC    10000   140
      { origin: 10, destination: 59144, asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", maximum: "10000000000", slippage: 140, preferences: [SupportedBridge.Across] },
      // optimism    linea   USDT    10000   50
      { origin: 10, destination: 59144, asset: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", maximum: "10000000000", slippage: 50, preferences: [SupportedBridge.Across] },
      // polygon linea   WETH    7   30
      { origin: 137, destination: 59144, asset: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", maximum: "7000000000000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // polygon linea   USDC    10000   140
      { origin: 137, destination: 59144, asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", maximum: "10000000000", slippage: 140, preferences: [SupportedBridge.Across] },
      // polygon linea   USDT    10000   50
      { origin: 137, destination: 59144, asset: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", maximum: "10000000000", slippage: 50, preferences: [SupportedBridge.Across] },
      // scroll    linea   WETH    7   30
      { origin: 534352, destination: 59144, asset: "0x5300000000000000000000000000000000000004", maximum: "7000000000000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // scroll    linea   USDC    10000   140
      { origin: 534352, destination: 59144, asset: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", maximum: "10000000000", slippage: 140, preferences: [SupportedBridge.Across] },
      // scroll    linea   USDT    10000   50
      { origin: 534352, destination: 59144, asset: "0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df", maximum: "10000000000", slippage: 50, preferences: [SupportedBridge.Across] },
      // unichain    linea   WETH    7   30
      { origin: 130, destination: 59144, asset: "0x4200000000000000000000000000000000000006", maximum: "7000000000000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // unichain    linea   USDC    10000   140
      { origin: 130, destination: 59144, asset: "0x078D782b760474a361dDA0AF3839290b0EF57AD6", maximum: "10000000000", slippage: 140, preferences: [SupportedBridge.Across] },
      // unichain    linea   USDT    10000   50
      { origin: 130, destination: 59144, asset: "0x588CE4F028D8e7B53B687865d6A67b3A54C75518", maximum: "10000000000", slippage: 50, preferences: [SupportedBridge.Across] },
      // zksync    linea   WETH    7   30
      { origin: 324, destination: 59144, asset: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91", maximum: "7000000000000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // zksync    linea   USDC    10000   140
      { origin: 324, destination: 59144, asset: "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4", maximum: "10000000000", slippage: 140, preferences: [SupportedBridge.Across] },
      // zksync    linea   USDT    10000   50
      { origin: 324, destination: 59144, asset: "0x493257fD37EDB34451f62EDf8D2a0C418852bA4C", maximum: "10000000000", slippage: 50, preferences: [SupportedBridge.Across] },
      // ink   linea   WETH    7   30
      { origin: 57073, destination: 59144, asset: "0x4200000000000000000000000000000000000006", maximum: "7000000000000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // ink   linea   USDC    10000   140
      { origin: 57073, destination: 59144, asset: "0xF1815bd50389c46847f0Bda824eC8da914045D14", maximum: "10000000000", slippage: 140, preferences: [SupportedBridge.Across] },
      // arbitrum    unichain    WETH    10  150
      { origin: 42161, destination: 130, asset: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", maximum: "10000000000000000000", slippage: 150, preferences: [SupportedBridge.Across] },
      // arbitrum    unichain    USDC    20000   30
      { origin: 42161, destination: 130, asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", maximum: "20000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // arbitrum    unichain    USDT    10000   70
      { origin: 42161, destination: 130, asset: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", maximum: "10000000000", slippage: 70, preferences: [SupportedBridge.Across] },
      // base  unichain    WETH    10  150
      { origin: 8453, destination: 130, asset: "0x4200000000000000000000000000000000000006", maximum: "10000000000000000000", slippage: 150, preferences: [SupportedBridge.Across] },
      // base  unichain    USDC    20000   30
      { origin: 8453, destination: 130, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maximum: "20000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // base  unichain    USDT    10000   70
      { origin: 8453, destination: 130, asset: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", maximum: "10000000000", slippage: 70, preferences: [SupportedBridge.Across] },
      // blast unichain    WETH    10  150
      { origin: 81457, destination: 130, asset: "0x4300000000000000000000000000000000000004", maximum: "10000000000000000000", slippage: 150, preferences: [SupportedBridge.Across] },
      // linea unichain    WETH    10  150
      { origin: 59144, destination: 130, asset: "0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f", maximum: "10000000000000000000", slippage: 150, preferences: [SupportedBridge.Across] },
      // linea unichain    USDC    20000   30
      { origin: 59144, destination: 130, asset: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", maximum: "20000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // linea unichain    USDT    10000   70
      { origin: 59144, destination: 130, asset: "0xa219439258ca9da29e9cc4ce5596924745e12b93", maximum: "10000000000", slippage: 70, preferences: [SupportedBridge.Across] },
      // mode  unichain    WETH    10  150
      { origin: 34443, destination: 130, asset: "0x4200000000000000000000000000000000000006", maximum: "10000000000000000000", slippage: 150, preferences: [SupportedBridge.Across] },
      // mode  unichain    USDC    20000   30
      { origin: 34443, destination: 130, asset: "0xd988097fb8612cc24eeC14542bC03424c656005f", maximum: "20000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // mode  unichain    USDT    10000   70
      { origin: 34443, destination: 130, asset: "0xf0F161fDA2712DB8b566946122a5af183995e2eD", maximum: "10000000000", slippage: 70, preferences: [SupportedBridge.Across] },
      // optimism    unichain    WETH    10  150
      { origin: 10, destination: 130, asset: "0x4200000000000000000000000000000000000006", maximum: "10000000000000000000", slippage: 150, preferences: [SupportedBridge.Across] },
      // optimism    unichain    USDC    20000   30
      { origin: 10, destination: 130, asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", maximum: "20000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // optimism    unichain    USDT    10000   70
      { origin: 10, destination: 130, asset: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", maximum: "10000000000", slippage: 70, preferences: [SupportedBridge.Across] },
      // polygon unichain    WETH    10  150
      { origin: 137, destination: 130, asset: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", maximum: "10000000000000000000", slippage: 150, preferences: [SupportedBridge.Across] },
      // polygon unichain    USDC    20000   30
      { origin: 137, destination: 130, asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", maximum: "20000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // polygon unichain    USDT    10000   70
      { origin: 137, destination: 130, asset: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", maximum: "10000000000", slippage: 70, preferences: [SupportedBridge.Across] },
      // scroll    unichain    WETH    10  150
      { origin: 534352, destination: 130, asset: "0x5300000000000000000000000000000000000004", maximum: "10000000000000000000", slippage: 150, preferences: [SupportedBridge.Across] },
      // scroll    unichain    USDC    20000   30
      { origin: 534352, destination: 130, asset: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", maximum: "20000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // scroll    unichain    USDT    10000   70
      { origin: 534352, destination: 130, asset: "0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df", maximum: "10000000000", slippage: 70, preferences: [SupportedBridge.Across] },
      // zksync    unichain    WETH    10  150
      { origin: 324, destination: 130, asset: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91", maximum: "10000000000000000000", slippage: 150, preferences: [SupportedBridge.Across] },
      // zksync    unichain    USDC    20000   30
      { origin: 324, destination: 130, asset: "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4", maximum: "20000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // zksync    unichain    USDT    10000   70
      { origin: 324, destination: 130, asset: "0x493257fD37EDB34451f62EDf8D2a0C418852bA4C", maximum: "10000000000", slippage: 70, preferences: [SupportedBridge.Across] },
      // ink   unichain    WETH    10  150
      { origin: 57073, destination: 130, asset: "0x4200000000000000000000000000000000000006", maximum: "10000000000000000000", slippage: 150, preferences: [SupportedBridge.Across] },
      // ink   unichain    USDC    20000   30
      { origin: 57073, destination: 130, asset: "0xF1815bd50389c46847f0Bda824eC8da914045D14", maximum: "20000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // arbitrum    zksync  WETH    7   20
      { origin: 42161, destination: 324, asset: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", maximum: "7000000000000000000", slippage: 20, preferences: [SupportedBridge.Across] },
      // arbitrum    zksync  USDC    10000   30
      { origin: 42161, destination: 324, asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", maximum: "10000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // arbitrum    zksync  USDT    10000   50
      { origin: 42161, destination: 324, asset: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", maximum: "10000000000", slippage: 50, preferences: [SupportedBridge.Across] },
      // base  zksync  WETH    7   20
      { origin: 8453, destination: 324, asset: "0x4200000000000000000000000000000000000006", maximum: "7000000000000000000", slippage: 20, preferences: [SupportedBridge.Across] },
      // base  zksync  USDC    10000   30
      { origin: 8453, destination: 324, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maximum: "10000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // base  zksync  USDT    10000   50
      { origin: 8453, destination: 324, asset: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", maximum: "10000000000", slippage: 50, preferences: [SupportedBridge.Across] },
      // blast zksync  WETH    7   20
      { origin: 81457, destination: 324, asset: "0x4300000000000000000000000000000000000004", maximum: "7000000000000000000", slippage: 20, preferences: [SupportedBridge.Across] },
      // linea zksync  WETH    7   20
      { origin: 59144, destination: 324, asset: "0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f", maximum: "7000000000000000000", slippage: 20, preferences: [SupportedBridge.Across] },
      // linea zksync  USDC    10000   30
      { origin: 59144, destination: 324, asset: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", maximum: "10000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // linea zksync  USDT    10000   50
      { origin: 59144, destination: 324, asset: "0xa219439258ca9da29e9cc4ce5596924745e12b93", maximum: "10000000000", slippage: 50, preferences: [SupportedBridge.Across] },
      // mode  zksync  WETH    7   20
      { origin: 34443, destination: 324, asset: "0x4200000000000000000000000000000000000006", maximum: "7000000000000000000", slippage: 20, preferences: [SupportedBridge.Across] },
      // mode  zksync  USDC    10000   30
      { origin: 34443, destination: 324, asset: "0xd988097fb8612cc24eeC14542bC03424c656005f", maximum: "10000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // mode  zksync  USDT    10000   50
      { origin: 34443, destination: 324, asset: "0xf0F161fDA2712DB8b566946122a5af183995e2eD", maximum: "10000000000", slippage: 50, preferences: [SupportedBridge.Across] },
      // optimism    zksync  WETH    7   20
      { origin: 10, destination: 324, asset: "0x4200000000000000000000000000000000000006", maximum: "7000000000000000000", slippage: 20, preferences: [SupportedBridge.Across] },
      // optimism    zksync  USDC    10000   30
      { origin: 10, destination: 324, asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", maximum: "10000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // optimism    zksync  USDT    10000   50
      { origin: 10, destination: 324, asset: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", maximum: "10000000000", slippage: 50, preferences: [SupportedBridge.Across] },
      // polygon zksync  WETH    7   20
      { origin: 137, destination: 324, asset: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", maximum: "7000000000000000000", slippage: 20, preferences: [SupportedBridge.Across] },
      // polygon zksync  USDC    10000   30
      { origin: 137, destination: 324, asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", maximum: "10000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // polygon zksync  USDT    10000   50
      { origin: 137, destination: 324, asset: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", maximum: "10000000000", slippage: 50, preferences: [SupportedBridge.Across] },
      // scroll    zksync  WETH    7   20
      { origin: 534352, destination: 324, asset: "0x5300000000000000000000000000000000000004", maximum: "7000000000000000000", slippage: 20, preferences: [SupportedBridge.Across] },
      // scroll    zksync  USDC    10000   30
      { origin: 534352, destination: 324, asset: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", maximum: "10000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // scroll    zksync  USDT    10000   50
      { origin: 534352, destination: 324, asset: "0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df", maximum: "10000000000", slippage: 50, preferences: [SupportedBridge.Across] },
      // unichain    zksync  WETH    7   20
      { origin: 130, destination: 324, asset: "0x4200000000000000000000000000000000000006", maximum: "7000000000000000000", slippage: 20, preferences: [SupportedBridge.Across] },
      // unichain    zksync  USDC    10000   30
      { origin: 130, destination: 324, asset: "0x078D782b760474a361dDA0AF3839290b0EF57AD6", maximum: "10000000000", slippage: 30, preferences: [SupportedBridge.Across] },
      // unichain    zksync  USDT    10000   50
      { origin: 130, destination: 324, asset: "0x588CE4F028D8e7B53B687865d6A67b3A54C75518", maximum: "10000000000", slippage: 50, preferences: [SupportedBridge.Across] },
      // ink   zksync  WETH    7   20
      { origin: 57073, destination: 324, asset: "0x4200000000000000000000000000000000000006", maximum: "7000000000000000000", slippage: 20, preferences: [SupportedBridge.Across] },
      // ink   zksync  USDC    10000   30
      { origin: 57073, destination: 324, asset: "0xF1815bd50389c46847f0Bda824eC8da914045D14", maximum: "10000000000", slippage: 30, preferences: [SupportedBridge.Across] },
    ],
  };
};

export async function loadConfiguration(): Promise<MarkConfiguration> {
  try {
    const environment = ((await fromEnv('ENVIRONMENT')) ?? 'local') as Environment;
    const url = environment === 'mainnet' ? EVERCLEAR_MAINNET_CONFIG_URL : EVERCLEAR_TESTNET_CONFIG_URL;
    const apiUrl = environment === 'mainnet' ? EVERCLEAR_MAINNET_API_URL : EVERCLEAR_TESTNET_API_URL;

    const hostedConfig = await getEverclearConfig(url);

    const configStr = await fromEnv('MARK_CONFIG_' + environment.toUpperCase(), true);
    const configJson = existsSync('config.json')
      ? JSON.parse(readFileSync('config.json', 'utf8'))
      : JSON.parse(configStr ?? '{}');

    const supportedAssets =
      configJson.supportedAssets ?? parseSupportedAssets(await requireEnv('SUPPORTED_ASSET_SYMBOLS'));

    const { routes } = await loadRebalanceRoutes();

    const config: MarkConfiguration = {
      pushGatewayUrl: configJson.pushGatewayUrl ?? (await requireEnv('PUSH_GATEWAY_URL')),
      web3SignerUrl: configJson.web3SignerUrl ?? (await requireEnv('SIGNER_URL')),
      everclearApiUrl: configJson.everclearApiUrl ?? (await fromEnv('EVERCLEAR_API_URL')) ?? apiUrl,
      relayer: {
        url: configJson?.relayer?.url ?? (await fromEnv('RELAYER_URL')) ?? undefined,
        key: configJson?.relayer?.key ?? (await fromEnv('RELAYER_API_KEY')) ?? undefined,
      },
      redis: configJson.redis ?? {
        host: await requireEnv('REDIS_HOST'),
        port: parseInt(await requireEnv('REDIS_PORT')),
      },
      ownAddress: configJson.signerAddress ?? (await requireEnv('SIGNER_ADDRESS')),
      supportedSettlementDomains:
        configJson.supportedSettlementDomains ??
        parseSettlementDomains(await requireEnv('SUPPORTED_SETTLEMENT_DOMAINS')),
      supportedAssets,
      chains: await parseChainConfigurations(hostedConfig, supportedAssets, configJson),
      logLevel: ((await fromEnv('LOG_LEVEL')) ?? 'debug') as LogLevel,
      stage: ((await fromEnv('STAGE')) ?? 'development') as Stage,
      environment,
      hub: configJson.hub ?? parseHubConfigurations(hostedConfig, environment),
      routes,
    };

    validateConfiguration(config);
    return config;
  } catch (_error: unknown) {
    const error = _error as Error;
    throw new ConfigurationError('Failed to load configuration: ' + error.message, { error: JSON.stringify(error) });
  }
}

function validateConfiguration(config: MarkConfiguration): void {
  if (!config.web3SignerUrl) {
    throw new ConfigurationError('Signer address is required');
  }

  if (!config.everclearApiUrl) {
    throw new ConfigurationError('Everclear API URL is required');
  }

  if (Object.keys(config.chains).length === 0) {
    throw new ConfigurationError('At least one chain configuration is required');
  }

  for (const chain of Object.keys(config.chains)) {
    const invoiceAge = config.chains[chain].invoiceAge;
    if (!invoiceAge || invoiceAge <= 0) {
      throw new ConfigurationError('Invalid invoice age for chain:' + chain);
    }
  }

  if (config.supportedSettlementDomains.length === 0) {
    throw new ConfigurationError('At least one settlement domain is required');
  }
}

export const requireEnv = async (name: string, checkSsm = false): Promise<string> => {
  const value = await fromEnv(name, checkSsm);
  if (!value) {
    throw new ConfigurationError(`Environment variable ${name} is required`);
  }
  return value;
};

export const fromEnv = async (name: string, checkSsm = false): Promise<string | undefined> => {
  let value = undefined;
  if (checkSsm) {
    value = await getSsmParameter(name);
  }
  return value ?? process.env[name];
};

function parseSettlementDomains(domains: string): number[] {
  return domains.split(',').map((domain) => parseInt(domain.trim(), 10));
}

const parseSupportedAssets = (symbols: string): string[] => {
  return symbols.split(',').map((symbol) => symbol.trim());
};

export const parseChainConfigurations = async (
  config: EverclearConfig | undefined,
  supportedAssets: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configJson: any,
): Promise<Record<string, ChainConfiguration>> => {
  // If config is undefined or doesn't have chains, we can't proceed
  if (!config?.chains) {
    throw new ConfigurationError('No chain configurations found in the Everclear config');
  }

  // Use chainIds from configJson if available, otherwise from environment variable,
  // or as a last resort, use the keys from the hosted config
  const chainIds = configJson.chains
    ? Object.keys(configJson.chains)
    : (await fromEnv('CHAIN_IDS'))
      ? (await fromEnv('CHAIN_IDS'))!.split(',').map((id) => id.trim())
      : Object.keys(config.chains);

  const chains: Record<string, ChainConfiguration> = {};

  for (const chainId of chainIds) {
    if (!config.chains[chainId]) {
      console.log(`Chain ${chainId} not found in Everclear config, skipping`);
      continue;
    }

    const chainConfig = config.chains[chainId]!;

    const providers = (
      configJson.chains?.[chainId]?.providers ??
      ((await fromEnv(`CHAIN_${chainId}_PROVIDERS`))
        ? parseProviders((await fromEnv(`CHAIN_${chainId}_PROVIDERS`))!)
        : undefined) ??
      []
    ).concat(chainConfig.providers ?? []);

    const assets = await Promise.all(
      Object.values(chainConfig.assets ?? {}).map(async (a) => {
        const jsonThreshold = (configJson.chains?.[chainId]?.assets ?? []).find(
          (asset: { symbol: string; balanceThreshold: string }) =>
            a.symbol.toLowerCase() === asset.symbol.toLowerCase(),
        )?.balanceThreshold;
        const envThreshold = await fromEnv(`${a.symbol.toUpperCase()}_${chainId}_THRESHOLD`);
        return {
          ...a,
          balanceThreshold: jsonThreshold ?? envThreshold ?? DEFAULT_BALANCE_THRESHOLD,
        };
      }),
    );

    // Get the invoice age
    // First, check if there is a configured invoice age in the env
    const invoiceAge =
      (await fromEnv(`CHAIN_${chainId}_INVOICE_AGE`)) ?? (await fromEnv('INVOICE_AGE')) ?? DEFAULT_INVOICE_AGE;
    const gasThreshold =
      configJson?.chains?.[chainId]?.gasThreshold ??
      (await fromEnv(`CHAIN_${chainId}_GAS_THRESHOLD`)) ??
      (await fromEnv(`GAS_THRESHOLD`)) ??
      DEFAULT_GAS_THRESHOLD;

    // Extract Everclear spoke address from the config
    const everclear = chainConfig.deployments?.everclear;

    if (!everclear) {
      throw new ConfigurationError(
        `No spoke address found for chain ${chainId}. Make sure it's defined in the config under chains.${chainId}.deployments.everclear`,
      );
    }

    // Get chain-specific contract addresses or use config values if provided
    const permit2 =
      chainConfig.deployments?.permit2 ||
      UTILITY_CONTRACTS_OVERRIDE[chainId]?.permit2 ||
      UTILITY_CONTRACTS_DEFAULT.permit2;

    const multicall3 =
      chainConfig.deployments?.multicall3 ||
      UTILITY_CONTRACTS_OVERRIDE[chainId]?.multicall3 ||
      UTILITY_CONTRACTS_DEFAULT.multicall3;

    chains[chainId] = {
      providers,
      assets: assets.filter((asset) => supportedAssets.includes(asset.symbol) || asset.isNative),
      invoiceAge: parseInt(invoiceAge),
      gasThreshold,
      deployments: {
        everclear,
        permit2,
        multicall3,
      },
    };
  }

  return chains;
};

function parseHubConfigurations(
  config: EverclearConfig | undefined,
  environment: Environment,
): Omit<HubConfig, 'confirmations' | 'subgraphUrls'> {
  const chainId = process.env.HUB_CHAIN ?? config?.hub.domain ?? (environment === 'mainnet' ? '25327' : '6398');

  const assets =
    (process.env[`CHAIN_${chainId}_ASSETS`] ? parseAssets(process.env[`CHAIN_${chainId}_ASSETS`]!) : undefined) ??
    Object.values(config?.hub.assets ?? {}).map((a) => ({ ...a, balanceThreshold: '0' }));

  const providers =
    (process.env[`CHAIN_${chainId}_PROVIDERS`]
      ? parseProviders(process.env[`CHAIN_${chainId}_PROVIDERS`]!)
      : undefined) ??
    config?.hub.providers ??
    [];
  return {
    domain: chainId,
    providers,
    assets: assets.length > 0 ? assets : undefined,
  };
}

function parseProviders(providers: string): string[] {
  return providers.split(',').map((provider) => provider.trim());
}

function parseAssets(assets: string): AssetConfiguration[] {
  return assets.split(';').map((asset) => {
    const [symbol, address, decimals, tickerHash, isNative, balanceThreshold] = asset.split(',').map((s) => s.trim());
    return {
      symbol,
      address,
      decimals: parseInt(decimals, 10),
      tickerHash,
      isNative: isNative?.toLowerCase() === 'true',
      balanceThreshold,
    };
  });
}

export const getTokenAddressFromConfig = (
  tickerHash: string,
  domain: string,
  config: MarkConfiguration,
): string | undefined => {
  const asset = (config.chains[domain]?.assets ?? []).find(
    (a) => a.tickerHash.toLowerCase() === tickerHash.toLowerCase(),
  );
  if (!asset) {
    return undefined;
  }
  return asset.address;
};

export const getDecimalsFromConfig = (ticker: string, domain: string, config: MarkConfiguration) => {
  const asset = (config.chains[domain]?.assets ?? []).find((a) => a.tickerHash.toLowerCase() === ticker.toLowerCase());
  if (!asset) {
    return undefined;
  }
  return asset.decimals;
};
