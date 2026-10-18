import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffPrincipal } from '../common/staff/staff-auth.guard';
import { staffDocHash } from '../common/staff/staff-doc-hash';
import { EventPublisherService } from '../events/event-publisher.service';
import { KycRecord } from './entities/kyc-record.entity';
import { isApprovable, isInvalidIssueDate, isUnderage, REJECTION_RULES, rejectionLabel } from './rejection-rules';

/**
 * Revisión manual de verificaciones rechazadas (Cumplimiento y Administración).
 * Aprobar publica identity.verified, igual que una verificación automática, y
 * account-service activa la cuenta. Todo queda en admin_audit con el rol.
 */
@Injectable()
export class KycReviewService {
  constructor(
    @InjectRepository(KycRecord) private readonly records: Repository<KycRecord>,
    private readonly audit: AdminAuditService,
    private readonly events: EventPublisherService,
    private readonly config: ConfigService,
  ) {}

  async approve(idUser: string, reason: string, staff: StaffPrincipal): Promise<KycRecord> {
    const record = await this.records.findOne({ where: { idUser } });
    if (!record) throw new NotFoundException('El cliente no tiene verificación de identidad.');
    if (record.status !== 'rejected') {
      throw new ConflictException('Solo se pueden aprobar verificaciones rechazadas.');
    }

    // Un empleado no aprueba su propia verificación: se compara la huella de su documento.
    if (!staff.docHash) {
      throw new ForbiddenException(
        'Para aprobar verificaciones tu usuario debe tener el documento registrado. Pídeselo a un administrador.',
      );
    }
    const secret = this.config.get<string>('STAFF_JWT_SECRET') as string;
    if (staffDocHash(secret, record.numeroDocumento) === staff.docHash) {
      throw new ForbiddenException('No puedes aprobar tu propia verificación de identidad.');
    }

    // Reglas duras: se comprueban otra vez con los datos guardados.
    if (isUnderage(record.fechaNacimiento)) {
      throw new UnprocessableEntityException(
        `Este rechazo no se puede aprobar a mano: ${REJECTION_RULES.menor_de_edad.label}.`,
      );
    }
    if (isInvalidIssueDate(record.fechaNacimiento, record.fechaExpedicion)) {
      throw new UnprocessableEntityException(
        `Este rechazo no se puede aprobar a mano: ${REJECTION_RULES.fecha_expedicion_invalida.label}.`,
      );
    }
    if (!isApprovable(record.rejectionCode)) {
      throw new UnprocessableEntityException(
        `Este rechazo no se puede aprobar a mano: ${rejectionLabel(record.rejectionCode) ?? 'motivo no registrado'}.`,
      );
    }

    const saved = await this.records.manager.transaction(async (manager) => {
      Object.assign(record, {
        status: 'verified',
        reviewedBy: staff.username,
        reviewedByRole: staff.role,
        reviewReason: reason.trim().slice(0, 300),
        reviewedAt: new Date(),
      });
      const updated = await manager.save(record);
      await this.audit.record(
        staff,
        {
          action: 'kyc.manual_approve',
          targetType: 'kyc_record',
          targetId: idUser,
          reason,
          details: { rejectionCode: record.rejectionCode },
        },
        manager,
      );
      // Solo el idUser, como en la verificación automática (outbox en la misma transacción).
      await this.events.publish('identity.verified', { idUser }, manager);
      return updated;
    });
    void this.events.flush();
    return saved;
  }
}
