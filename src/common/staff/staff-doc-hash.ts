import { createHmac } from 'crypto';

/**
 * Huella del documento de identidad de un empleado: HMAC-SHA256 con
 * STAFF_JWT_SECRET del número normalizado (sin espacios, puntos ni guiones).
 * auth-service la guarda en staff_users y la pone en el token del empleado;
 * kyc-service la recalcula con el documento de una verificación para impedir
 * que un empleado apruebe la suya. El número nunca se guarda en claro.
 * Este archivo es idéntico en auth-service y kyc-service.
 */
export function staffDocHash(secret: string, numeroDocumento: string): string {
  const normalized = String(numeroDocumento)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
  return createHmac('sha256', secret).update(`staff-doc:${normalized}`).digest('hex');
}
