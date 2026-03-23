import { sha256 } from '@sharkord/shared';
import crypto from 'crypto';
import { Secret, TOTP } from 'otpauth';
import QRCode from 'qrcode';
import { z } from 'zod';
import { getServerToken } from '../db/queries/server';

const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_LENGTH = 8;

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// ---- Encryption (AES-256-GCM) ----

const deriveEncryptionKey = (serverToken: string): Buffer => {
  return crypto.createHash('sha256').update(serverToken).digest();
};

const encryptTotpSecret = async (secret: string): Promise<string> => {
  const serverToken = await getServerToken();
  const key = deriveEncryptionKey(serverToken);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH
  });

  const encrypted = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all base64)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
};

const decryptTotpSecret = async (encrypted: string): Promise<string> => {
  const serverToken = await getServerToken();
  const key = deriveEncryptionKey(serverToken);
  const parts = encrypted.split(':');
  const ivB64 = parts[0]!;
  const authTagB64 = parts[1]!;
  const ciphertextB64 = parts[2]!;

  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
};

// ---- TOTP Generation / Verification ----

type TTotpSetupResult = {
  secret: string; // base32-encoded secret (plain, for encryption before storage)
  uri: string; // otpauth:// URI
  qrCodeDataUrl: string; // data:image/png;base64,...
};

const generateTotpSetup = async (
  identity: string,
  serverName: string
): Promise<TTotpSetupResult> => {
  const secret = new Secret({ size: 20 });
  const totp = new TOTP({
    issuer: serverName,
    label: identity,
    secret,
    period: TOTP_PERIOD,
    digits: TOTP_DIGITS
  });

  const uri = totp.toString();
  const qrCodeDataUrl = await QRCode.toDataURL(uri);

  return {
    secret: secret.base32,
    uri,
    qrCodeDataUrl
  };
};

const verifyTotpToken = (secret: string, token: string): boolean => {
  const totp = new TOTP({
    secret: Secret.fromBase32(secret),
    period: TOTP_PERIOD,
    digits: TOTP_DIGITS
  });

  const delta = totp.validate({ token, window: TOTP_WINDOW });
  return delta !== null;
};

// ---- TOTP Replay Prevention ----
// Tracks recently consumed (userId, code) pairs to prevent the same code from
// being accepted twice within its validity window (TOTP_PERIOD * (2*TOTP_WINDOW + 1)).

const REPLAY_WINDOW_MS = TOTP_PERIOD * (2 * TOTP_WINDOW + 1) * 1000; // 90s
const REPLAY_CLEANUP_INTERVAL_MS = 60_000;

/** Map of "userId:code" → expiry timestamp (ms) */
const usedTotpCodes = new Map<string, number>();

let replayCleanupTimer: ReturnType<typeof setInterval> | null = null;

const ensureReplayCleanup = () => {
  if (replayCleanupTimer) return;
  replayCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, expiry] of usedTotpCodes) {
      if (now >= expiry) usedTotpCodes.delete(key);
    }
    if (usedTotpCodes.size === 0 && replayCleanupTimer) {
      clearInterval(replayCleanupTimer);
      replayCleanupTimer = null;
    }
  }, REPLAY_CLEANUP_INTERVAL_MS);
  // Allow the process to exit even if the timer is running
  replayCleanupTimer.unref();
};

/**
 * Validates a TOTP code and marks it as consumed so it cannot be replayed.
 * Returns true only if the code is valid AND has not been used before within
 * the validity window.
 */
const verifyAndConsumeTotpToken = (
  userId: number,
  secret: string,
  token: string
): boolean => {
  const key = `${userId}:${token}`;

  if (usedTotpCodes.has(key)) {
    return false;
  }

  if (!verifyTotpToken(secret, token)) {
    return false;
  }

  usedTotpCodes.set(key, Date.now() + REPLAY_WINDOW_MS);
  ensureReplayCleanup();

  return true;
};

// ---- Recovery Codes ----

const RECOVERY_CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const generateRecoveryCodes = async (): Promise<{
  plainCodes: string[];
  hashedCodes: string[];
}> => {
  const plainCodes: string[] = [];

  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = Array.from(
      { length: RECOVERY_CODE_LENGTH },
      () =>
        RECOVERY_CODE_ALPHABET[crypto.randomInt(RECOVERY_CODE_ALPHABET.length)]
    ).join('');
    plainCodes.push(code);
  }

  const hashedCodes = await Promise.all(plainCodes.map((code) => sha256(code)));

  return { plainCodes, hashedCodes };
};

const verifyRecoveryCode = async (
  inputCode: string,
  hashedCodes: string[]
): Promise<{ valid: boolean; remainingCodes: string[] }> => {
  const inputHash = await sha256(inputCode.toLowerCase().trim());
  const matchIndex = hashedCodes.indexOf(inputHash);

  if (matchIndex === -1) {
    return { valid: false, remainingCodes: hashedCodes };
  }

  const remainingCodes = [
    ...hashedCodes.slice(0, matchIndex),
    ...hashedCodes.slice(matchIndex + 1)
  ];

  return { valid: true, remainingCodes };
};

// ---- Challenge Token (short-lived JWT for 2FA step) ----

const CHALLENGE_TOKEN_EXPIRES_IN = '5m';

const createChallengeToken = async (userId: number): Promise<string> => {
  const jwt = await import('jsonwebtoken');
  const serverToken = await getServerToken();

  return jwt.default.sign({ userId, purpose: '2fa-challenge' }, serverToken, {
    expiresIn: CHALLENGE_TOKEN_EXPIRES_IN
  });
};

const zChallengePayload = z.object({
  userId: z.number(),
  purpose: z.literal('2fa-challenge')
});

type TChallengePayload = z.infer<typeof zChallengePayload>;

const verifyChallengeToken = async (
  token: string
): Promise<TChallengePayload | null> => {
  try {
    const jwt = await import('jsonwebtoken');
    const serverToken = await getServerToken();
    const decoded = zChallengePayload.parse(
      jwt.default.verify(token, serverToken)
    );

    return decoded;
  } catch {
    return null;
  }
};

export {
  createChallengeToken,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSetup,
  verifyAndConsumeTotpToken,
  verifyChallengeToken,
  verifyRecoveryCode,
  verifyTotpToken
};
