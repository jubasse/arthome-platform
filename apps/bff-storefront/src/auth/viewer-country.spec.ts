import { describe, expect, it } from 'vitest';

import { UNKNOWN_COUNTRY, viewerCountryOf } from './viewer-country.js';

describe('the visitor’s country at sign-up', () => {
  it('is the gateway’s header, upper-cased, when one is named and it holds a country', () => {
    expect(viewerCountryOf({ 'cf-ipcountry': 'be' }, 'cf-ipcountry')).toBe('BE');
  });

  it('is the unknown region otherwise, never a guess', () => {
    expect(viewerCountryOf({ 'cf-ipcountry': 'BE' }, null)).toBe(UNKNOWN_COUNTRY);
    expect(viewerCountryOf({}, 'cf-ipcountry')).toBe(UNKNOWN_COUNTRY);
    expect(viewerCountryOf({ 'cf-ipcountry': 'XX1' }, 'cf-ipcountry')).toBe(UNKNOWN_COUNTRY);
    expect(viewerCountryOf({ 'cf-ipcountry': ['BE', 'FR'] }, 'cf-ipcountry')).toBe(UNKNOWN_COUNTRY);
  });
});
