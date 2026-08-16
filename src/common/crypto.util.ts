import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Symmetric encryption for secrets that must live in the database but must not
 * be readable from it — currently the Razorpay API secret.
 *
 * AES-256-GCM, not CBC: GCM is authenticated, so a tampered ciphertext fails to
 * decrypt rather than silently yielding garbage that then gets sent to a
 * payment provider as a key.
 *
 * Stored form is three base64 fields joined by ':' —
 *
 *     <iv>:<authTag>:<ciphertext>
 *
 * — kept in one column so the encrypted value moves as a single unit. A 12-byte
 * IV is generated per encryption, which is what makes encrypting the same
 * secret twice produce different ciphertext.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
/** Marks our format so a legacy plaintext value is recognisable — see decrypt. */
const PREFIX = 'enc.v1';

/**
 * The 32-byte key, derived from SETTINGS_ENCRYPTION_KEY.
 *
 * SHA-256 of the env var rather than the raw bytes, so the variable can be any
 * length passphrase instead of requiring exactly 32 bytes of base64 — the
 * operator sets a long random string and it works.
 *
 * Falls back to JWT_SECRET when unset. That is a deliberate convenience for
 * dev and existing deployments, not a recommendation: rotating JWT_SECRET would
 * then make every stored secret undecryptable, which is why the fallback warns.
 * Set SETTINGS_ENCRYPTION_KEY explicitly in production.
 */
function encryptionKey(): Buffer {
  const source =
    process.env.SETTINGS_ENCRYPTION_KEY || process.env.JWT_SECRET;

  if (!source) {
    throw new Error(
      'Cannot encrypt settings: set SETTINGS_ENCRYPTION_KEY (or JWT_SECRET) in the environment.'
    );
  }

  if (!process.env.SETTINGS_ENCRYPTION_KEY) {
    // Once per process, not per call — this is a deployment note, not a per-write problem.
    if (!warnedAboutFallback) {
      warnedAboutFallback = true;
      console.warn(
        '[crypto] SETTINGS_ENCRYPTION_KEY is not set; falling back to JWT_SECRET. ' +
          'Rotating JWT_SECRET will make stored payment secrets unreadable.'
      );
    }
  }

  return createHash('sha256').update(source).digest();
}

let warnedAboutFallback = false;

/** Encrypts a plaintext secret for storage. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return [
    PREFIX,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Reverses `encryptSecret`.
 *
 * Returns null rather than throwing when the value can't be read — a rotated
 * encryption key or a corrupted row should degrade to "no secret configured"
 * (which the settings screen reports, and the operator re-enters) rather than
 * crash every request that touches settings.
 *
 * A value without our prefix is returned as-is: that is a row written before
 * encryption existed, and treating it as plaintext lets it keep working until
 * the next save re-encrypts it.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;

  const parts = stored.split(':');
  if (parts[0] !== PREFIX || parts.length !== 4) {
    // Pre-encryption plaintext, not a failure.
    return stored;
  }

  const [, ivB64, tagB64, dataB64] = parts;

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      encryptionKey(),
      Buffer.from(ivB64, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    console.error(
      '[crypto] Failed to decrypt a stored secret. The encryption key has most ' +
        'likely changed; the secret must be re-entered.'
    );
    return null;
  }
}

/** The tail shown in the UI in place of the secret ("••••4f2a"). */
export function lastFour(plaintext: string): string {
  return plaintext.slice(-4);
}
