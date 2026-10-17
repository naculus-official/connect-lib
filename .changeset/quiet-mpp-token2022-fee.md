---
"@naculus/payments-mpp": patch
---

Solana `settleCredential` now reads the mint of a Token-2022 charge before signing, simulating or sending, and refuses with `verification-failed` a mint whose extensions change what the recipient receives (TransferFeeConfig, TransferHook, NonTransferable, ConfidentialTransferFee, PausableConfig), a missing mint, or one whose token program or decimals differ from the challenge. A fee-bearing transfer of the advertised amount previously simulated, confirmed and settled with a `success` receipt while crediting the recipient less. `MppSolanaSettleRpc` gains an optional `getAccountInfo`; it is required for Token-2022 charges, which fail without it. SPL Token charges are unchanged.
