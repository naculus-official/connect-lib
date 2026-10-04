import { base58 } from "@scure/base";
import {
  isValidAddress,
  isZeroAddress,
  toChecksumAddress,
} from "../address-validation";
import { eip155Reference, parseCaip10 } from "../caip";
import type {
  ChannelVoucherKeyInfo,
  ChannelVoucherKeyManager,
  ChannelVoucherPolicy,
} from "../session-keys/channel-voucher-keys";
import type { SessionKeyManager } from "../session-keys/SessionKeyManager";
import type {
  SolanaSessionKeyInfo,
  SolanaSessionKeyManager,
  SolanaSessionKeyScope,
} from "../session-keys/solana-session-keys";
import type { SessionKeyInfo, SessionKeyScope } from "../session-keys/types";

export type Rail = "transfer" | "x402-exact" | "mpp-charge" | "mpp-session";

export interface Grant {
  asset: string;
  recipients: string[];
  maxPerPayment: bigint;
  maxTotal: bigint;
  maxCount?: number;
  period?: GrantPeriod;
  rails: Rail[];
}

export interface GrantPeriod {
  amount: bigint;
  seconds: number;
  start: number;
}

export type ListedAuthorizationStatus =
  | "active"
  | "pending"
  | "revoked"
  | "expired";

export type ListedAuthorizationFlag =
  | "unrestricted-recipient-legacy"
  | "not-expressible";

interface ListedAuthorizationBase {
  keyId: string;
  status: ListedAuthorizationStatus;
  principal?: string;
  /** Unix timestamp in seconds. */
  expiresAt: number;
  grants: Grant[];
  /** Cumulative spend keyed by canonical CAIP-19 asset ID. */
  spent?: Record<string, bigint>;
  flags: ListedAuthorizationFlag[];
}

export type ListedAuthorization =
  | (ListedAuthorizationBase & {
      enforcer: "evm-session";
      raw: SessionKeyInfo;
    })
  | (ListedAuthorizationBase & {
      enforcer: "solana-session";
      raw: SolanaSessionKeyInfo;
    })
  | (ListedAuthorizationBase & {
      enforcer: "mpp-voucher";
      raw: ChannelVoucherKeyInfo;
    });

export interface AuthorizationManagers {
  evm?: SessionKeyManager;
  solana?: SolanaSessionKeyManager;
  mppVoucher?: ChannelVoucherKeyManager;
}

export type RevokeListedAuthorizationResult =
  | { onChainRevocationRequired: false }
  | { onChainRevocationRequired: true };

export interface Authorization {
  version: 1;
  principal: string;
  label?: string;
  grants: Grant[];
  notBefore?: number;
  expiresAt: number;
}

export interface SpendRequest {
  asset: string;
  recipient: string;
  amount: bigint;
  rail: Rail;
  at: number;
  spentSoFar: bigint;
  countSoFar: number;
  periodSpentSoFar?: bigint;
}

export type SpendRefusal =
  | "expired"
  | "not-yet-valid"
  | "no-matching-grant"
  | "recipient-not-allowed"
  | "over-per-payment"
  | "over-total"
  | "over-count"
  | "period-limit-exceeded"
  | "rail-not-allowed"
  | "invalid-authorization";

export type SpendVerdict =
  | { allow: true; grant: number }
  | { allow: false; reason: SpendRefusal };

export type AuthorizationValidation =
  | { ok: true; authorization: Authorization }
  | { ok: false; reason: string };

export type CompileResult<T> =
  | { ok: true; scope: T; enforcement: "on-chain" | "device" }
  | { ok: false; reason: string };

export interface CompileOptions {
  requireOnChain?: boolean;
}

export interface CompiledMppSessionPolicy {
  recipient: string;
  amount: bigint;
  deposit: bigint;
  maxCumulative: bigint;
  maxDelta: bigint;
  expiresAt: number;
  minimumGracePeriodSeconds?: number;
}

export interface MppSessionCompileContext {
  channelProgram: string;
  payer: string;
  pricePerUnit: bigint;
  deposit: bigint;
  minimumGracePeriodSeconds?: number;
}

export interface CompiledMppSession {
  voucher: ChannelVoucherPolicy;
  client: CompiledMppSessionPolicy;
}

interface ParsedAsset {
  canonical: string;
  chain: string;
  namespace: "eip155" | "solana";
  kind: "erc20" | "native" | "token";
  address?: string;
}

const RAILS = new Set<Rail>([
  "transfer",
  "x402-exact",
  "mpp-charge",
  "mpp-session",
]);
const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function canonicalSolanaAddress(value: unknown): string | null {
  if (typeof value !== "string" || !isValidAddress(value, "solana")) {
    return null;
  }
  try {
    const bytes = base58.decode(value);
    return bytes.length === 32 ? base58.encode(bytes) : null;
  } catch {
    return null;
  }
}

function parseAsset(value: unknown): ParsedAsset | null {
  if (typeof value !== "string") return null;
  const evm = /^(eip155:[1-9]\d*)\/(erc20|slip44):(.+)$/.exec(value);
  if (evm) {
    const chainNumber = eip155Reference(evm[1]);
    if (chainNumber === null) return null;
    const chain = `eip155:${chainNumber}`;
    if (evm[2] === "slip44") {
      return evm[3] === "60"
        ? {
            canonical: `${chain}/slip44:60`,
            chain,
            namespace: "eip155",
            kind: "native",
          }
        : null;
    }
    if (!isValidAddress(evm[3], "eip155")) return null;
    const address = toChecksumAddress(evm[3]);
    return {
      canonical: `${chain}/erc20:${address}`,
      chain,
      namespace: "eip155",
      kind: "erc20",
      address,
    };
  }
  const solana = /^(solana:[1-9A-HJ-NP-Za-km-z]{32})\/token:(.+)$/.exec(value);
  if (!solana) return null;
  const address = canonicalSolanaAddress(solana[2]);
  return address
    ? {
        canonical: `${solana[1]}/token:${address}`,
        chain: solana[1],
        namespace: "solana",
        kind: "token",
        address,
      }
    : null;
}

function canonicalAddress(
  value: unknown,
  namespace: ParsedAsset["namespace"],
): string | null {
  if (typeof value !== "string" || !isValidAddress(value, namespace))
    return null;
  return namespace === "eip155"
    ? toChecksumAddress(value)
    : canonicalSolanaAddress(value);
}

function canonicalPrincipal(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const account = parseCaip10(value);
  if (
    !account ||
    (account.namespace !== "eip155" && account.namespace !== "solana")
  ) {
    return null;
  }
  const address = canonicalAddress(account.address, account.namespace);
  if (!address) return null;
  if (account.namespace === "eip155") {
    const reference = eip155Reference(account.chainId);
    return reference === null ? null : `eip155:${reference}:${address}`;
  }
  if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(account.chainId)) return null;
  return `${account.chainId}:${address}`;
}

export function validateAuthorization(value: unknown): AuthorizationValidation {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      ["version", "principal", "grants", "expiresAt"],
      ["label", "notBefore"],
    ) ||
    value.version !== 1 ||
    !Array.isArray(value.grants) ||
    value.grants.length === 0 ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= 0 ||
    (value.notBefore !== undefined &&
      (!Number.isSafeInteger(value.notBefore) ||
        (value.notBefore as number) < 0)) ||
    (value.notBefore !== undefined &&
      (value.expiresAt as number) <= (value.notBefore as number)) ||
    (value.label !== undefined && typeof value.label !== "string")
  ) {
    return { ok: false, reason: "invalid authorization structure" };
  }
  const principal = canonicalPrincipal(value.principal);
  if (!principal) return { ok: false, reason: "invalid principal" };

  const grants: Grant[] = [];
  for (const raw of value.grants) {
    if (
      !isRecord(raw) ||
      !exactKeys(
        raw,
        ["asset", "recipients", "maxPerPayment", "maxTotal", "rails"],
        ["maxCount", "period"],
      ) ||
      !Array.isArray(raw.recipients) ||
      raw.recipients.length === 0 ||
      typeof raw.maxPerPayment !== "bigint" ||
      typeof raw.maxTotal !== "bigint" ||
      raw.maxPerPayment <= 0n ||
      raw.maxPerPayment > raw.maxTotal ||
      (raw.maxCount !== undefined &&
        (!Number.isSafeInteger(raw.maxCount) ||
          (raw.maxCount as number) <= 0)) ||
      !Array.isArray(raw.rails) ||
      raw.rails.length === 0 ||
      raw.rails.some(
        (rail) => typeof rail !== "string" || !RAILS.has(rail as Rail),
      )
    ) {
      return { ok: false, reason: "invalid grant structure" };
    }
    if (
      raw.period !== undefined &&
      (!isRecord(raw.period) ||
        !exactKeys(raw.period, ["amount", "seconds", "start"]) ||
        typeof raw.period.amount !== "bigint" ||
        raw.period.amount <= 0n ||
        raw.period.amount > raw.maxTotal ||
        !Number.isSafeInteger(raw.period.seconds) ||
        (raw.period.seconds as number) <= 0 ||
        !Number.isSafeInteger(raw.period.start) ||
        (raw.period.start as number) < 0)
    ) {
      return { ok: false, reason: "invalid grant period" };
    }
    const asset = parseAsset(raw.asset);
    if (!asset) return { ok: false, reason: "invalid asset" };
    const recipients = raw.recipients.map((recipient) =>
      canonicalAddress(recipient, asset.namespace),
    );
    if (recipients.some((recipient) => recipient === null)) {
      return { ok: false, reason: "invalid recipient" };
    }
    const canonicalRecipients = recipients as string[];
    const rails = raw.rails as Rail[];
    if (raw.period !== undefined && rails.includes("mpp-session")) {
      return { ok: false, reason: "period is not expressible on an MPP rail" };
    }
    if (
      new Set(canonicalRecipients).size !== canonicalRecipients.length ||
      new Set(rails).size !== rails.length
    ) {
      return { ok: false, reason: "duplicate recipient or rail" };
    }
    grants.push({
      asset: asset.canonical,
      recipients: canonicalRecipients,
      maxPerPayment: raw.maxPerPayment,
      maxTotal: raw.maxTotal,
      ...(raw.maxCount === undefined
        ? {}
        : { maxCount: raw.maxCount as number }),
      ...(raw.period === undefined
        ? {}
        : {
            period: {
              amount: raw.period.amount as bigint,
              seconds: raw.period.seconds as number,
              start: raw.period.start as number,
            },
          }),
      rails: [...rails],
    });
  }

  for (let left = 0; left < grants.length; left++) {
    for (let right = left + 1; right < grants.length; right++) {
      const a = grants[left];
      const b = grants[right];
      if (
        a.asset === b.asset &&
        a.recipients.some((recipient) => b.recipients.includes(recipient)) &&
        a.rails.some((rail) => b.rails.includes(rail))
      ) {
        return { ok: false, reason: "overlapping grants" };
      }
    }
  }

  return {
    ok: true,
    authorization: {
      version: 1,
      principal,
      ...(value.label === undefined ? {} : { label: value.label as string }),
      grants,
      ...(value.notBefore === undefined
        ? {}
        : { notBefore: value.notBefore as number }),
      expiresAt: value.expiresAt as number,
    },
  };
}

export function evaluateSpend(
  value: Authorization,
  request: SpendRequest,
): SpendVerdict {
  const validated = validateAuthorization(value);
  if (!validated.ok) return { allow: false, reason: "invalid-authorization" };
  if (
    !isRecord(request) ||
    !exactKeys(
      request,
      [
        "asset",
        "recipient",
        "amount",
        "rail",
        "at",
        "spentSoFar",
        "countSoFar",
      ],
      ["periodSpentSoFar"],
    ) ||
    typeof request.amount !== "bigint" ||
    request.amount <= 0n ||
    typeof request.spentSoFar !== "bigint" ||
    request.spentSoFar < 0n ||
    (request.periodSpentSoFar !== undefined &&
      (typeof request.periodSpentSoFar !== "bigint" ||
        request.periodSpentSoFar < 0n)) ||
    !Number.isSafeInteger(request.at) ||
    !Number.isSafeInteger(request.countSoFar) ||
    request.countSoFar < 0 ||
    !RAILS.has(request.rail)
  ) {
    return { allow: false, reason: "invalid-authorization" };
  }
  const authorization = validated.authorization;
  if (request.at >= authorization.expiresAt)
    return { allow: false, reason: "expired" };
  if (
    authorization.notBefore !== undefined &&
    request.at < authorization.notBefore
  ) {
    return { allow: false, reason: "not-yet-valid" };
  }
  const asset = parseAsset(request.asset);
  if (!asset) return { allow: false, reason: "no-matching-grant" };
  const assetMatches = authorization.grants
    .map((grant, index) => ({ grant, index }))
    .filter(({ grant }) => grant.asset === asset.canonical);
  if (assetMatches.length === 0)
    return { allow: false, reason: "no-matching-grant" };
  const railMatches = assetMatches.filter(({ grant }) =>
    grant.rails.includes(request.rail),
  );
  if (railMatches.length === 0)
    return { allow: false, reason: "rail-not-allowed" };
  const recipient = canonicalAddress(request.recipient, asset.namespace);
  if (!recipient) return { allow: false, reason: "recipient-not-allowed" };
  const match = railMatches.find(({ grant }) =>
    grant.recipients.includes(recipient),
  );
  if (!match) return { allow: false, reason: "recipient-not-allowed" };
  if (request.amount > match.grant.maxPerPayment)
    return { allow: false, reason: "over-per-payment" };
  if (request.spentSoFar + request.amount > match.grant.maxTotal) {
    return { allow: false, reason: "over-total" };
  }
  if (
    match.grant.maxCount !== undefined &&
    request.countSoFar >= match.grant.maxCount
  ) {
    return { allow: false, reason: "over-count" };
  }
  if (match.grant.period !== undefined) {
    if (request.at < match.grant.period.start) {
      return { allow: false, reason: "period-limit-exceeded" };
    }
    const periodIndex = Math.floor(
      (request.at - match.grant.period.start) / match.grant.period.seconds,
    );
    if (periodIndex < 0 || request.periodSpentSoFar === undefined) {
      return { allow: false, reason: "period-limit-exceeded" };
    }
    if (request.periodSpentSoFar + request.amount > match.grant.period.amount) {
      return { allow: false, reason: "period-limit-exceeded" };
    }
  }
  return { allow: true, grant: match.index };
}

function validatedForCompile(value: Authorization): Authorization | string {
  const result = validateAuthorization(value);
  if (!result.ok) return result.reason;
  return result.authorization.notBefore === undefined
    ? result.authorization
    : "notBefore is not expressible by existing session scopes";
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

export function compileEvmSessionScope(
  value: Authorization,
  chainId: number,
  options: CompileOptions = {},
): CompileResult<SessionKeyScope> {
  if (options.requireOnChain)
    return { ok: false, reason: "on-chain enforcement is not available" };
  const authorization = validatedForCompile(value);
  if (typeof authorization === "string")
    return { ok: false, reason: authorization };
  if (!Number.isSafeInteger(chainId) || chainId <= 0)
    return { ok: false, reason: "invalid chainId" };
  const chain = `eip155:${chainId}`;
  const selected = authorization.grants.filter(
    (grant) => parseAsset(grant.asset)?.chain === chain,
  );
  if (selected.length === 0) return { ok: false, reason: "no grants on chain" };
  if (
    selected.some((grant) =>
      grant.rails.some((rail) => rail !== "transfer" && rail !== "x402-exact"),
    )
  ) {
    return { ok: false, reason: "rail is not expressible by EVM scope" };
  }
  const recipients = selected[0].recipients;
  const maxCount = selected[0].maxCount;
  if (
    selected.some(
      (grant) =>
        !sameStrings(grant.recipients, recipients) ||
        grant.maxCount !== maxCount,
    )
  ) {
    return { ok: false, reason: "recipient sets or counts differ" };
  }
  const seen = new Set<string>();
  for (const grant of selected) {
    if (seen.has(grant.asset))
      return {
        ok: false,
        reason: "duplicate asset grants are not faithfully expressible",
      };
    seen.add(grant.asset);
  }
  const tokenGrants = selected.filter(
    (grant) => parseAsset(grant.asset)?.kind === "erc20",
  );
  const nativeGrant = selected.find(
    (grant) => parseAsset(grant.asset)?.kind === "native",
  );
  const scope: SessionKeyScope = {
    expiry: authorization.expiresAt,
    maxValuePerTx: nativeGrant?.maxPerPayment ?? 0n,
    maxTotalValue: nativeGrant?.maxTotal ?? 0n,
    allowedContracts: tokenGrants.map(
      (grant) => (parseAsset(grant.asset) as ParsedAsset).address,
    ) as `0x${string}`[],
    ...(tokenGrants.length === 0 ? {} : { allowedMethods: ["0xa9059cbb"] }),
    allowedChainIds: [chainId],
    allowedRecipients: recipients as `0x${string}`[],
    ...(nativeGrant
      ? { nativeTransfer: "empty-calldata-to-recipients" as const }
      : {}),
    mode: "offchain",
    ...(maxCount === undefined ? {} : { maxTxCount: maxCount }),
  };
  const periodLimits: NonNullable<SessionKeyScope["periodLimits"]> = {};
  for (const grant of tokenGrants) {
    const asset = parseAsset(grant.asset) as ParsedAsset;
    scope.tokenAllowances ??= {};
    scope.tokenAllowances[asset.address as `0x${string}`] = grant.maxTotal;
    if (grant.maxPerPayment < grant.maxTotal) {
      scope.tokenMaxPerTx ??= {};
      scope.tokenMaxPerTx[asset.address as `0x${string}`] = grant.maxPerPayment;
    }
    if (grant.period) {
      periodLimits[asset.address as `0x${string}`] = { ...grant.period };
    }
  }
  if (nativeGrant?.period) periodLimits.native = { ...nativeGrant.period };
  if (Object.keys(periodLimits).length > 0) scope.periodLimits = periodLimits;
  return { ok: true, scope, enforcement: "device" };
}

export function compileSolanaSessionScope(
  value: Authorization,
  cluster: string,
  options: CompileOptions = {},
): CompileResult<SolanaSessionKeyScope> {
  if (options.requireOnChain)
    return { ok: false, reason: "on-chain enforcement is not available" };
  const authorization = validatedForCompile(value);
  if (typeof authorization === "string")
    return { ok: false, reason: authorization };
  if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(cluster))
    return { ok: false, reason: "invalid cluster" };
  const selected = authorization.grants.filter(
    (grant) => parseAsset(grant.asset)?.chain === cluster,
  );
  if (selected.length !== 1)
    return { ok: false, reason: "exactly one token grant is required" };
  const grant = selected[0];
  if (
    grant.rails.some(
      (rail) =>
        rail !== "transfer" && rail !== "mpp-charge" && rail !== "x402-exact",
    )
  ) {
    return { ok: false, reason: "rail is not expressible by Solana scope" };
  }
  if (grant.maxTotal > U64_MAX || grant.maxPerPayment > U64_MAX) {
    return { ok: false, reason: "amount exceeds Solana u64" };
  }
  const asset = parseAsset(grant.asset) as ParsedAsset;
  return {
    ok: true,
    scope: {
      cluster,
      mint: asset.address as string,
      budget: grant.maxTotal,
      maxPerPayment: grant.maxPerPayment,
      allowedRecipients: [...grant.recipients],
      expiry: authorization.expiresAt,
      ...(grant.maxCount === undefined ? {} : { maxTxCount: grant.maxCount }),
      ...(grant.period === undefined ? {} : { period: { ...grant.period } }),
    },
    enforcement: "device",
  };
}

export function compileMppSession(
  value: Authorization,
  cluster: string,
  context: MppSessionCompileContext,
  options: CompileOptions = {},
): CompileResult<CompiledMppSession> {
  if (options.requireOnChain)
    return { ok: false, reason: "on-chain enforcement is not available" };
  const authorization = validatedForCompile(value);
  if (typeof authorization === "string")
    return { ok: false, reason: authorization };
  if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(cluster))
    return { ok: false, reason: "invalid cluster" };
  const selected = authorization.grants.filter(
    (grant) =>
      parseAsset(grant.asset)?.chain === cluster &&
      grant.rails.includes("mpp-session"),
  );
  if (selected.length !== 1)
    return { ok: false, reason: "exactly one mpp-session grant is required" };
  const grant = selected[0];
  if (grant.period !== undefined)
    return { ok: false, reason: "MPP session cannot enforce period" };
  if (grant.rails.length !== 1)
    return { ok: false, reason: "mixed rails are not faithfully expressible" };
  if (grant.recipients.length !== 1)
    return { ok: false, reason: "MPP session requires exactly one recipient" };
  if (grant.maxCount !== undefined)
    return { ok: false, reason: "MPP session cannot enforce maxCount" };
  const channelProgram = canonicalSolanaAddress(context.channelProgram);
  const payer = canonicalSolanaAddress(context.payer);
  if (
    !channelProgram ||
    !payer ||
    typeof context.pricePerUnit !== "bigint" ||
    context.pricePerUnit <= 0n ||
    context.pricePerUnit > U64_MAX
  ) {
    return { ok: false, reason: "invalid MPP context" };
  }
  if (
    typeof context.deposit !== "bigint" ||
    context.deposit < grant.maxTotal ||
    context.deposit > U64_MAX
  ) {
    return { ok: false, reason: "deposit must cover maxTotal" };
  }
  if (grant.maxTotal > U64_MAX || BigInt(authorization.expiresAt) > I64_MAX) {
    return { ok: false, reason: "authorization exceeds MPP integer bounds" };
  }
  if (
    context.minimumGracePeriodSeconds !== undefined &&
    (!Number.isSafeInteger(context.minimumGracePeriodSeconds) ||
      context.minimumGracePeriodSeconds <= 0)
  ) {
    return { ok: false, reason: "invalid minimum grace period" };
  }
  const mint = (parseAsset(grant.asset) as ParsedAsset).address as string;
  const recipient = grant.recipients[0];
  return {
    ok: true,
    scope: {
      voucher: {
        cluster,
        channelProgram,
        payer,
        mint,
        payee: recipient,
        pricePerUnit: context.pricePerUnit,
        maxCumulative: grant.maxTotal,
        maxDelta: grant.maxPerPayment,
        expiry: authorization.expiresAt,
      },
      client: {
        recipient,
        amount: context.pricePerUnit,
        deposit: context.deposit,
        maxCumulative: grant.maxTotal,
        maxDelta: grant.maxPerPayment,
        expiresAt: authorization.expiresAt,
        ...(context.minimumGracePeriodSeconds === undefined
          ? {}
          : { minimumGracePeriodSeconds: context.minimumGracePeriodSeconds }),
      },
    },
    enforcement: "device",
  };
}

const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

function sameAddresses(left: string[] | undefined, right: string[]): boolean {
  if (!left || left.length !== right.length) return false;
  const normalized = left.map((value) => value.toLowerCase()).sort();
  return right
    .map((value) => value.toLowerCase())
    .sort()
    .every((value, index) => value === normalized[index]);
}

function decompileEvm(raw: SessionKeyInfo): ListedAuthorization {
  const { scope } = raw;
  const flags: ListedAuthorizationFlag[] = [];
  const grants: Grant[] = [];
  const spent: Record<string, bigint> = {};
  const recipients = scope.allowedRecipients;
  const chains = scope.allowedChainIds;

  if (!recipients?.length) flags.push("unrestricted-recipient-legacy");
  if (!chains?.length) flags.push("not-expressible");

  if (recipients?.length && chains?.length) {
    for (const chainId of chains) {
      for (const [token, maxTotal] of Object.entries(
        scope.tokenAllowances ?? {},
      )) {
        if (maxTotal <= 0n) {
          if (!flags.includes("not-expressible")) flags.push("not-expressible");
          continue;
        }
        const perPayment = Object.entries(scope.tokenMaxPerTx ?? {}).find(
          ([limited]) => limited.toLowerCase() === token.toLowerCase(),
        )?.[1];
        if (
          perPayment !== undefined &&
          (perPayment <= 0n || perPayment > maxTotal)
        ) {
          // A cap the model cannot state: list nothing rather than a limit
          // looser than the one the key enforces.
          if (!flags.includes("not-expressible")) flags.push("not-expressible");
          continue;
        }
        const exactPerPayment = perPayment ?? maxTotal;
        const asset = `eip155:${chainId}/erc20:${toChecksumAddress(token)}`;
        grants.push({
          asset,
          recipients: recipients.map(toChecksumAddress),
          maxPerPayment: exactPerPayment,
          maxTotal,
          ...(scope.maxTxCount === undefined
            ? {}
            : { maxCount: scope.maxTxCount }),
          rails: ["transfer", "x402-exact"],
        });
        if (raw.usage) {
          spent[asset] =
            Object.entries(raw.usage.tokenSpent).find(
              ([usedToken]) => usedToken.toLowerCase() === token.toLowerCase(),
            )?.[1] ?? 0n;
        }
      }
      if (
        scope.nativeTransfer === "empty-calldata-to-recipients" &&
        scope.maxValuePerTx !== undefined &&
        scope.maxValuePerTx > 0n &&
        scope.maxTotalValue !== undefined &&
        scope.maxTotalValue > 0n
      ) {
        const asset = `eip155:${chainId}/slip44:60`;
        grants.push({
          asset,
          recipients: recipients.map(toChecksumAddress),
          maxPerPayment: scope.maxValuePerTx,
          maxTotal: scope.maxTotalValue,
          ...(scope.maxTxCount === undefined
            ? {}
            : { maxCount: scope.maxTxCount }),
          rails: ["transfer"],
        });
        if (raw.usage) spent[asset] = raw.usage.valueSpent;
      }
    }
  }

  const tokenAddresses = Object.keys(scope.tokenAllowances ?? {});
  const compiledContractShape = sameAddresses(
    scope.allowedContracts,
    tokenAddresses,
  );
  const compiledMethodShape =
    tokenAddresses.length === 0
      ? scope.allowedMethods === undefined || scope.allowedMethods.length === 0
      : scope.allowedMethods?.length === 1 &&
        scope.allowedMethods[0]?.toLowerCase() === ERC20_TRANSFER_SELECTOR;
  const nativeLimits =
    (scope.maxValuePerTx ?? 0n) > 0n || (scope.maxTotalValue ?? 0n) > 0n;
  const nativeShape = nativeLimits
    ? scope.nativeTransfer === "empty-calldata-to-recipients" &&
      (scope.maxValuePerTx ?? 0n) > 0n &&
      (scope.maxTotalValue ?? 0n) > 0n
    : scope.nativeTransfer === undefined;
  const tokenCapsValid = Object.entries(scope.tokenMaxPerTx ?? {}).every(
    ([token, cap]) =>
      cap > 0n &&
      Object.entries(scope.tokenAllowances ?? {}).some(
        ([allowed, total]) =>
          allowed.toLowerCase() === token.toLowerCase() && cap <= total,
      ),
  );
  if (
    !compiledContractShape ||
    !compiledMethodShape ||
    !nativeShape ||
    !tokenCapsValid ||
    scope.maxGasPerTx !== undefined ||
    scope.maxTotalGas !== undefined
  ) {
    if (!flags.includes("not-expressible")) flags.push("not-expressible");
  }

  // A key created without its owner records the zero address; that is not a
  // principal.
  const principal =
    chains?.length === 1 && !isZeroAddress(raw.signerAddress)
      ? `eip155:${chains[0]}:${toChecksumAddress(raw.signerAddress)}`
      : undefined;
  return {
    enforcer: "evm-session",
    keyId: raw.id,
    status: raw.status,
    ...(principal ? { principal } : {}),
    expiresAt: scope.expiry,
    grants,
    ...(raw.usage ? { spent } : {}),
    flags,
    raw,
  };
}

function decompileSolana(raw: SolanaSessionKeyInfo): ListedAuthorization {
  const asset = `${raw.scope.cluster}/token:${raw.scope.mint}`;
  return {
    enforcer: "solana-session",
    keyId: raw.id,
    status: raw.status,
    principal: `${raw.scope.cluster}:${raw.owner}`,
    expiresAt: raw.scope.expiry,
    grants: [
      {
        asset,
        recipients: [...raw.scope.allowedRecipients],
        maxPerPayment: raw.scope.maxPerPayment,
        maxTotal: raw.scope.budget,
        ...(raw.scope.maxTxCount === undefined
          ? {}
          : { maxCount: raw.scope.maxTxCount }),
        rails: ["transfer", "mpp-charge", "x402-exact"],
      },
    ],
    spent: { [asset]: raw.spent },
    flags: [],
    raw,
  };
}

function decompileMppVoucher(raw: ChannelVoucherKeyInfo): ListedAuthorization {
  const asset = `${raw.policy.cluster}/token:${raw.policy.mint}`;
  return {
    enforcer: "mpp-voucher",
    keyId: raw.id,
    status: raw.status,
    principal: `${raw.policy.cluster}:${raw.policy.payer}`,
    expiresAt: raw.policy.expiry,
    grants: [
      {
        asset,
        recipients: [raw.policy.payee],
        maxPerPayment: raw.policy.maxDelta,
        maxTotal: raw.policy.maxCumulative,
        rails: ["mpp-session"],
      },
    ],
    spent: { [asset]: raw.lastCumulative },
    flags: [],
    raw,
  };
}

/**
 * Read the managers' public records and present their effective value-transfer
 * authorizations. Voucher listing retains the manager's existing behavior of
 * decrypting every stored voucher key; this helper adds no cache or storage.
 */
export async function listAuthorizations(
  managers: AuthorizationManagers,
): Promise<ListedAuthorization[]> {
  const [evm, solana, mppVoucher] = await Promise.all([
    managers.evm?.listSessions() ?? [],
    managers.solana?.listSessions() ?? [],
    managers.mppVoucher?.list() ?? [],
  ]);
  return [
    ...evm.map(decompileEvm),
    ...solana.map(decompileSolana),
    ...mppVoucher.map(decompileMppVoucher),
  ];
}

/**
 * Revoke the owning manager's local record. Solana delegate authority remains
 * live on chain until the app calls `prepareRevocation`, obtains the owner's
 * signature, and broadcasts that signed transaction; this helper never signs
 * or broadcasts.
 */
export async function revokeListedAuthorization(
  managers: AuthorizationManagers,
  entry: ListedAuthorization,
): Promise<RevokeListedAuthorizationResult> {
  if (entry.enforcer === "evm-session") {
    if (!managers.evm) throw new Error("EVM session-key manager is required");
    await managers.evm.revokeSession(entry.keyId);
    return { onChainRevocationRequired: false };
  }
  if (entry.enforcer === "solana-session") {
    if (!managers.solana)
      throw new Error("Solana session-key manager is required");
    await managers.solana.revoke(entry.keyId);
    return { onChainRevocationRequired: true };
  }
  if (!managers.mppVoucher)
    throw new Error("MPP voucher-key manager is required");
  await managers.mppVoucher.revoke(entry.keyId);
  return { onChainRevocationRequired: false };
}
