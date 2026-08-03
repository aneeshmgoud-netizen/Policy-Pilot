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
import {
  RevokeOperatingRuleDto,
  RuleSuggestionReviewDto,
} from './dto/rule-suggestion-review.dto';
import { PatternDiscoveryService } from './pattern-discovery.service';
import { RuleSuggestionGovernanceService } from './rule-suggestion-governance.service';

@Controller('governance/rule-suggestions')
@UseGuards(GovernanceAuthGuard)
export class GovernanceRuleSuggestionsController {
  constructor(
    private readonly patternDiscovery: PatternDiscoveryService,
    private readonly ruleSuggestionGovernance: RuleSuggestionGovernanceService,
  ) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.ruleSuggestionGovernance.list(status);
  }

  @Post('discover')
  @HttpCode(HttpStatus.OK)
  discover() {
    return this.patternDiscovery.discoverPatterns();
  }

  @Get('operating-rules')
  listOperatingRules() {
    return this.ruleSuggestionGovernance.listOperatingRules();
  }

  @Post('operating-rules/:id/revoke')
  @HttpCode(HttpStatus.OK)
  revokeOperatingRule(
    @Param('id') id: string,
    @Body() dto: RevokeOperatingRuleDto,
    @CurrentUser() user: MockDashboardUser,
  ) {
    return this.ruleSuggestionGovernance.revokeOperatingRule(
      id,
      user.id,
      dto.revokedReason,
    );
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  accept(
    @Param('id') id: string,
    @Body() dto: RuleSuggestionReviewDto,
    @CurrentUser() user: MockDashboardUser,
  ) {
    return this.ruleSuggestionGovernance.accept(
      id,
      user.id,
      dto.reviewNote,
      dto.guidance,
    );
  }

  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  dismiss(
    @Param('id') id: string,
    @Body() dto: RuleSuggestionReviewDto,
    @CurrentUser() user: MockDashboardUser,
  ) {
    return this.ruleSuggestionGovernance.dismiss(
      id,
      user.id,
      dto.reviewNote,
    );
  }
}
