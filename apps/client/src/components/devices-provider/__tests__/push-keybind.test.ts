import { describe, expect, it } from 'bun:test';
import {
  formatPushKeybindLabel,
  matchesPushKeybind,
  normalizePushKeybind,
  pushKeybindFromKeyState
} from '../push-keybind';

describe('push-keybind', () => {
  it('normalizes aliases and trims whitespace', () => {
    expect(normalizePushKeybind(' Ctrl + Shift + KeyV ')).toBe(
      'Control+Shift+KeyV'
    );
  });

  it('rejects modifier-only keybinds', () => {
    expect(normalizePushKeybind('Control+Shift')).toBeUndefined();
  });

  it('serializes key state as canonical keybind', () => {
    expect(
      pushKeybindFromKeyState({
        code: 'KeyV',
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
        metaKey: false
      })
    ).toBe('Control+Shift+KeyV');
  });

  it('matches expected keybind using exact modifiers', () => {
    expect(
      matchesPushKeybind(
        {
          code: 'KeyV',
          ctrlKey: true,
          altKey: false,
          shiftKey: true,
          metaKey: false
        },
        'Control+Shift+KeyV'
      )
    ).toBe(true);

    expect(
      matchesPushKeybind(
        {
          code: 'KeyV',
          ctrlKey: true,
          altKey: true,
          shiftKey: true,
          metaKey: false
        },
        'Control+Shift+KeyV'
      )
    ).toBe(false);
  });

  it('formats keybind labels for UI', () => {
    expect(formatPushKeybindLabel('Control+Shift+KeyV')).toBe('Ctrl + Shift + V');
    expect(formatPushKeybindLabel(undefined)).toBe('Not set');
  });
});
