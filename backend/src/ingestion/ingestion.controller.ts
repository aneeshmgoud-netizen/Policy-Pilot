import {
  Body,
  Controller,
  Headers,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CreateAccessRequestDto } from './dto/create-access-request.dto';
import { ApiKeyGuard } from './guards/api-key.guard';
import { IngestionService } from './ingestion.service';

@Controller('access-requests')
@UseGuards(ApiKeyGuard)
export class IngestionController {
  constructor(private readonly ingestionService: IngestionService) {}

  @Post()
  async create(
    @Body() dto: CreateAccessRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.ingestionService.ingest(dto, idempotencyKey);
    res.status(result.duplicate ? HttpStatus.OK : HttpStatus.ACCEPTED);
    return result;
  }
}
