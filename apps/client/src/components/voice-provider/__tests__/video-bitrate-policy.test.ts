import { describe, expect, it } from 'bun:test';
import { getVideoBitratePolicy } from '../video-bitrate-policy';

describe('getVideoBitratePolicy', () => {
  it('scales bitrate upward as resolution and framerate increase', () => {
    const baseline = getVideoBitratePolicy({
      profile: 'screen',
      width: 1920,
      height: 1080,
      frameRate: 30,
      codecMimeType: 'video/H264'
    });
    const highLoad = getVideoBitratePolicy({
      profile: 'screen',
      width: 3840,
      height: 2160,
      frameRate: 120,
      codecMimeType: 'video/H264'
    });

    expect(highLoad.minKbps).toBeGreaterThan(baseline.minKbps);
    expect(highLoad.startKbps).toBeGreaterThan(baseline.startKbps);
    expect(highLoad.maxKbps).toBeGreaterThan(baseline.maxKbps);
  });

  it('uses lower bitrate targets for AV1 than VP8 at same profile and size', () => {
    const vp8 = getVideoBitratePolicy({
      profile: 'screen',
      width: 2560,
      height: 1440,
      frameRate: 30,
      codecMimeType: 'video/VP8'
    });
    const av1 = getVideoBitratePolicy({
      profile: 'screen',
      width: 2560,
      height: 1440,
      frameRate: 30,
      codecMimeType: 'video/AV1'
    });

    expect(av1.minKbps).toBeLessThan(vp8.minKbps);
    expect(av1.startKbps).toBeLessThan(vp8.startKbps);
    expect(av1.maxKbps).toBeLessThan(vp8.maxKbps);
  });

  it('keeps values ordered and capped for extreme requests', () => {
    const policy = getVideoBitratePolicy({
      profile: 'screen',
      width: 7680,
      height: 4320,
      frameRate: 120,
      codecMimeType: 'video/H264'
    });

    expect(policy.minKbps).toBeGreaterThan(0);
    expect(policy.startKbps).toBeGreaterThan(policy.minKbps);
    expect(policy.maxKbps).toBeGreaterThan(policy.startKbps);
    expect(policy.maxKbps).toBeLessThanOrEqual(45_000);
    expect(policy.maxBitrateBps).toBe(policy.maxKbps * 1000);
  });
});
