import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { GovernanceAuthGuard } from '../common/guards/governance-auth.guard';
import { MockDashboardUser } from '../common/mock-users.constant';
import { RevokePrecedentDto } from './dto/revoke-precedent.dto';
import { PrecedentGovernanceService } from './precedent-governance.service';

@Controller('governance/precedents')
// Mock REVIEWER and GOVERNANCE_APPROVER credentials are disjoint; production must also compare the specific identities.
@UseGuards(GovernanceAuthGuard)
export class GovernancePrecedentsController {
  constructor(
    private readonly governanceService: PrecedentGovernanceService,
  ) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.governanceService.list(status);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('id') id: string,
    @CurrentUser() user: MockDashboardUser,
  ) {
    return this.governanceService.approve(id, user.id);
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(
    @Param('id') id: string,
    @Body() dto: RevokePrecedentDto,
    @CurrentUser() user: MockDashboardUser,
  ) {
    return this.governanceService.revoke(id, dto, user.id);
  }
}
