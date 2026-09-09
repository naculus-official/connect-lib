---
"@naculus/connect-core": minor
---

EIP-7702 delegation reading, and sponsorship as an execution requirement.

`readDelegation` answers a question nothing here could: whether an ordinary
address is currently able to execute like a contract account. A delegated EOA
carries exactly 23 bytes of code — the `0xef0100` designator the spec fixes,
then the 20-byte delegate — and that prefix reuses EIP-3541's reserved opcode
space precisely so a delegation cannot be mistaken for deployed code.

`delegated` is `boolean | null`. Null means the code was never read, which is
not the same as an account with no code: treating a failed RPC as "no
delegation" is how an account that can batch gets sent down the path for one
that cannot. Delegating to the zero address, which the spec uses to clear a
delegation, reads as not delegated.

`planExecution` gains a sponsorship axis. It is not a weaker form of atomicity
— it answers who pays, not whether the calls land together — so it is checked
separately and can refuse on its own. A route that executes perfectly but
charges a user who was promised sponsored gas is still the wrong route, and
signing is too late to find out. A wallet that never answered the capability
query is not refused on, for the same reason as atomicity: it is the authority
on its own paymaster.

`planExecution`'s third argument still accepts a bare `AtomicityRequirement`.
