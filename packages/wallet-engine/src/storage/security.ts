/**
 * A readable account of how well a wallet is stored, and what is holding the
 * score down.
 *
 * A single tier from 1 to 4 tells a user where they stand and nothing about
 * why or what to do. This produces the same tier plus the individual findings
 * behind it, so an app can render "94/100" next to the two sentences that
 * explain the missing six points.
 *
 * **The rubric below is a deliberate, stated scale — not an industry
 * standard.** Its only claim is that the deductions are proportional to how
 * much each weakness actually widens the attack surface, and that they are
 * visible here rather than buried in a UI component.
 */

import type { StorageSecurityLevel, StorageType } from "./types";
import type { UnlockState } from "./unlock";

export type StorageFindingSeverity = "critical" | "warning" | "info";

export interface StorageSecurityFinding {
  /** Stable across releases and safe to key translations off. */
  id: string;
  severity: StorageFindingSeverity;
  /** Points this finding removed from 100. Zero for purely informational. */
  deduction: number;
  title: string;
  detail: string;
  /** What the user or integrator can actually do. Absent when nothing can. */
  remedy?: string;
}

export interface StorageSecurityReport {
  /** The existing 1–4 tier, unchanged in meaning. */
  level: StorageSecurityLevel;
  /** 0–100, from the rubric in this file. */
  score: number;
  backend: StorageType;
  encrypted: boolean;
  unlock: UnlockState;
  findings: StorageSecurityFinding[];
}

export interface StorageSecurityInput {
  level: StorageSecurityLevel;
  backend: StorageType;
  encrypted: boolean;
  unlock: UnlockState;
}

const HOT_WALLET_FINDING: StorageSecurityFinding = {
  id: "hot-wallet-signing-exposure",
  severity: "info",
  deduction: 0,
  title: "The signing key is in memory while it signs",
  detail:
    "WebCrypto implements neither secp256k1 nor mature Ed25519, so the key cannot be a non-extractable CryptoKey the way the storage key is. It is decrypted to sign and exposed to the page for that moment. This is what a hot wallet is, not a defect in this one.",
  remedy:
    "For amounts where that matters, sign with a hardware wallet. This wallet is designed for the balance you are willing to keep on a web page.",
};

export function assessStorageSecurity(
  input: StorageSecurityInput,
): StorageSecurityReport {
  const findings: StorageSecurityFinding[] = [];
  const push = (f: StorageSecurityFinding) => findings.push(f);

  // ── Backend ─────────────────────────────────────────────────────
  if (input.backend === "localStorage") {
    push({
      id: "backend-localstorage",
      severity: "critical",
      deduction: 40,
      title: "Stored in localStorage",
      detail:
        "Any script that runs on this origin can read localStorage synchronously, including one injected through a compromised dependency.",
      remedy:
        "Use a browser where IndexedDB is available, or stop blocking site data for this origin.",
    });
  }

  // ── Encryption at rest ──────────────────────────────────────────
  if (!input.encrypted) {
    push({
      id: "no-encryption-at-rest",
      severity: "critical",
      deduction: 30,
      title: "Not encrypted at rest",
      detail:
        "The wallet is stored as readable JSON. Anything that can reach the storage backend can read the private key directly.",
      remedy:
        "Configure encryptionPassphrase so the record is sealed with AES-256-GCM.",
    });
  }

  // ── What supplies the key ───────────────────────────────────────
  // Only meaningful once something is encrypted: with no encryption the
  // unlock source is not what is holding the score down.
  if (input.encrypted) {
    switch (input.unlock.prf) {
      case "none":
        push({
          id: "prf-not-configured",
          severity: "warning",
          deduction: 20,
          title: "Unlocking needs only a passphrase",
          detail:
            "The encryption key comes from a passphrase this page can supply. Whatever can run script here can supply it too.",
          remedy:
            "Register a passkey and pass its PRF provider, so opening the wallet needs the user's fingerprint or face rather than a value a script can reach.",
        });
        break;
      case "unknown":
        push({
          id: "prf-not-yet-checked",
          severity: "info",
          // Counted as not-yet-earned rather than assumed present. The score
          // rises on its own after the first unlock if the authenticator
          // answers.
          deduction: 20,
          title: "Passkey protection has not been checked yet",
          detail:
            "A PRF provider is configured but the authenticator has not been asked in this session, so this score does not yet count it.",
          remedy: "Unlock the wallet once to establish what this device can do.",
        });
        break;
      case "unavailable":
        push({
          id: "prf-unavailable",
          severity: "warning",
          deduction: 15,
          title: "This device cannot protect the wallet with a passkey",
          detail:
            "The authenticator did not return PRF material. Firefox does not implement the extension, and a passkey created before PRF was requested cannot have it added afterwards.",
          remedy:
            "Register a new passkey on a browser that supports PRF. The existing one cannot be upgraded.",
        });
        break;
      case "available":
        if (input.unlock.sealedWith?.includes("prf")) {
          push({
            id: "passphrase-recovery-retained",
            severity: "info",
            // The honest ceiling. A record openable two ways is only as hard
            // to open as the easier way.
            deduction: 5,
            title: "A passphrase can still open this wallet",
            detail:
              "The stored record carries both a passkey wrap and a passphrase wrap, so it is only as hard to open as the passphrase. That is the cost of being able to get back in when the authenticator breaks.",
            remedy:
              "This is a deliberate trade. Removing the passphrase wrap would recover these points and make a lost passkey cost this copy of the wallet.",
          });
        } else {
          push({
            id: "prf-reseal-pending",
            severity: "warning",
            deduction: 10,
            title: "Passkey protection is not applied to the stored record yet",
            detail:
              "This device can produce passkey key material, but the record on disk was sealed before that and is still passphrase-only.",
            remedy:
              "Save the wallet once. The next write seals it with both.",
          });
        }
        break;
    }
  }

  push(HOT_WALLET_FINDING);

  const score = findings.reduce((acc, f) => acc - f.deduction, 100);
  return {
    level: input.level,
    score: Math.max(0, Math.min(100, score)),
    backend: input.backend,
    encrypted: input.encrypted,
    unlock: input.unlock,
    findings,
  };
}
