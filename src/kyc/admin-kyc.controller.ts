import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Brackets, Repository } from 'typeorm';
import { StaffAuthGuard } from '../common/staff/staff-auth.guard';
import { EventPublisherService } from '../events/event-publisher.service';
import { KycRecord } from './entities/kyc-record.entity';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AdminKycQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(['verified', 'rejected']) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

/**
 * Panel administrativo de KYC Service (solo lectura, cualquier empleado).
 * Va registrado antes que KycController para que /kyc/:id_user no capture /kyc/admin.
 */
@Controller('kyc/admin')
@UseGuards(StaffAuthGuard)
export class AdminKycController {
  constructor(
    @InjectRepository(KycRecord) private readonly records: Repository<KycRecord>,
    private readonly events: EventPublisherService,
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
          w.where(`(k.nombres || ' ' || k.apellidos) ILIKE :like`, { like: `%${term}%` })
            .orWhere('k.numeroDocumento LIKE :doc', { doc: `${term}%` })
            .orWhere('k.email ILIKE :like', { like: `%${term}%` })
            .orWhere('k.telefono LIKE :tel', { tel: `%${term}%` });
          if (UUID.test(term)) w.orWhere('k.idUser = :id', { id: term });
        }),
      );
    }
    if (query.status) qb.andWhere('k.status = :status', { status: query.status });
    const [items, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
    return { items, total, page, limit };
  }

  @Get('records/:idUser')
  async detail(@Param('idUser') idUser: string) {
    const record = UUID.test(idUser) ? await this.records.findOne({ where: { idUser } }) : null;
    if (!record) throw new NotFoundException('El cliente no tiene verificación de identidad.');
    return record;
  }

  @Get('outbox')
  outbox() {
    return this.events.stats();
  }
}
