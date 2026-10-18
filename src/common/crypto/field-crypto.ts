import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';
import { ValueTransformer } from 'typeorm';

/**
 * Cifrado de datos personales sensibles del KYC (documento, fechas, teléfono)
 * en la base: AES-256-GCM con KYC_ENCRYPTION_KEY (64 caracteres hex). Formato
 * guardado: 'v1:' + base64(iv[12] | tag[16] | texto cifrado).
 *
 * Como cada cifrado usa un IV aleatorio, el mismo documento produce textos
 * distintos; para buscar y garantizar unicidad se guarda además un "índice
 * ciego": HMAC-SHA256 del valor normalizado con una llave derivada.
 *
 * Lo usan la entidad (transformer) y scripts/encrypt-kyc-fields.js (migración).
 */
const PREFIX = 'v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKeys: { enc: Buffer; index: Buffer } | undefined;

/**
 * Falla cerrado (igual que card-service): sin llave no se guarda ni se busca
 * nada, en vez de escribir datos de identidad en texto plano o indexarlos con
 * una llave conocida. validateEnv ya impide arrancar el servicio sin ella.
 */
function keys() {
  if (cachedKeys) return cachedKeys;
  const hex = process.env.KYC_ENCRYPTION_KEY;
  if (!hex) throw new Error('KYC_ENCRYPTION_KEY no está configurada: no se pueden guardar datos de identidad.');
  if (!/^[0-9a-fA-F]{64}$/.test(hex))
    throw new Error('KYC_ENCRYPTION_KEY debe tener exactamente 64 caracteres hexadecimales.');
  const enc = Buffer.from(hex, 'hex');
  return (cachedKeys = { enc, index: createHmac('sha256', enc).update('kyc-blind-index').digest() });
}

export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Lo ya cifrado no se vuelve a cifrar. */
export function encryptField(value: unknown): unknown {
  if (typeof value !== 'string' || isEncrypted(value)) return value;
  const k = keys();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', k.enc, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/** Los valores sin el prefijo son datos anteriores al cifrado y se devuelven tal cual. */
export function decryptField(value: unknown): unknown {
  if (!isEncrypted(value)) return value;
  const k = keys();
  const raw = Buffer.from((value as string).slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', k.enc, raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}

/** Índice ciego para búsquedas exactas y unicidad. */
export function blindIndex(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  return createHmac('sha256', keys().index).update(value.trim().toLowerCase()).digest('hex');
}

export const encryptedColumn: ValueTransformer = {
  to: (value) => encryptField(value),
  from: (value) => decryptField(value),
};
