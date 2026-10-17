---
"@naculus/payments-x402": patch
---

Solana `verifyPayment` now rejects an exact payment whose TransferChecked source token account is its destination (payTo's associated token account) with `invalid_exact_svm_payload_transaction`. Such a transfer, signed by a delegate of payTo's account, credits payTo nothing; previously it could verify and, with a successful simulation and confirmation, settle with `success: true`. `settlePayment` only settles results `verifyPayment` accepted, so it no longer reports success for this payment.
