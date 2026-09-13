/** Input shared by the optional chain-specific SIWx verifier entry points. */
export interface SignInVerificationInput {
  address: string;
  message: string;
  signature: string;
  chainId?: string;
}
