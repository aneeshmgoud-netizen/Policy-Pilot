import { Logger } from '@nestjs/common';
import {
  AgentService,
  ChatClient,
  ChatCompletionResponse,
  RecommendationValidationError,
} from './agent.service';
import { RecommendationInput } from './agent.types';

const VALID_RECOMMENDATION = {
  decision: 'APPROVE',
  justification: 'Permitted for CC-FIN-07 members per §3.1 standard read access.',
  policy_citations: [
    {
      document_name: 'POL-DATA-001',
      section: '3.1',
      excerpt: 'members of `CC-FIN-07` or `CC-FIN-12` may request baseline read access',
    },
  ],
  confidence: 0.82,
};

const INPUT: RecommendationInput = {
  accessRequest: {
    requestId: 'req-1',
    employeeId: 'EMP-52190',
    requestType: 'GRANT_ENTITLEMENT',
    targetSystem: 'DATA_WAREHOUSE',
    entitlementKey: 'FIN_DATASET_READ',
    justification: 'Need read access for quarterly reporting.',
    requesterDepartment: 'Finance',
    requesterCostCenter: 'CC-FIN-07',
  },
  entitlementSnapshot: {
    currentActiveEntitlements: [],
    alreadyHasRequestedEntitlement: false,
    sodConflicts: [],
  },
  retrievedChunks: [
    {
      documentName: 'POL-DATA-001',
      section: '3.1 Standard Read Access Protocol',
      content: 'members of `CC-FIN-07` or `CC-FIN-12` may request baseline read access ...',
    },
  ],
};

function response(
  content: unknown,
  usage: ChatCompletionResponse['usage'] = {
    prompt_tokens: 1200,
    completion_tokens: 150,
    total_tokens: 1350,
  },
): ChatCompletionResponse {
  return {
    choices: [
      {
        message: {
          content: typeof content === 'string' ? content : JSON.stringify(content),
        },
      },
    ],
    usage,
  };
}

function makeClient(responses: ChatCompletionResponse[]) {
  const create = jest.fn();
  for (const r of responses) {
    create.mockResolvedValueOnce(r);
  }
  const client: ChatClient = { chat: { completions: { create } } };
  return { client, create };
}

describe('AgentService', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('extracts a structured recommendation on the first attempt and requests JSON output', async () => {
    const { client, create } = makeClient([response(VALID_RECOMMENDATION)]);
    const service = new AgentService({ model: 'gpt-4o-mini' }, client);

    const result = await service.recommend(INPUT);

    expect(result.recommendation.decision).toBe('APPROVE');
    expect(result.recommendation.confidence).toBe(0.82);
    expect(result.recommendation.policy_citations).toHaveLength(1);
    expect(result.attemptNumber).toBe(1);
    expect(result.modelName).toBe('gpt-4o-mini');
    expect(result.promptVersion).toBe('v3');
    expect(create).toHaveBeenCalledTimes(1);
    // JSON mode is requested.
    expect(create.mock.calls[0][0].response_format).toEqual({ type: 'json_object' });
    // The system + user messages are passed.
    expect(create.mock.calls[0][0].messages).toHaveLength(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('computes token usage and estimated cost from the API usage block', async () => {
    const { client } = makeClient([response(VALID_RECOMMENDATION)]);
    const service = new AgentService({ model: 'gpt-4o-mini' }, client);

    const { usage } = await service.recommend(INPUT);

    expect(usage.promptTokens).toBe(1200);
    expect(usage.completionTokens).toBe(150);
    expect(usage.totalTokens).toBe(1350);
    // gpt-4o-mini: $0.15/1M in, $0.60/1M out.
    expect(usage.estimatedCostUsd).toBeCloseTo(
      (1200 / 1_000_000) * 0.15 + (150 / 1_000_000) * 0.6,
      12,
    );
  });

  it('measures and logs LLM latency, cost, and token usage on success', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { client } = makeClient([response(VALID_RECOMMENDATION)]);
    const service = new AgentService({ model: 'gpt-4o-mini' }, client);

    const { usage } = await service.recommend(INPUT);

    expect(usage.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof usage.latencyMs).toBe('number');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[LLM Execution] Latency:'),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Tokens: 1350'));
    logSpy.mockRestore();
  });

  it('retries on malformed JSON and succeeds, logging a warning', async () => {
    const { client, create } = makeClient([
      response('this is not json {{{'),
      response(VALID_RECOMMENDATION),
    ]);
    const service = new AgentService({ model: 'gpt-4o-mini' }, client);

    const result = await service.recommend(INPUT);

    expect(result.attemptNumber).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('retries when JSON is well-formed but fails schema validation', async () => {
    const invalid = {
      decision: 'MAYBE', // not in the enum
      justification: '',
      policy_citations: [],
      confidence: 5, // out of [0,1]
    };
    const { client, create } = makeClient([
      response(invalid),
      response(VALID_RECOMMENDATION),
    ]);
    const service = new AgentService({ model: 'gpt-4o-mini' }, client);

    const result = await service.recommend(INPUT);

    expect(result.attemptNumber).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('throws RecommendationValidationError after exhausting 3 attempts', async () => {
    const { client, create } = makeClient([
      response('bad-1'),
      response('bad-2'),
      response('bad-3'),
    ]);
    const service = new AgentService({ model: 'gpt-4o-mini' }, client);

    await expect(service.recommend(INPUT)).rejects.toBeInstanceOf(
      RecommendationValidationError,
    );
    expect(create).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it('passes through an ESCALATE decision for an ambiguous case', async () => {
    const escalate = {
      decision: 'ESCALATE',
      justification:
        'Contractor sponsorship under POL-GOV-000 Appendix D cannot be confirmed from the excerpts.',
      policy_citations: [],
      confidence: 0.4,
    };
    const { client } = makeClient([response(escalate)]);
    const service = new AgentService({ model: 'gpt-4o-mini' }, client);

    const result = await service.recommend(INPUT);

    expect(result.recommendation.decision).toBe('ESCALATE');
    expect(result.recommendation.policy_citations).toEqual([]);
  });
});
