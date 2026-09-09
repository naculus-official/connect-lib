/**
 * What an account can do, independent of how the wallet implements it.
 *
 * A dApp should be able to ask "can this account batch calls, and can someone
 * else pay for them" without knowing whether the answer comes from EIP-5792 on
 * an injected wallet, from an ERC-4337 bundler, or from a future execution
 * model on a chain that is not EVM at all. `UniversalConnector.getCapabilities`
 * returns the wallet's own shape; this normalizes it into a decision the
 * caller can act on, and — the part that matters — gives a defined answer when
 * the wallet does not implement the query.
 */
import type {
  UniversalWalletSession,
  WalletCapabilities,
} from "./connector";

export interface AccountCapabilities {
  /**
   * Several calls either all land or none do.
   *
   * False does not mean "cannot send several calls"; it means they cannot be
   * guaranteed to land together, so the caller must be prepared for a partial
   * outcome.
   */
  atomicBatch: boolean;
  /** Upper bound the wallet advertises, when it advertises one. */
  maxBatchSize?: number;
  /** A paymaster can cover gas for this account. */
  sponsoredTransactions: boolean;
  /**
   * Whether the wallet answered the query at all.
   *
   * Separated from the flags on purpose. "The wallet said no" and "the wallet
   * has no way to say" are different facts: the first is a capability
   * decision, the second is a reason to fall back conservatively *and* a
   * thing worth surfacing, because an old wallet may well support batching
   * without being able to advertise it.
   */
  discovered: boolean;
}

/** Capabilities of a wallet that cannot be asked, or that answered nothing. */
export const NO_CAPABILITIES: AccountCapabilities = Object.freeze({
  atomicBatch: false,
  sponsoredTransactions: false,
  discovered: false,
});

/**
 * The chain a capability query applies to when the caller does not name one.
 *
 * `chains[0]` is the active chain by convention across every connector.
 */
function activeChainOf(session: UniversalWalletSession): string | undefined {
  const namespaces = session.namespaces as Record<
    string,
    { chains?: string[] } | undefined
  >;
  for (const namespace of ["eip155", "solana", "xrpl"]) {
    const first = namespaces[namespace]?.chains?.[0];
    if (first) return first;
  }
  return undefined;
}

function normalize(raw: WalletCapabilities | undefined): AccountCapabilities {
  if (!raw) return { ...NO_CAPABILITIES, discovered: true };
  return {
    atomicBatch: Boolean(raw.atomicBatch?.supported),
    maxBatchSize: raw.atomicBatch?.maxBatchSize,
    sponsoredTransactions: Boolean(raw.paymasterService?.supported),
    discovered: true,
  };
}

/**
 * Resolve what the account can do on a chain.
 *
 * Never throws. A capability query is a question about the wallet, not part of
 * the operation the user asked for, so a wallet that rejects it, times out or
 * returns nonsense must not take the flow down with it — the caller gets
 * `discovered: false` and proceeds on the conservative path.
 */
export async function getAccountCapabilities(
  connector: CapabilityQueryable,
  session: UniversalWalletSession,
  chainId?: string,
): Promise<AccountCapabilities> {
  if (!connector.getCapabilities) return NO_CAPABILITIES;

  const chain = chainId ?? activeChainOf(session);
  if (!chain) return NO_CAPABILITIES;

  try {
    const all = await connector.getCapabilities(session);
    // No answer at all is not the same as an answer that omitted this chain:
    // the first means the query did not happen, the second means the wallet
    // was asked and reported nothing for the chain.
    if (!all) return NO_CAPABILITIES;
    return normalize(all[chain]);
  } catch {
    return NO_CAPABILITIES;
  }
}

/**
 * Anything that can answer the capability query.
 *
 * Deliberately structural rather than `UniversalConnector`, so a facade over
 * several connectors — AppKit's Web3Client, for one — can be passed straight
 * through instead of being wrapped in a fake connector. The optional
 * `undefined` return is how such a facade says "the connector behind this
 * session has no way to answer", which lands on `discovered: false`.
 */
export interface CapabilityQueryable {
  getCapabilities?: (
    session: UniversalWalletSession,
  ) => Promise<Record<string, WalletCapabilities>> | undefined;
}

export type ExecutionStrategy = "atomic-batch" | "sequential";

/**
 * How a set of calls should be executed given what the account supports.
 *
 * Keeping this decision in one place is the point of the abstraction: callers
 * express "send these calls" and never branch on EIP-5792, ERC-4337 or any
 * successor. A single call is always sequential — batching one call adds a
 * wallet round trip and an approval screen for nothing.
 */
export function chooseExecutionStrategy(
  capabilities: AccountCapabilities,
  callCount: number,
): ExecutionStrategy {
  if (callCount <= 1) return "sequential";
  if (!capabilities.atomicBatch) return "sequential";
  if (
    capabilities.maxBatchSize !== undefined &&
    callCount > capabilities.maxBatchSize
  ) {
    // Splitting into several batches would lose the atomicity that was the
    // reason to batch, so fall back rather than pretend.
    return "sequential";
  }
  return "atomic-batch";
}

// ── Execution planning ─────────────────────────────────────────────

/**
 * How much the caller needs several calls to land together.
 *
 * `"required"` is the one that changes behavior: it can end in a refusal.
 * An application that batches an approve with the swap it pays for needs the
 * pair to be all-or-nothing, and quietly sending them one after another
 * because the wallet cannot batch leaves an approval standing to a contract
 * the user never transacted with.
 */
export type AtomicityRequirement = "required" | "preferred" | "any";

/**
 * What the caller needs, beyond the calls themselves.
 *
 * Sponsorship is not a weaker form of atomicity — it answers who pays, not
 * whether the calls land together — so it is a separate axis and either can
 * end in a refusal on its own.
 */
export interface ExecutionRequirements {
  atomicity?: AtomicityRequirement;
  /** Whether gas must be covered by a paymaster rather than the user. */
  sponsorship?: AtomicityRequirement;
}

export interface ExecutionPlan {
  /** `"refuse"` when the requirement cannot be met — send nothing. */
  strategy: ExecutionStrategy | "refuse";
  /** Whether the chosen route is genuinely all-or-nothing. */
  atomic: boolean;
  /** Whether the wallet reports a paymaster can cover this. */
  sponsored: boolean;
  /** Why this route, in terms an application can show a user. */
  reason: string;
}

/**
 * Decide how to execute, and say so before anything is sent.
 *
 * `chooseExecutionStrategy` answers the same question for the default case
 * and cannot express a refusal, so it silently downgrades to sequential for a
 * caller that needed atomicity. This is the version that can say no.
 *
 * The distinction `AccountCapabilities.discovered` exists for decides the
 * interesting case: a wallet that answered "no" is a decision, and a wallet
 * that has no way to answer is not. When atomicity is required and the wallet
 * never told us, the batch is still attempted with the atomic flag set — the
 * wallet is the authority and rejects cleanly if it cannot, which is a better
 * outcome than refusing on behalf of an older wallet that may well batch.
 */
export function planExecution(
  capabilities: AccountCapabilities,
  callCount: number,
  requirements: AtomicityRequirement | ExecutionRequirements = "preferred",
): ExecutionPlan {
  const asked: ExecutionRequirements =
    typeof requirements === "string"
      ? { atomicity: requirements }
      : requirements;
  const requirement = asked.atomicity ?? "preferred";
  const sponsorship = asked.sponsorship ?? "any";
  const sponsored = capabilities.sponsoredTransactions;

  // Checked before anything else: a route that lands the calls perfectly but
  // charges a user who was promised sponsored gas is still the wrong route,
  // and finding out after signing is too late.
  if (sponsorship === "required" && !sponsored && capabilities.discovered) {
    return {
      strategy: "refuse",
      atomic: false,
      sponsored: false,
      reason:
        "This wallet has said no paymaster can cover this transaction, and the caller requires sponsored gas.",
    };
  }

  // One call is all-or-nothing by construction; there is nothing to batch.
  if (callCount <= 1) {
    return {
      strategy: "sequential",
      atomic: true,
      sponsored,
      reason: "A single call is atomic on its own.",
    };
  }

  const overBatchLimit =
    capabilities.maxBatchSize !== undefined &&
    callCount > capabilities.maxBatchSize;

  if (overBatchLimit) {
    // Splitting into several batches loses the atomicity that was the reason
    // to batch, so this is a refusal when atomicity was required.
    return requirement === "required"
      ? {
          strategy: "refuse",
          atomic: false,
          sponsored,
          reason: `This wallet accepts at most ${capabilities.maxBatchSize} calls per batch and ${callCount} were requested. Splitting them would lose the guarantee that they land together.`,
        }
      : {
          strategy: "sequential",
          atomic: false,
          sponsored,
          reason: `More calls than this wallet batches at once (${capabilities.maxBatchSize}), so they are sent one by one and an earlier one can land while a later one fails.`,
        };
  }

  if (capabilities.atomicBatch) {
    return {
      strategy: "atomic-batch",
      atomic: true,
      sponsored,
      reason: "The wallet reports that it executes batched calls atomically.",
    };
  }

  if (!capabilities.discovered) {
    if (requirement === "required") {
      return {
        strategy: "atomic-batch",
        atomic: true,
        sponsored,
        reason:
          "This wallet did not answer the capability query, which is not the same as saying no. The batch is sent with the atomic flag set, so the wallet refuses it outright rather than splitting it.",
      };
    }
    return {
      strategy: "sequential",
      atomic: false,
      sponsored,
      reason:
        "This wallet did not answer the capability query, so the calls are sent one by one and an earlier one can land while a later one fails.",
    };
  }

  if (requirement === "required") {
    return {
      strategy: "refuse",
      atomic: false,
      sponsored,
      reason:
        "This wallet has said it cannot execute several calls atomically, and the caller requires that they land together.",
    };
  }

  return {
    strategy: "sequential",
    atomic: false,
    sponsored,
    reason:
      "This wallet cannot batch atomically, so the calls are sent one by one and an earlier one can land while a later one fails.",
  };
}
