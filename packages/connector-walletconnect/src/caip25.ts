export interface CAIP25NamespaceProposal {
  chains?: string[];
  methods: string[];
  events: string[];
}

export interface CAIP25SessionProposal {
  requiredNamespaces: Record<string, CAIP25NamespaceProposal>;
  optionalNamespaces?: Record<string, CAIP25NamespaceProposal>;
}

export interface CAIP25ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const CAIP2_REGEX = /^[-a-z0-9]{1,32}:[-a-zA-Z0-9]{1,64}$/;

export function isValidCAIP2(chainId: string): boolean {
  return CAIP2_REGEX.test(chainId);
}

export function validateCAIP25Namespace(
  namespace: string,
  proposal: CAIP25NamespaceProposal,
  required: boolean,
): string[] {
  const errors: string[] = [];

  if (required && (!proposal.chains || proposal.chains.length === 0)) {
    errors.push(`Namespace "${namespace}": chains are required`);
  }

  if (proposal.chains) {
    for (const chainId of proposal.chains) {
      if (!isValidCAIP2(chainId)) {
        errors.push(
          `Namespace "${namespace}": invalid CAIP-2 chain "${chainId}"`,
        );
      }
    }
  }

  if (required && (!proposal.methods || proposal.methods.length === 0)) {
    errors.push(`Namespace "${namespace}": methods are required`);
  }

  if (!proposal.events) {
    errors.push(`Namespace "${namespace}": events array is required`);
  }

  return errors;
}

export function validateCAIP25Proposal(
  proposal: CAIP25SessionProposal,
): CAIP25ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (
    !proposal.requiredNamespaces ||
    Object.keys(proposal.requiredNamespaces).length === 0
  ) {
    errors.push("requiredNamespaces is required and cannot be empty");
  } else {
    for (const [namespace, nsProposal] of Object.entries(
      proposal.requiredNamespaces,
    )) {
      const namespaceErrors = validateCAIP25Namespace(
        namespace,
        nsProposal,
        true,
      );
      errors.push(...namespaceErrors);
    }
  }

  if (proposal.optionalNamespaces) {
    for (const [namespace, nsProposal] of Object.entries(
      proposal.optionalNamespaces,
    )) {
      if (!proposal.requiredNamespaces[namespace]) {
        const namespaceErrors = validateCAIP25Namespace(
          namespace,
          nsProposal,
          false,
        );
        warnings.push(...namespaceErrors.map((e) => `optional: ${e}`));
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
