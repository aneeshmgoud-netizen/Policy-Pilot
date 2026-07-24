import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DashboardAuthGuard } from '../common/guards/dashboard-auth.guard';
import { MockDashboardUser } from '../common/mock-users.constant';
import { DecisionsService } from './decisions.service';
import { CreateDecisionDto } from './dto/create-decision.dto';

// Dashboard-facing endpoints for the human reviewer. Unlike the ingestion
// webhook (machine-to-machine, ApiKeyGuard), these are the human HITL
// surface, guarded by DashboardAuthGuard (mock bearer-token auth + REVIEWER
// role check). The reviewer identity for a decision comes ONLY from that
// guard's resolved @CurrentUser() — never from anything the client supplies
// directly (a header, a body field) — so a client cannot attribute a
// decision to a reviewer identity it doesn't actually hold a token for.
@Controller('access-requests')
@UseGuards(DashboardAuthGuard)
export class DecisionsController {
  constructor(private readonly decisionsService: DecisionsService) {}

  @Get()
  list() {
    return this.decisionsService.listAccessRequests();
  }

  @Post(':id/decisions')
  @HttpCode(HttpStatus.CREATED)
  createDecision(
    @Param('id') id: string,
    @Body() dto: CreateDecisionDto,
    @CurrentUser() user: MockDashboardUser,
  ) {
    return this.decisionsService.recordDecision(id, dto, user.id);
  }
}
