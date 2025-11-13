import { useCallback, useRef } from 'react';

const useLog = () => {
  const logs = useRef<string[]>([]);

  const log = useCallback((...args: unknown[]) => {
    const formatArg = (v: unknown) => {
      if (typeof v === 'string') return v;
      if (v instanceof Error) return v.stack ?? v.message;
      try {
        const seen = new Set();
        return JSON.stringify(
          v,
          (_key, val) => {
            if (val && typeof val === 'object') {
              if (seen.has(val)) return '[Circular]';
              seen.add(val);
            }
            return val;
          },
          2
        );
      } catch {
        return String(v);
      }
    };

    const message = args.map(formatArg).join(' ');

    logs.current.push(message);

    if (!import.meta.env.PROD) {
      console.log(
        '%c[VOICE-PROVIDER]',
        'color: red; font-weight: bold;',
        ...args
      );
    }
  }, []);

  return { log, logs };
};

export { useLog };
