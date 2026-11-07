import { describe, expect, it } from 'vitest';

import { acceptedCountersign, requiresShield, rolloutVerdict } from './gate';

const hash = 'f'.repeat(64);

describe('shield requirement', () => {
  it('applies above the 15% agent cap or on CRITICAL_TIER_1 targets', () => {
    expect(requiresShield(9, 15, 'TIER_2')).toBe(false);
    expect(requiresShield(15, 15, 'TIER_2')).toBe(false);
    expect(requiresShield(15.01, 15, 'TIER_2')).toBe(true);
    expect(requiresShield(2, 15, 'CRITICAL_TIER_1')).toBe(true);
  });
});

describe('scoped agent identity', () => {
  it('only honours a countersignature from the signed-in app UI', () => {
    expect(acceptedCountersign(true, 'frontend')).toBe(true);
    for (const caller of ['tool', 'mcp', 'a2a', 'cli', 'webmcp', 'http', undefined] as const) {
      expect(acceptedCountersign(true, caller)).toBe(false);
    }
  });

  it('blocks an agent that claims a human signature with the right hash', () => {
    const verdict = rolloutVerdict({ shield: true, humanCountersigned: true, caller: 'tool', providedHash: hash, currentHash: hash });
    expect(verdict).toEqual({ allowed: false, countersignatureAccepted: false, hashMatches: true });
  });

  it('blocks an operator approving a hash that no longer matches the patch', () => {
    const verdict = rolloutVerdict({ shield: true, humanCountersigned: true, caller: 'frontend', providedHash: 'e'.repeat(64), currentHash: hash });
    expect(verdict.allowed).toBe(false);
  });

  it('lets the operator countersign the exact patch', () => {
    expect(rolloutVerdict({ shield: true, humanCountersigned: true, caller: 'frontend', providedHash: hash, currentHash: hash })).toEqual({ allowed: true, approvedBy: 'operator' });
  });

  it('lets the agent roll out an unshielded patch on its own', () => {
    expect(rolloutVerdict({ shield: false, humanCountersigned: false, caller: 'tool', providedHash: undefined, currentHash: hash })).toEqual({ allowed: true, approvedBy: 'agent:autonomous' });
  });
});
