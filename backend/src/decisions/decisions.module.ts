import { Module } from '@nestjs/common';
import { DecisionsController } from './decisions.controller';
import { DecisionsService } from './decisions.service';
import { ExecutionAdapter } from './execution-adapter.service';

@Module({
  controllers: [DecisionsController],
  providers: [DecisionsService, ExecutionAdapter],
})
export class DecisionsModule {}
