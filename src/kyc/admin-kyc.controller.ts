import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Brackets, Repository } from 'typeorm';
import { blindIndex } from '../common/crypto/field-crypto';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffAuthGuard, StaffRoles } from '../common/staff/staff-auth.guard';
import { EventPublisherService } from '../events/event-publisher.service';
import { KycRecord } from './entities/kyc-record.entity';
import { KycReviewService } from './kyc-review.service';
import { isApprovable, rejectionLabel } from './rejection-rules';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AdminKycQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(['verified', 'rejected']) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class ApproveKycDto {
  @IsString()
  @MinLength(10, { message: 'Explica el motivo de la aprobación (mínimo 10 caracteres).' })
  @MaxLength(300)
  reason: string;
}

class AuditQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

/** Lo que cualquier empleado puede ver: nombre y estado, sin datos personales. */
function summary(r: KycRecord) {
  return {
    idUser: r.idUser,
    nombres: r.nombres,
    apellidos: r.apellidos,
    tipoDocumento: r.tipoDocumento,
    status: r.status,
    rejectionCode: r.rejectionCode,
    rejectionLabel: rejectionLabel(r.rejectionCode),
    approvable: r.status === 'rejected' && isApprovable(r.rejectionCode),
    reviewedBy: r.reviewedBy,
    reviewedByRole: r.reviewedByRole,
    reviewedAt: r.reviewedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Panel administrativo de KYC Service.
 * - Cualquier empleado: lista y resumen (nombre y estado) y estado de los eventos.
 * - Cumplimiento y Administración: ficha completa con datos personales (cada
 *   apertura queda en la auditoría) y aprobación manual de rechazos.
 * Va registrado antes que KycController para que /kyc/:id_user no capture /kyc/admin.
 */
@Controller('kyc/admin')
@UseGuards(StaffAuthGuard)
export class AdminKycController {
  constructor(
    @InjectRepository(KycRecord) private readonly records: Repository<KycRecord>,
    private readonly events: EventPublisherService,
    private readonly audit: AdminAuditService,
    private readonly review: KycReviewService,
  ) {}

  @Get('records')
  async list(@Query() query: AdminKycQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const qb = this.records.createQueryBuilder('k').orderBy('k.createdAt', 'DESC');
    const term = query.q?.trim();
    if (term) {
      qb.andWhere(
        new Brackets((w) => {
          // Documento y teléfono están cifrados: solo coincidencia exacta por índice ciego.
          w.where(`(k.nombres || ' ' || k.apellidos) ILIKE :like`, { like: `%${term}%` })
            .orWhere('k.email ILIKE :like', { like: `%${term}%` })
            .orWhere('k.numeroDocumentoHash = :hash', { hash: blindIndex(term) })
            .orWhere('k.telefonoHash IN (:...phones)', {
              phones: [blindIndex(term), blindIndex(`+57${term.replace(/\D/g, '')}`)],
            });
          if (UUID.test(term)) w.orWhere('k.idUser = :id', { id: term });
        }),
      );
    }
    if (query.status) qb.andWhere('k.status = :status', { status: query.status });
    const [items, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { items: items.map(summary), total, page, limit };
  }

  @Get('records/:idUser/resumen')
  async resumen(@Param('idUser') idUser: string) {
    return summary(await this.find(idUser));
  }

  @Get('records/:idUser')
  @StaffRoles('compliance', 'admin')
  async detail(@Param('idUser') idUser: string, @Req() req: any) {
    const record = await this.find(idUser);
    await this.audit.record(req.staff, { action: 'kyc.view', targetType: 'kyc_record', targetId: idUser });
    return { ...record, rejectionLabel: rejectionLabel(record.rejectionCode), approvable: summary(record).approvable };
  }

  @Post('records/:idUser/approve')
  @StaffRoles('compliance', 'admin')
  @HttpCode(200)
  async approve(@Param('idUser') idUser: string, @Body() dto: ApproveKycDto, @Req() req: any) {
    if (!UUID.test(idUser)) throw new NotFoundException('El cliente no tiene verificación de identidad.');
    return summary(await this.review.approve(idUser, dto.reason, req.staff));
  }

  @Get('outbox')
  outbox() {
    return this.events.stats();
  }

  @Get('audit')
  auditLog(@Query() q: AuditQueryDto) {
    return this.audit.list(q.page ?? 1, q.limit ?? 50, q.q);
  }

  private async find(idUser: string) {
    const record = UUID.test(idUser) ? await this.records.findOne({ where: { idUser } }) : null;
    if (!record) throw new NotFoundException('El cliente no tiene verificación de identidad.');
    return record;
  }
}
