import { describe, expect, it } from 'bun:test';
import { getVideoBitratePolicy } from '../video-bitrate-policy';

describe('getVideoBitratePolicy', () => {
  it('uses hardcoded start bitrate for common screen combos', () => {
    const fullHd30 = getVideoBitratePolicy({
      profile: 'screen',
      width: 1920,
      height: 1080,
      frameRate: 30
    });
    const fullHd60 = getVideoBitratePolicy({
      profile: 'screen',
      width: 1920,
      height: 1080,
      frameRate: 60
    });
    const qhd30 = getVideoBitratePolicy({
      profile: 'screen',
      width: 2560,
      height: 1440,
      frameRate: 30
    });

    expect(fullHd30.startKbps).toBe(5000);
    expect(fullHd30.maxKbps).toBe(7500);
    expect(fullHd60.startKbps).toBe(7600);
    expect(fullHd60.maxKbps).toBe(11400);
    expect(qhd30.startKbps).toBe(7000);
    expect(qhd30.maxKbps).toBe(10500);
  });

  it('uses hardcoded camera buckets by resolution and frame rate', () => {
    const hd30 = getVideoBitratePolicy({
      profile: 'camera',
      width: 1280,
      height: 720,
      frameRate: 30
    });
    const fullHd60 = getVideoBitratePolicy({
      profile: 'camera',
      width: 1920,
      height: 1080,
      frameRate: 60
    });

    expect(hd30.startKbps).toBe(1400);
    expect(hd30.maxKbps).toBe(1890);
    expect(fullHd60.startKbps).toBe(3500);
    expect(fullHd60.maxKbps).toBe(4725);
  });

  it('caps to highest bucket for extreme requests', () => {
    const screenExtreme = getVideoBitratePolicy({
      profile: 'screen',
      width: 7680,
      height: 4320,
      frameRate: 240
    });
    const cameraExtreme = getVideoBitratePolicy({
      profile: 'camera',
      width: 9999,
      height: 9999,
      frameRate: 240
    });

    expect(screenExtreme.startKbps).toBe(30000);
    expect(screenExtreme.maxKbps).toBe(45000);
    expect(cameraExtreme.startKbps).toBe(11000);
    expect(cameraExtreme.maxKbps).toBe(14850);
  });
});
