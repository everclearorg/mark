export enum WalletType {
  Zodiac = 'Zodiac',
  EOA = 'EOA',
}

export interface WalletConfig {
  walletType: WalletType;
  moduleAddress?: `0x${string}`;
  roleKey?: `0x${string}`;
  safeAddress?: `0x${string}`;
}
