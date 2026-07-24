import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AgentService } from './agent.service';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: AgentService,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        new AgentService({
          apiKey: configService.get<string>('OPENAI_API_KEY'),
          model: configService.get<string>('OPENAI_CHAT_MODEL'),
        }),
    },
  ],
  exports: [AgentService],
})
export class AgentModule {}
