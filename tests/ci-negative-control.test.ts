import { describe, expect, it } from 'vitest';

// Throwaway negative control for the CI workflow PR: proves the Test step
// can actually go red on a clean runner. This branch is never merged.
describe('ci negative control', () => {
  it('fails deliberately', () => {
    expect(1).toBe(2);
  });
});
