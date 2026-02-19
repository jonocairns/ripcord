type TKeybindState = {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};

const MODIFIER_CODE_MAP = {
  Control: 'ctrlKey',
  Ctrl: 'ctrlKey',
  Alt: 'altKey',
  Shift: 'shiftKey',
  Meta: 'metaKey',
  Command: 'metaKey'
} as const satisfies Record<string, keyof Omit<TKeybindState, 'code'>>;

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight'
]);

const createDefaultKeybindState = (): TKeybindState => ({
  code: '',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false
});

const isModifierCode = (code: string): boolean => MODIFIER_CODES.has(code);

const isModifierToken = (
  token: string
): token is keyof typeof MODIFIER_CODE_MAP => token in MODIFIER_CODE_MAP;

const serializePushKeybind = ({
  code,
  ctrlKey,
  altKey,
  shiftKey,
  metaKey
}: TKeybindState): string | undefined => {
  const normalizedCode = code.trim();

  if (
    !normalizedCode ||
    normalizedCode === 'Unidentified' ||
    isModifierCode(normalizedCode)
  ) {
    return undefined;
  }

  const parts: string[] = [];

  if (ctrlKey) parts.push('Control');
  if (altKey) parts.push('Alt');
  if (shiftKey) parts.push('Shift');
  if (metaKey) parts.push('Meta');
  parts.push(normalizedCode);

  return parts.join('+');
};

const normalizePushKeybind = (keybind: string | undefined): string | undefined => {
  if (!keybind || typeof keybind !== 'string') {
    return undefined;
  }

  const tokens = keybind
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return undefined;
  }

  const parsed = createDefaultKeybindState();

  for (const token of tokens) {
    if (isModifierToken(token)) {
      const modifierKey = MODIFIER_CODE_MAP[token];
      parsed[modifierKey] = true;
      continue;
    }

    if (parsed.code) {
      return undefined;
    }

    parsed.code = token;
  }

  return serializePushKeybind(parsed);
};

const pushKeybindFromKeyState = (
  keyState: TKeybindState
): string | undefined =>
  serializePushKeybind({
    code: keyState.code,
    ctrlKey: keyState.ctrlKey,
    altKey: keyState.altKey,
    shiftKey: keyState.shiftKey,
    metaKey: keyState.metaKey
  });

const matchesPushKeybind = (
  keyState: TKeybindState,
  keybind: string | undefined
): boolean => {
  const normalized = normalizePushKeybind(keybind);

  if (!normalized) {
    return false;
  }

  const expected = normalized.split('+');
  const expectedCode = expected[expected.length - 1];
  const expectedModifiers = new Set(expected.slice(0, -1));

  return (
    keyState.code === expectedCode &&
    keyState.ctrlKey === expectedModifiers.has('Control') &&
    keyState.altKey === expectedModifiers.has('Alt') &&
    keyState.shiftKey === expectedModifiers.has('Shift') &&
    keyState.metaKey === expectedModifiers.has('Meta')
  );
};

const formatKeyCode = (code: string): string => {
  if (code === 'Space') {
    return 'Space';
  }

  if (code.startsWith('Key') && code.length === 4) {
    return code.slice(3).toUpperCase();
  }

  if (code.startsWith('Digit') && code.length === 6) {
    return code.slice(5);
  }

  if (code.startsWith('Numpad')) {
    return `Numpad ${code.slice(6)}`;
  }

  return code
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2');
};

const formatPushKeybindLabel = (keybind: string | undefined): string => {
  const normalized = normalizePushKeybind(keybind);

  if (!normalized) {
    return 'Not set';
  }

  const parts = normalized.split('+');
  const code = parts.pop();

  if (!code) {
    return 'Not set';
  }

  return [
    ...parts.map((modifier) =>
      modifier === 'Control' ? 'Ctrl' : modifier === 'Meta' ? 'Meta' : modifier
    ),
    formatKeyCode(code)
  ].join(' + ');
};

export type { TKeybindState };
export {
  formatPushKeybindLabel,
  matchesPushKeybind,
  normalizePushKeybind,
  pushKeybindFromKeyState
};
