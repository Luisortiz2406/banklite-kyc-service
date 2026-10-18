/**
 * Motivos por los que se rechaza una verificación de identidad y cuáles puede
 * aprobar a mano un empleado de Cumplimiento o un administrador.
 *
 * - Aprobables: validaciones que fallaron (servicio caído, respuesta ilegible,
 *   tipo de documento que la fuente no consulta) o datos que no coincidieron.
 * - Reglas duras (nunca se aprueban a mano): menor de edad, documento no vigente
 *   o vencido, fecha de expedición inválida y antecedentes judiciales pendientes.
 *   Menor de edad y fecha de expedición se rechazan antes de guardar el registro,
 *   pero se vuelven a comprobar al aprobar por si los datos cambiaron.
 */
export type RejectionCode =
  | 'documento_tipo_no_soportado'
  | 'documento_no_encontrado'
  | 'documento_sin_nombre'
  | 'nombre_no_coincide'
  | 'antecedentes_tipo_no_soportado'
  | 'antecedentes_no_confirmados'
  | 'documento_no_vigente'
  | 'antecedentes_pendientes'
  | 'menor_de_edad'
  | 'fecha_expedicion_invalida';

export const REJECTION_RULES: Record<RejectionCode, { label: string; approvable: boolean }> = {
  documento_tipo_no_soportado: { label: 'La fuente oficial no consulta este tipo de documento', approvable: true },
  documento_no_encontrado: { label: 'El documento no se encontró en la fuente oficial', approvable: true },
  documento_sin_nombre: { label: 'La fuente oficial no devolvió el nombre', approvable: true },
  nombre_no_coincide: { label: 'El nombre no coincide con el del documento', approvable: true },
  antecedentes_tipo_no_soportado: { label: 'La consulta de antecedentes no admite este documento', approvable: true },
  antecedentes_no_confirmados: { label: 'No se pudo confirmar el estado de antecedentes', approvable: true },
  documento_no_vigente: { label: 'Documento no vigente o vencido', approvable: false },
  antecedentes_pendientes: { label: 'Registra asuntos pendientes con las autoridades', approvable: false },
  menor_de_edad: { label: 'Menor de edad', approvable: false },
  fecha_expedicion_invalida: { label: 'Fecha de expedición inválida', approvable: false },
};

export const EDAD_MINIMA = 18;

/** Etiqueta del motivo; los rechazos anteriores a este catálogo no guardaron el motivo. */
export function rejectionLabel(code: string | null): string | null {
  if (!code) return null;
  return REJECTION_RULES[code as RejectionCode]?.label ?? 'Motivo no registrado';
}

/** ¿El motivo permite aprobar a mano? Sin motivo registrado, no. */
export function isApprovable(code: string | null): boolean {
  return !!code && REJECTION_RULES[code as RejectionCode]?.approvable === true;
}

export function isUnderage(fechaNacimiento: string, today = new Date()): boolean {
  const nacimiento = new Date(fechaNacimiento + 'T00:00:00Z');
  let edad = today.getUTCFullYear() - nacimiento.getUTCFullYear();
  const difMes = today.getUTCMonth() - nacimiento.getUTCMonth();
  if (difMes < 0 || (difMes === 0 && today.getUTCDate() < nacimiento.getUTCDate())) edad--;
  return edad < EDAD_MINIMA;
}

/** La cédula se expide al cumplir 18: una fecha anterior es inválida. */
export function isInvalidIssueDate(fechaNacimiento: string, fechaExpedicion: string): boolean {
  const nacimiento = new Date(fechaNacimiento + 'T00:00:00Z');
  const expedicion = new Date(fechaExpedicion + 'T00:00:00Z');
  const fecha18 = new Date(nacimiento);
  fecha18.setUTCFullYear(fecha18.getUTCFullYear() + EDAD_MINIMA);
  return expedicion < fecha18;
}
