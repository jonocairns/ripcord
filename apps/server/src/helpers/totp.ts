import { sha256 } from '@sharkord/shared';
import crypto from 'crypto';
import { Secret, TOTP } from 'otpauth';
import QRCode from 'qrcode';
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

// ---- Recovery Codes ----

const generateRecoveryCodes = async (): Promise<{
  plainCodes: string[];
  hashedCodes: string[];
}> => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const plainCodes: string[] = [];

  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    let code = '';
    const bytes = crypto.randomBytes(RECOVERY_CODE_LENGTH);
    for (let j = 0; j < RECOVERY_CODE_LENGTH; j++) {
      code += chars[bytes[j]! % chars.length];
    }
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

type TChallengePayload = {
  userId: number;
  purpose: '2fa-challenge';
};

const verifyChallengeToken = async (
  token: string
): Promise<TChallengePayload | null> => {
  try {
    const jwt = await import('jsonwebtoken');
    const serverToken = await getServerToken();
    const decoded = jwt.default.verify(token, serverToken) as TChallengePayload;

    if (decoded.purpose !== '2fa-challenge') {
      return null;
    }

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
  verifyChallengeToken,
  verifyRecoveryCode,
  verifyTotpToken
};
