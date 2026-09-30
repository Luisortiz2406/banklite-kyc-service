import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventPublisherService } from '../events/event-publisher.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { KycRecord } from './entities/kyc-record.entity';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';
import { VerifikService } from './verifik.service';

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}), // solo se usa para verificar tokens emitidos por Auth Service
    TypeOrmModule.forFeature([KycRecord]),
  ],
  controllers: [KycController],
  providers: [KycService, EventPublisherService, JwtAuthGuard, InternalKeyGuard, VerifikService],
})
export class KycModule {}