import { sha256 } from '@sharkord/shared';

const ARGON2_PREFIX = 'argon2$';
const RAW_ARGON2_PREFIX = '$argon2';
const RAW_BCRYPT_PREFIX = '$2';

const hashPassword = async (password: string): Promise<string> => {
  const hash = await Bun.password.hash(password, {
    algorithm: 'argon2id'
  });

  return `${ARGON2_PREFIX}${hash}`;
};

const isArgon2Hash = (storedHash: string): boolean => {
  return storedHash.startsWith(ARGON2_PREFIX);
};

const isRawBunHash = (storedHash: string): boolean => {
  return (
    storedHash.startsWith(RAW_ARGON2_PREFIX) ||
    storedHash.startsWith(RAW_BCRYPT_PREFIX)
  );
};

const verifyPassword = async (
  password: string,
  storedHash: string
): Promise<boolean> => {
  if (isArgon2Hash(storedHash)) {
    const hash = storedHash.slice(ARGON2_PREFIX.length);
    return Bun.password.verify(password, hash);
  }

  // Legacy fallback for Bun hashes that were stored without the custom prefix.
  if (isRawBunHash(storedHash)) {
    return Bun.password.verify(password, storedHash);
  }

  // Legacy fallback for previously stored SHA-256 hashes.
  const legacyHash = await sha256(password);

  if (legacyHash === storedHash) {
    return true;
  }

  // Legacy fallback for very early instances that stored plain text passwords.
  return password === storedHash;
};

export { hashPassword, isArgon2Hash, verifyPassword };
