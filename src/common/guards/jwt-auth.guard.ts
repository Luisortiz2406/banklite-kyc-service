import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

/**
 * Valida el JWT emitido por el Auth & IAM Service.
 * En producción esta validación normalmente la hace el API Gateway
 * (6.2 del documento); aquí se replica a nivel de servicio para que
 * KYC Service sea funcional de forma independiente, igual que en
 * Account Service.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token no proporcionado');
    }

    const token = authHeader.slice('Bearer '.length);

    try {
      const payload = this.jwt.verify(token, {
        secret: this.config.get('JWT_SECRET'),
        algorithms: ['HS256'],
      });
      if (payload.type !== 'access') {
        throw new UnauthorizedException('Token no es de tipo access');
      }
      (request as any).user = { idUser: payload.sub };
      return true;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}
