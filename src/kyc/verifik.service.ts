import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RejectionCode } from './rejection-rules';

export interface VerifikResult {
  matched: boolean;
  /** Motivo cuando no coincide (ver rejection-rules.ts). */
  code?: RejectionCode;
  provider: 'verifik' | 'verifik-demo';
  nombreCompleto: string | null;
  message?: string;
}

export interface AntecedentesResult {
  cleared: boolean;
  /** Motivo cuando no se aprueba (ver rejection-rules.ts). */
  code?: RejectionCode;
  provider: 'verifik-antecedentes' | 'verifik-antecedentes-demo';
  nivelRiesgo: string;
  alertas: string[];
  message?: string;
}

// /v2/co/cedula acepta CC y PPT; /v2/co/policia/consultar acepta CC y CE.
const TIPOS_CEDULA = ['CC', 'PPT'];
const TIPOS_POLICIA = ['CC', 'CE'];

// Texto con el que la Policía indica que la persona no tiene antecedentes.
const LEYENDA_LIMPIO = 'NO TIENE ASUNTOS PENDIENTES';
// Verifik consulta fuentes oficiales (Registraduría, Policía): puede tardar.
const VERIFIK_TIMEOUT_MS = 15_000;

/**
 * Verifik en un solo proveedor:
 *   1. verifyDocument     -> /v2/co/cedula            (Registraduría: existe + nombre coincide)
 *   2. verifyAntecedentes -> /v2/co/policia/consultar (antecedentes judiciales, Policía Nacional)
 *
 * Variables de entorno:
 *   VERIFIK_MODE                 demo | live
 *   VERIFIK_API_KEY              token del proyecto en Verifik
 *   VERIFIK_API_URL              por defecto https://api.verifik.co/v2/co/cedula
 *   VERIFIK_ANTECEDENTES_MODE    demo | live (si no se define, usa VERIFIK_MODE)
 *   VERIFIK_ANTECEDENTES_URL     por defecto https://api.verifik.co/v2/co/policia/consultar
 *   VERIFIK_AUTH_SCHEME          jwt | Bearer (la documentación muestra ambos; si recibes 401, cámbialo)
 *   VERIFIK_SKIP_NAME_CHECK      true SOLO para pruebas en Sandbox (los resultados son simulados
 *                                y el nombre puede no coincidir). Nunca en producción.
 */
@Injectable()
export class VerifikService {
  private readonly logger = new Logger(VerifikService.name);

  constructor(private readonly config: ConfigService) {}

  // ---------------------------------------------------------------- Cédula

  async verifyDocument(
    numeroDocumento: string,
    tipoDocumento: string,
    nombreCompletoIngresado: string,
  ): Promise<VerifikResult> {
    const mode = (this.config.get<string>('VERIFIK_MODE') || 'demo').toLowerCase();

    if (mode !== 'live') {
      return {
        matched: true,
        provider: 'verifik-demo',
        nombreCompleto: nombreCompletoIngresado,
        message: 'Modo demo: configura VERIFIK_MODE=live y VERIFIK_API_KEY para consultar Verifik.',
      };
    }

    if (!TIPOS_CEDULA.includes(tipoDocumento)) {
      return {
        matched: false,
        code: 'documento_tipo_no_soportado',
        provider: 'verifik',
        nombreCompleto: null,
        message: `La validación de documento solo admite: ${TIPOS_CEDULA.join(', ')}.`,
      };
    }

    const apiUrl = this.config.get<string>('VERIFIK_API_URL') || 'https://api.verifik.co/v2/co/cedula';
    const { ok, payload } = await this.consultar(apiUrl, {
      documentType: tipoDocumento,
      documentNumber: numeroDocumento,
    });

    if (!ok || !payload?.data) {
      return {
        matched: false,
        code: 'documento_no_encontrado',
        provider: 'verifik',
        nombreCompleto: null,
        message: 'El documento no fue encontrado en la fuente oficial.',
      };
    }

    const nombreOficial = String(payload.data.fullName || '').trim();
    if (!nombreOficial) {
      this.logger.warn(`Respuesta de cédula sin fullName. Campos recibidos: ${Object.keys(payload.data).join(', ')}`);
      return {
        matched: false,
        code: 'documento_sin_nombre',
        provider: 'verifik',
        nombreCompleto: null,
        message: 'Verifik no devolvió el nombre asociado al documento.',
      };
    }

    if (payload.data.isAlive === false) {
      return {
        matched: false,
        code: 'documento_no_vigente',
        provider: 'verifik',
        nombreCompleto: nombreOficial,
        message: 'El documento figura como no vigente en la fuente oficial.',
      };
    }

    const omitirNombre = String(this.config.get<string>('VERIFIK_SKIP_NAME_CHECK') || '').toLowerCase() === 'true';
    if (omitirNombre) {
      this.logger.warn('VERIFIK_SKIP_NAME_CHECK=true: no se está comparando el nombre. Solo para pruebas.');
    } else if (!this.nombreCoincide(nombreCompletoIngresado, nombreOficial)) {
      return {
        matched: false,
        code: 'nombre_no_coincide',
        provider: 'verifik',
        nombreCompleto: nombreOficial,
        message: 'El nombre ingresado no coincide con el registrado para ese documento.',
      };
    }

    return { matched: true, provider: 'verifik', nombreCompleto: nombreOficial };
  }

  // ----------------------------------------------- Antecedentes (Policía)

  async verifyAntecedentes(numeroDocumento: string, tipoDocumento: string): Promise<AntecedentesResult> {
    const mode = (
      this.config.get<string>('VERIFIK_ANTECEDENTES_MODE') ||
      this.config.get<string>('VERIFIK_MODE') ||
      'demo'
    ).toLowerCase();

    if (mode !== 'live') {
      return {
        cleared: true,
        provider: 'verifik-antecedentes-demo',
        nivelRiesgo: 'bajo',
        alertas: [],
        message: 'Modo demo: los antecedentes judiciales no se consultaron realmente.',
      };
    }

    if (!TIPOS_POLICIA.includes(tipoDocumento)) {
      return {
        cleared: false,
        code: 'antecedentes_tipo_no_soportado',
        provider: 'verifik-antecedentes',
        nivelRiesgo: 'no-evaluado',
        alertas: [],
        message: `La consulta de antecedentes solo admite: ${TIPOS_POLICIA.join(', ')}.`,
      };
    }

    const apiUrl =
      this.config.get<string>('VERIFIK_ANTECEDENTES_URL') || 'https://api.verifik.co/v2/co/policia/consultar';
    const { ok, payload } = await this.consultar(apiUrl, {
      documentType: tipoDocumento,
      documentNumber: numeroDocumento,
    });

    const normalizar = (texto: string) =>
      texto
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .trim();

    // El resultado puede venir en `details` (nivel raíz) o dentro de `data`, según la versión de la API.
    const textos = [payload?.details, payload?.data?.details, payload?.data?.legend]
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map(normalizar);

    if (!ok || textos.length === 0) {
      // No se puede afirmar que esté limpio: no se aprueba, y se deja rastro (solo nombres de campos) para depurar.
      this.logger.warn(
        `Respuesta de antecedentes no interpretable (HTTP ${ok ? 'ok' : 'error'}). ` +
          `Campos raíz: ${Object.keys(payload ?? {}).join(', ')}. ` +
          `Campos en data: ${Object.keys(payload?.data ?? {}).join(', ') || '(ninguno)'}`,
      );
      return {
        cleared: false,
        code: 'antecedentes_no_confirmados',
        provider: 'verifik-antecedentes',
        nivelRiesgo: 'desconocido',
        alertas: [],
        message: 'No se pudo confirmar el estado de antecedentes.',
      };
    }

    // Debe EMPEZAR con la leyenda: el texto legal que la acompaña también la menciona,
    // así que buscarla en cualquier parte podría aprobar por error a alguien con antecedentes.
    if (textos.some((t) => t.startsWith(LEYENDA_LIMPIO))) {
      return { cleared: true, provider: 'verifik-antecedentes', nivelRiesgo: 'bajo', alertas: [] };
    }

    // No se guarda el texto de la Policía (dato sensible); solo una alerta genérica.
    return {
      cleared: false,
      code: 'antecedentes_pendientes',
      provider: 'verifik-antecedentes',
      nivelRiesgo: 'alto',
      alertas: ['Registra asuntos pendientes con las autoridades judiciales'],
    };
  }

  // -------------------------------------------------------------- Helpers

  /** GET autenticado a Verifik. Errores del proveedor => 503 (no se culpa a la persona). */
  private async consultar(url: string, params: Record<string, string>): Promise<{ ok: boolean; payload: any }> {
    const apiKey = this.config.get<string>('VERIFIK_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException('Verifik está en modo live pero falta VERIFIK_API_KEY.');
    }
    const scheme = this.config.get<string>('VERIFIK_AUTH_SCHEME') || 'jwt';

    const target = new URL(url);
    for (const [clave, valor] of Object.entries(params)) target.searchParams.set(clave, valor);

    let response: Response;
    try {
      response = await fetch(target, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `${scheme} ${apiKey}` },
        signal: AbortSignal.timeout(VERIFIK_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(`Verifik no respondió (${target.pathname}): ${(error as Error).message}`);
      throw new ServiceUnavailableException('No se pudo contactar a Verifik. Intenta de nuevo.');
    }

    const payload: any = await response.json().catch(() => ({}));

    if ([401, 402, 403, 429].includes(response.status) || response.status >= 500) {
      this.logger.error(
        `Verifik respondió ${response.status} en ${target.pathname}: ${payload?.message ?? 'sin mensaje'}`,
      );
      throw new ServiceUnavailableException('El servicio de verificación no está disponible en este momento.');
    }

    return { ok: response.ok, payload };
  }

  /** Quita tildes, pasa a mayúsculas y separa en palabras. */
  private tokens(texto: string): string[] {
    return texto
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  /**
   * Toda palabra escrita por la persona debe aparecer en el nombre oficial
   * (sin importar el orden). Así se tolera que omita un segundo nombre.
   */
  private nombreCoincide(ingresado: string, oficial: string): boolean {
    const palabrasOficiales = new Set(this.tokens(oficial));
    const palabrasIngresadas = this.tokens(ingresado);
    return palabrasIngresadas.length > 0 && palabrasIngresadas.every((p) => palabrasOficiales.has(p));
  }
}
