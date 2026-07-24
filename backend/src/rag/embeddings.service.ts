import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';

export interface EmbeddingsConfig {
  apiKey?: string;
  model?: string;
}

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

// Thin wrapper over the OpenAI embeddings API. Framework-agnostic on purpose:
// the RagModule provides it from ConfigService, and the ingest CLI constructs
// it directly from process.env — same class, no Nest dependency.
//
// The OpenAI client is created lazily on first use, not in the constructor, so
// the application (and RagModule) can boot without OPENAI_API_KEY set; only an
// actual embed call requires the key. text-embedding-3-small returns 1536-dim
// vectors, matching the vector(1536) column — do not swap models without a
// schema migration and re-embed.
@Injectable()
export class EmbeddingsService {
  private client?: OpenAI;
  private readonly apiKey?: string;
  readonly model: string;

  constructor(config: EmbeddingsConfig = {}) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_EMBEDDING_MODEL;
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const response = await this.getClient().embeddings.create({
      model: this.model,
      input: texts,
    });
    // Preserve request order (the API guarantees data is index-aligned, but be
    // explicit rather than assume).
    return response.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
  }

  private getClient(): OpenAI {
    if (!this.apiKey) {
      throw new Error(
        'OPENAI_API_KEY is not configured — set it in backend/.env before embedding.',
      );
    }
    if (!this.client) {
      this.client = new OpenAI({ apiKey: this.apiKey });
    }
    return this.client;
  }
}
