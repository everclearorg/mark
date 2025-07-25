export interface CreateLookupTableParams {
  inputAsset: string;
  user: string;
  userTokenAccountPublicKey: string;
  // TODO: why is this here
  programVaultAccountPublicKey: string;
}
