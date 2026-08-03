import {
  ConflictException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { GovernanceRuleSuggestionsController } from './governance-rule-suggestions.controller';
import { PatternDiscoveryService } from './pattern-discovery.service';
import { RuleSuggestionGovernanceService } from './rule-suggestion-governance.service';

describe('GovernanceRuleSuggestionsController (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const discover = jest.fn();
  const list = jest.fn();
  const accept = jest.fn();
  const dismiss = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GovernanceRuleSuggestionsController],
      providers: [
        { provide: PatternDiscoveryService, useValue: { discoverPatterns: discover } },
        {
          provide: RuleSuggestionGovernanceService,
          useValue: { list, accept, dismiss },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    discover.mockReset();
    list.mockReset();
    accept.mockReset();
    dismiss.mockReset();
  });

  const GOVERNANCE_AUTH = {
    authorization: 'Bearer mock-token-governance',
  };

  function post(
    path: string,
    body: unknown = {},
    headers: Record<string, string> = GOVERNANCE_AUTH,
  ) {
    return fetch(`${baseUrl}/api/v1/governance/rule-suggestions/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('rejects missing and invalid bearer credentials', async () => {
    const missing = await fetch(
      `${baseUrl}/api/v1/governance/rule-suggestions`,
    );
    expect(missing.status).toBe(401);

    const invalid = await fetch(
      `${baseUrl}/api/v1/governance/rule-suggestions`,
      { headers: { authorization: 'Bearer invalid-token' } },
    );
    expect(invalid.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    ['VIEWER', 'mock-token-viewer'],
    ['REVIEWER', 'mock-token-alice'],
  ])('rejects a %s token at the governance boundary', async (_role, token) => {
    const response = await post(
      'discover',
      {},
      { authorization: `Bearer ${token}` },
    );
    expect(response.status).toBe(403);
    expect(discover).not.toHaveBeenCalled();
  });

  it('lists suggestions with an optional status filter', async () => {
    list.mockResolvedValue([{ id: 'suggestion-1', status: 'PROPOSED' }]);
    const response = await fetch(
      `${baseUrl}/api/v1/governance/rule-suggestions?status=PROPOSED`,
      { headers: GOVERNANCE_AUTH },
    );

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith('PROPOSED');
    await expect(response.json()).resolves.toEqual([
      { id: 'suggestion-1', status: 'PROPOSED' },
    ]);
  });

  it('runs discovery only for an authenticated governance actor', async () => {
    discover.mockResolvedValue([{ id: 'suggestion-1', status: 'PROPOSED' }]);
    const response = await post('discover');

    expect(response.status).toBe(200);
    expect(discover).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual([
      { id: 'suggestion-1', status: 'PROPOSED' },
    ]);
  });

  it('trims and forwards an optional review note on accept', async () => {
    accept.mockResolvedValue({
      id: 'suggestion-1',
      status: 'ACCEPTED',
      activatedPrecedentIds: [],
    });
    const response = await post('suggestion-1/accept', {
      reviewNote: '  Approved for governance use.  ',
    });

    expect(response.status).toBe(200);
    expect(accept).toHaveBeenCalledWith(
      'suggestion-1',
      'governance:priya',
      'Approved for governance use.',
      // No guidance in this body: acceptance is allowed as a bare
      // acknowledgement, and then creates no operating rule.
      undefined,
    );
  });

  it('forwards trimmed guidance on accept — this is what becomes a retrievable operating rule', async () => {
    accept.mockResolvedValue({
      id: 'suggestion-1',
      status: 'ACCEPTED',
      activatedPrecedentIds: [],
      operatingRuleId: 'rule-1',
    });
    const response = await post('suggestion-1/accept', {
      reviewNote: 'Approved.',
      guidance:
        '  Escalate these requests to Data Governance until the Q3 recertification closes.  ',
    });

    expect(response.status).toBe(200);
    expect(accept).toHaveBeenCalledWith(
      'suggestion-1',
      'governance:priya',
      'Approved.',
      'Escalate these requests to Data Governance until the Q3 recertification closes.',
    );
  });

  it('rejects placeholder guidance (400) rather than storing an unusable rule', async () => {
    const response = await post('suggestion-1/accept', { guidance: 'ok' });

    expect(response.status).toBe(400);
    expect(accept).not.toHaveBeenCalled();
  });

  it('forwards dismiss and derives the actor only from authentication', async () => {
    dismiss.mockResolvedValue({ id: 'suggestion-1', status: 'DISMISSED' });
    const response = await post(
      'suggestion-1/dismiss',
      { reviewNote: 'Not actionable.' },
      {
        authorization: 'Bearer mock-token-governance',
        'x-governance-actor-id': 'attacker:impersonation',
      },
    );

    expect(response.status).toBe(200);
    expect(dismiss).toHaveBeenCalledWith(
      'suggestion-1',
      'governance:priya',
      'Not actionable.',
    );
  });

  it('rejects an overlong review note before invoking governance', async () => {
    const response = await post('suggestion-1/accept', {
      reviewNote: 'x'.repeat(2001),
    });
    expect(response.status).toBe(400);
    expect(accept).not.toHaveBeenCalled();
  });

  it.each([
    ['accept', accept, new ConflictException('already accepted'), 409],
    ['dismiss', dismiss, new ConflictException('already dismissed'), 409],
    ['accept', accept, new NotFoundException('missing'), 404],
    ['dismiss', dismiss, new NotFoundException('missing'), 404],
  ])(
    'maps a service failure from %s to HTTP %s',
    async (action, serviceMethod, failure, expectedStatus) => {
      serviceMethod.mockRejectedValue(failure);

      const response = await post(`suggestion-1/${action}`);

      expect(response.status).toBe(expectedStatus);
    },
  );
});
