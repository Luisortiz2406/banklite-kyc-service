import {
  EDAD_MINIMA,
  isApprovable,
  isInvalidIssueDate,
  isUnderage,
  REJECTION_RULES,
  rejectionLabel,
} from './rejection-rules';

describe('reglas de rechazo de identidad', () => {
  const hoy = new Date('2026-11-11T12:00:00Z');

  it('es menor de edad hasta el día en que cumple 18, no antes', () => {
    expect(EDAD_MINIMA).toBe(18);
    expect(isUnderage('2008-11-12', hoy)).toBe(true); // cumple 18 mañana
    expect(isUnderage('2008-11-11', hoy)).toBe(false); // hoy cumple 18
    expect(isUnderage('2008-12-01', hoy)).toBe(true);
    expect(isUnderage('1990-01-01', hoy)).toBe(false);
    expect(isUnderage('2020-01-01', hoy)).toBe(true);
  });

  it('sin fecha de hoy usa la actual', () => {
    expect(isUnderage('1990-01-01')).toBe(false);
    expect(isUnderage('2999-01-01')).toBe(true);
  });

  it('la cédula no puede expedirse antes de que la persona cumpla 18', () => {
    expect(isInvalidIssueDate('2000-05-10', '2018-05-09')).toBe(true);
    expect(isInvalidIssueDate('2000-05-10', '2018-05-10')).toBe(false);
    expect(isInvalidIssueDate('2000-05-10', '2019-01-01')).toBe(false);
    expect(isInvalidIssueDate('2000-05-10', '2000-05-10')).toBe(true);
  });

  it('las reglas duras nunca se aprueban a mano; las demás sí', () => {
    for (const code of [
      'menor_de_edad',
      'documento_no_vigente',
      'fecha_expedicion_invalida',
      'antecedentes_pendientes',
    ]) {
      expect(isApprovable(code)).toBe(false);
    }
    for (const code of [
      'documento_tipo_no_soportado',
      'documento_no_encontrado',
      'documento_sin_nombre',
      'nombre_no_coincide',
      'antecedentes_tipo_no_soportado',
      'antecedentes_no_confirmados',
    ]) {
      expect(isApprovable(code)).toBe(true);
    }
    expect(Object.values(REJECTION_RULES).filter((r) => !r.approvable)).toHaveLength(4);
  });

  it('sin motivo o con un motivo desconocido no se puede aprobar a mano', () => {
    expect(isApprovable(null)).toBe(false);
    expect(isApprovable('inventado')).toBe(false);
  });

  it('la etiqueta del motivo: la del catálogo, "no registrado" si es antiguo, y nada si no hay motivo', () => {
    expect(rejectionLabel('menor_de_edad')).toBe('Menor de edad');
    expect(rejectionLabel('inventado')).toBe('Motivo no registrado');
    expect(rejectionLabel(null)).toBeNull();
  });
});
