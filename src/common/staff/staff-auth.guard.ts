import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

export type StaffRole = 'support' | 'admin';

export interface StaffPrincipal {
  id: string;
  username: string;
  role: StaffRole;
}

/**
 * Valida el token de EMPLEADO emitido por auth-service (POST /auth/admin/login).
 * Se firma con STAFF_JWT_SECRET, distinto del secreto de los clientes, y lleva
 * type 'staff': un token de cliente nunca pasa este guard ni viceversa.
 * En este servicio todo el panel es de lectura: no se restringe por rol.
 */
@Injectable()
export class StaffAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Token de empleado no proporcionado');

    const secret = this.config.get<string>('STAFF_JWT_SECRET');
    if (!secret) throw new UnauthorizedException('El panel administrativo no está configurado (STAFF_JWT_SECRET).');

    let payload: { sub?: string; type?: string; role?: StaffRole; username?: string };
    try {
      payload = this.jwt.verify(header.slice('Bearer '.length), { secret, algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Sesión de empleado inválida o expirada');
    }
    if (payload.type !== 'staff' || !payload.sub || !payload.role) {
      throw new UnauthorizedException('El token no es de un empleado');
    }

    (request as any).staff = {
      id: payload.sub,
      username: payload.username ?? payload.sub,
      role: payload.role,
    } satisfies StaffPrincipal;
    return true;
  }
}
