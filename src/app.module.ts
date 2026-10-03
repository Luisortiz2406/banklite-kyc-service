import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KycModule } from './kyc/kyc.module';
import { KycRecord } from './kyc/entities/kyc-record.entity';
import { EventOutbox } from './events/event-outbox.entity';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
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
