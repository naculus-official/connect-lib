export interface WalletPermission {
  parentCapability: string;
  invoker: string;
  date?: number;
  caveats?: { type: string; value: unknown }[];
}

export interface PermissionsRequest {
  eth_accounts: Record<string, never>;
}

export async function getPermissions(provider: {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}): Promise<WalletPermission[] | null> {
  try {
    const result = (await provider.request({
      method: "wallet_getPermissions",
    })) as WalletPermission[];
    return result?.length > 0 ? result : null;
  } catch {
    return null;
  }
}

export async function requestPermissions(provider: {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}): Promise<WalletPermission[]> {
  const result = (await provider.request({
    method: "wallet_requestPermissions",
    params: [{ eth_accounts: {} }],
  })) as WalletPermission[];
  return result;
}

export function extractAccountsFromPermissions(
  permissions: WalletPermission[],
): string[] {
  const ethAccountsPerm = permissions.find(
    (p) => p.parentCapability === "eth_accounts",
  );
  if (!ethAccountsPerm) return [];

  const caveat = ethAccountsPerm.caveats?.find(
    (c) => c.type === "restrictReturnedAccounts",
  );
  if (caveat && Array.isArray(caveat.value)) {
    return caveat.value as string[];
  }

  return [];
}

export function hasPermission(
  permissions: WalletPermission[] | null,
  capability: string,
): boolean {
  if (!permissions) return false;
  return permissions.some((p) => p.parentCapability === capability);
}
