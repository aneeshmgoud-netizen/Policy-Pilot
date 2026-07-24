import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EmbeddingsService } from './embeddings.service';
import { RagService } from './rag.service';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: EmbeddingsService,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        new EmbeddingsService({
          apiKey: configService.get<string>('OPENAI_API_KEY'),
          model: configService.get<string>('OPENAI_EMBEDDING_MODEL'),
        }),
    },
    RagService,
  ],
  exports: [RagService, EmbeddingsService],
})
export class RagModule {}
