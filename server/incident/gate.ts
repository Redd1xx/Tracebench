// The Scoped Agent Blast-Radius Gate as pure decisions, so who may roll out
// what can be tested without a database or a request.

export type Caller = 'tool' | 'http' | 'frontend' | 'mcp-widget' | 'mcp-widget-write' | 'cli' | 'mcp' | 'webmcp' | 'a2a' | 'automation';

// Only a request proven to come from the signed-in app UI is a human.
export function isOperatorUi(caller: Caller | undefined): boolean {
  return caller === 'frontend';
}

export function acceptedCountersign(humanCountersigned: boolean, caller: Caller | undefined): boolean {
  return humanCountersigned && isOperatorUi(caller);
}

export function requiresShield(blastRadiusPct: number, capPct: number, targetTier: string): boolean {
  return blastRadiusPct > capPct || targetTier === 'CRITICAL_TIER_1';
}

export type RolloutVerdict = { allowed: true; approvedBy: 'operator' | 'agent:autonomous' } | { allowed: false; countersignatureAccepted: boolean; hashMatches: boolean };

export function rolloutVerdict(input: {
  shield: boolean;
  humanCountersigned: boolean;
  caller: Caller | undefined;
  providedHash: string | undefined;
  currentHash: string;
}): RolloutVerdict {
  const countersigned = acceptedCountersign(input.humanCountersigned, input.caller);
  const hashMatches = input.providedHash === input.currentHash;
  if (input.shield && (!countersigned || !hashMatches)) {
    return { allowed: false, countersignatureAccepted: countersigned, hashMatches };
  }
  return { allowed: true, approvedBy: countersigned ? 'operator' : 'agent:autonomous' };
}
