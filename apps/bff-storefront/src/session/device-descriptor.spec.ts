import { describe, expect, it } from 'vitest';

import { DeviceKind } from '@arthome/core';

import { deviceDescriptorOf } from './device-descriptor.js';

const DESKTOP_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const PHONE_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

describe('the device a browser is described as', () => {
  it('is labelled by its User-Agent, trimmed and cut at 80 characters', () => {
    const { label } = deviceDescriptorOf({ 'user-agent': `  ${DESKTOP_AGENT}  ` });
    expect(label).toBe(DESKTOP_AGENT.slice(0, 80));
    expect(deviceDescriptorOf({ 'user-agent': ' Short agent ' }).label).toBe('Short agent');
  });

  it('is unknown when the browser sends no User-Agent, or a blank one', () => {
    expect(deviceDescriptorOf({}).label).toBe('unknown');
    expect(deviceDescriptorOf({ 'user-agent': '   ' }).label).toBe('unknown');
  });

  it('is a phone by the mobile client hint, or by an agent holding Mobi', () => {
    expect(deviceDescriptorOf({ 'sec-ch-ua-mobile': '?1', 'user-agent': DESKTOP_AGENT }).kind).toBe(
      DeviceKind.MOBILE,
    );
    expect(deviceDescriptorOf({ 'user-agent': PHONE_AGENT }).kind).toBe(DeviceKind.MOBILE);
  });

  it('is a desktop otherwise', () => {
    expect(deviceDescriptorOf({ 'sec-ch-ua-mobile': '?0', 'user-agent': DESKTOP_AGENT }).kind).toBe(
      DeviceKind.DESKTOP,
    );
    expect(deviceDescriptorOf({}).kind).toBe(DeviceKind.DESKTOP);
  });
});
