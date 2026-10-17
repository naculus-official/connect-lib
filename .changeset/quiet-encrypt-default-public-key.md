---
"@naculus/connect-core": patch
---

encryptPrivateKey no longer stores the private key in the public field when publicKeyHex is omitted. It now derives the secp256k1 public key from the private key and throws on invalid input instead of returning the private key. Callers that pass publicKeyHex are unchanged.
