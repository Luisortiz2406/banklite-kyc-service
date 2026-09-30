import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { KycService } from './kyc.service';

@Controller('kyc')
export class KycController {
  constructor(private readonly kycService: KycService) {}

  // Público: se llama en el registro, justo después de los datos personales y
  // antes de que exista un access token ni credenciales.
  @Post('submit')
  @HttpCode(HttpStatus.CREATED)
  submit(@Body() dto: SubmitKycDto) {
    return this.kycService.submit(dto);
  }

  @Patch('contact')
  @UseGuards(InternalKeyGuard)
  updateContact(@Body() dto: UpdateContactDto) {
    return this.kycService.updateContact(dto);
  }

  // Uso interno (Auth Service, al crear las credenciales): solo responde si la
  // identidad de ese idUser quedó verificada. Requiere el header x-internal-key.
  @Get('status/:id_user')
  @UseGuards(InternalKeyGuard)
  async status(@Param('id_user', ParseUUIDPipe) idUser: string) {
    return { idUser, ...await this.kycService.getIdentityStatus(idUser) };
  }

  @Get(':id_user')
  @UseGuards(JwtAuthGuard)
  async findOne(
    @Param('id_user', ParseUUIDPipe) idUser: string,
    @Req() request: Request,
  ) {
    const user = (request as any).user as { idUser: string } | undefined;
    if (user && user.idUser !== idUser) {
      throw new ForbiddenException('No puedes consultar la verificación de otro usuario');
    }
    return this.kycService.findByUser(idUser);
  }
}
