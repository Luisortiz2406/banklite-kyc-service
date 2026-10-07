import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KycModule } from './kyc/kyc.module';
import { KycRecord } from './kyc/entities/kyc-record.entity';
import { EventOutbox } from './events/event-outbox.entity';
import { HealthController } from './health.controller';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv(
        [
        { key: 'JWT_SECRET', type: 'secret' },
        { key: 'STAFF_JWT_SECRET', type: 'secret' },
        { key: 'KYC_ENCRYPTION_KEY', type: 'hex64' },
        { key: 'INTERNAL_TRUSTED_KEYS', type: 'trusted-keys' },
        { key: 'DATABASE_URL', type: 'url' },
        { key: 'RABBITMQ_URL', type: 'url', optional: true },
      ],
        ['JWT_SECRET', 'STAFF_JWT_SECRET', 'KYC_ENCRYPTION_KEY'],
      ),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
        entities: [KycRecord, EventOutbox],
        synchronize: true, // demo académica; en producción usar migraciones
        logging: false,
      }),
    }),
    KycModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
