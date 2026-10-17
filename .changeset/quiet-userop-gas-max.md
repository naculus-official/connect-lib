---
"@naculus/core": patch
---

`SmartAccountManager.sendUserOperation` now enforces `paymaster.policy.maxGasPerUserOp` as a total. Before signing, the final UserOperation's `callGasLimit`, `verificationGasLimit`, `preVerificationGas` and, for v0.7, `paymasterVerificationGasLimit` and `paymasterPostOpGasLimit` are summed; a sum above the maximum, or a maximum that is not a non-negative bigint, throws `aa_invalid_input` and nothing is signed or submitted. Known limit: `verificationGasLimit` is counted once; the v0.6 EntryPoint's 3x multiplier for paymaster postOp is not applied. Without a configured maximum, behaviour is unchanged.
