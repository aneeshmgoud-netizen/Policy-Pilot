import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module';
import {
  PRECEDENT_INGESTION_DEFAULT_JOB_OPTIONS,
  PRECEDENT_INGESTION_QUEUE,
} from './precedent-ingestion.constants';
import { GovernancePrecedentsController } from './governance-precedents.controller';
import { GovernanceRuleSuggestionsController } from './governance-rule-suggestions.controller';
import { OperatingRuleRetrievalService } from './operating-rule-retrieval.service';
import { PatternDiscoveryService } from './pattern-discovery.service';
import { PrecedentGovernanceService } from './precedent-governance.service';
import { PrecedentIngestionProcessor } from './precedent-ingestion.processor';
import { PrecedentIngestionService } from './precedent-ingestion.service';
import { PrecedentIngestionSweeperService } from './precedent-ingestion-sweeper.service';
import { PrecedentRetrievalService } from './precedent-retrieval.service';
import { RuleSuggestionGovernanceService } from './rule-suggestion-governance.service';

@Module({
  imports: [
    RagModule,
    BullModule.registerQueue({
      name: PRECEDENT_INGESTION_QUEUE,
      defaultJobOptions: PRECEDENT_INGESTION_DEFAULT_JOB_OPTIONS,
    }),
  ],
  controllers: [
    GovernancePrecedentsController,
    GovernanceRuleSuggestionsController,
  ],
  providers: [
    PrecedentGovernanceService,
    PrecedentIngestionService,
    PrecedentIngestionProcessor,
    PrecedentIngestionSweeperService,
    PrecedentRetrievalService,
    OperatingRuleRetrievalService,
    PatternDiscoveryService,
    RuleSuggestionGovernanceService,
  ],
  exports: [BullModule, PrecedentRetrievalService, OperatingRuleRetrievalService],
})
export class PrecedentsModule {}
