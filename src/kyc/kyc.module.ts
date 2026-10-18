import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventPublisherService } from '../events/event-publisher.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { AdminAudit } from '../common/staff/admin-audit.entity';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { KycRecord } from './entities/kyc-record.entity';
import { KycReviewService } from './kyc-review.service';
import { KycController } from './kyc.controller';
import { AdminKycController } from './admin-kyc.controller';
import { StaffAuthGuard } from '../common/staff/staff-auth.guard';
import { KycService } from './kyc.service';
import { VerifikService } from './verifik.service';

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}), // solo se usa para verificar tokens emitidos por Auth Service
    TypeOrmModule.forFeature([KycRecord, AdminAudit]),
  ],
  // AdminKycController primero: si no, /kyc/:id_user capturaría /kyc/admin.
  controllers: [AdminKycController, KycController],
  providers: [
    KycService,
    KycReviewService,
    AdminAuditService,
    EventPublisherService,
    JwtAuthGuard,
    InternalKeyGuard,
    VerifikService,
    StaffAuthGuard,
  ],
})
export class KycModule {}
