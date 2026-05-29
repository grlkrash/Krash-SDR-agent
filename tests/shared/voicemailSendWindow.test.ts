import { describe, expect, it } from 'vitest';
import { isTcpaCallingHoursOpen, isVm1SendWindowOpen } from '../../src/shared/voicemailSendWindow.js';

describe('isVm1SendWindowOpen', () => {
  it('blocks vm-1 during weekday business hours in ET', () => {
    // Tue May 27 2025 14:00 UTC = 10:00 ET (FL)
    const result = isVm1SendWindowOpen('FL', new Date('2025-05-27T14:00:00Z'));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('business-hours-vm1-deferred');
      expect(result.timezone).toBe('America/New_York');
    }
  });

  it('allows vm-1 on weekday evenings in ET', () => {
    // Tue May 27 2025 23:00 UTC = 19:00 ET
    const result = isVm1SendWindowOpen('FL', new Date('2025-05-27T23:00:00Z'));
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.timezone).toBe('America/New_York');
    }
  });

  it('allows vm-1 on weekends regardless of hour', () => {
    // Sat May 31 2025 15:00 UTC = 11:00 ET
    const result = isVm1SendWindowOpen('NY', new Date('2025-05-31T15:00:00Z'));
    expect(result.allowed).toBe(true);
  });

  it('blocks vm-1 during weekday business hours in PT', () => {
    // Mon Jun 2 2025 18:00 UTC = 11:00 PT (CA)
    const result = isVm1SendWindowOpen('CA', new Date('2025-06-02T18:00:00Z'));
    expect(result.allowed).toBe(false);
  });

  it('defers when state timezone is unknown', () => {
    const result = isVm1SendWindowOpen('XX', new Date('2025-05-27T23:00:00Z'));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('unknown-state-timezone');
    }
  });
});

describe('isTcpaCallingHoursOpen', () => {
  it('blocks before 8 AM local', () => {
    // Tue May 27 2025 11:00 UTC = 07:00 ET (FL)
    const result = isTcpaCallingHoursOpen('FL', new Date('2025-05-27T11:00:00Z'));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('tcpa-before-8am-local');
    }
  });

  it('blocks at 9 PM local and later', () => {
    // Tue May 27 2025 01:00 UTC = 21:00 ET previous calendar day... 
    // Tue May 27 2025 02:00 UTC = 22:00 ET Mon May 26 — use Wed for clarity
    // Wed May 28 2025 01:00 UTC = 21:00 ET Tue May 27
    const result = isTcpaCallingHoursOpen('NY', new Date('2025-05-28T01:00:00Z'));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('tcpa-after-9pm-local');
    }
  });

  it('allows mid-day local', () => {
    // Tue May 27 2025 17:00 UTC = 13:00 ET
    const result = isTcpaCallingHoursOpen('NY', new Date('2025-05-27T17:00:00Z'));
    expect(result.allowed).toBe(true);
  });
});
