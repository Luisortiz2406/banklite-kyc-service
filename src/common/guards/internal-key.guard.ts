import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

/**
 * Protege los endpoints de uso interno entre microservicios (por ejemplo, que
 * Auth Service pregunte si una identidad ya quedó verificada). Exige el header
 * `x-internal-key` con el valor de INTERNAL_API_KEY. Si la variable no está
 * configurada, se rechaza todo (falla cerrado).
 */
@Injectable()
export class InternalKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('INTERNAL_API_KEY');
    const request = context.switchToHttp().getRequest<Request>();
    const received = request.headers['x-internal-key'];

    if (!expected || typeof received !== 'string') {
      throw new UnauthorizedException('Clave interna requerida');
    }
    const a = Buffer.from(expected);
    const b = Buffer.from(received);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Clave interna inválida');
    }
    return true;
  }
}
