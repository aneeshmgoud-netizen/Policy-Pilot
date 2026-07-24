import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { DecisionsController } from './decisions.controller';
import { DecisionsService } from './decisions.service';

// Integration test: drives DecisionsController over real HTTP through the global
// ValidationPipe + exception filter, with a mocked service. This is what
// exercises the override-rationale rule end to end (pipe -> 400), plus the
// happy paths and routing. No DB needed.

describe('DecisionsController (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const listAccessRequests = jest.fn();
  const recordDecision = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DecisionsController],
      providers: [
        {
          provide: DecisionsService,
          useValue: { listAccessRequests, recordDecision },
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
    listAccessRequests.mockReset();
    recordDecision.mockReset();
  });

  const REVIEWER_AUTH = { authorization: 'Bearer mock-token-alice' };

  function postDecision(id: string, body: unknown, headers: Record<string, string> = REVIEWER_AUTH) {
    return fetch(`${baseUrl}/api/v1/access-requests/${id}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('rejects a request with no Authorization header (401)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/access-requests`);
    expect(res.status).toBe(401);
    expect(listAccessRequests).not.toHaveBeenCalled();
  });

  it('rejects an invalid bearer token (401)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/access-requests`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.status).toBe(401);
    expect(listAccessRequests).not.toHaveBeenCalled();
  });

  it('rejects a valid token belonging to a non-REVIEWER role (403)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/access-requests`, {
      headers: { authorization: 'Bearer mock-token-viewer' },
    });
    expect(res.status).toBe(403);
    expect(listAccessRequests).not.toHaveBeenCalled();
  });

  it('GET /access-requests returns the list from the service for an authenticated reviewer', async () => {
    listAccessRequests.mockResolvedValue([{ id: 'ar-1', status: 'RECOMMENDED' }]);
    const res = await fetch(`${baseUrl}/api/v1/access-requests`, {
      headers: REVIEWER_AUTH,
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([
      { id: 'ar-1', status: 'RECOMMENDED' },
    ]);
  });

  it('rejects an OVERRIDE with no rationale (400) before the service runs', async () => {
    const res = await postDecision('ar-1', { decisionType: 'OVERRIDE' });
    expect(res.status).toBe(400);
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('rejects an OVERRIDE with a blank rationale (400)', async () => {
    const res = await postDecision('ar-1', {
      decisionType: 'OVERRIDE',
      rationale: '   ',
    });
    expect(res.status).toBe(400);
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('accepts an OVERRIDE with a rationale (201) and forwards it', async () => {
    recordDecision.mockResolvedValue({
      id: 'hd-1',
      accessRequestId: 'ar-1',
      decisionType: 'OVERRIDE',
      status: 'DECIDED',
    });
    const res = await postDecision('ar-1', {
      decisionType: 'OVERRIDE',
      rationale: 'Business-critical exception approved by CISO.',
    });
    expect(res.status).toBe(201);
    expect(recordDecision).toHaveBeenCalledTimes(1);
    expect(recordDecision.mock.calls[0][1]).toMatchObject({
      decisionType: 'OVERRIDE',
      rationale: 'Business-critical exception approved by CISO.',
    });
  });

  it('accepts an APPROVE with no rationale (201)', async () => {
    recordDecision.mockResolvedValue({
      id: 'hd-2',
      accessRequestId: 'ar-1',
      decisionType: 'APPROVE',
      status: 'DECIDED',
    });
    const res = await postDecision('ar-1', { decisionType: 'APPROVE' });
    expect(res.status).toBe(201);
    expect(recordDecision).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown decisionType (400)', async () => {
    const res = await postDecision('ar-1', { decisionType: 'MAYBE' });
    expect(res.status).toBe(400);
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('derives reviewerId from the authenticated bearer token, not any client-supplied value', async () => {
    recordDecision.mockResolvedValue({
      id: 'hd-3',
      accessRequestId: 'ar-1',
      decisionType: 'DENY',
      status: 'DECIDED',
    });
    // A client-supplied x-reviewer-id header attempting to impersonate a
    // different reviewer must be ignored entirely — reviewerId can only ever
    // be resolved from the token, which is mock-token-bob here.
    await fetch(`${baseUrl}/api/v1/access-requests/ar-1/decisions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer mock-token-bob',
        'x-reviewer-id': 'attacker-impersonating-someone-else',
      },
      body: JSON.stringify({ decisionType: 'DENY' }),
    });
    expect(recordDecision.mock.calls[0][2]).toBe('reviewer:bob');
  });

  it('rejects a decision submission with no Authorization header (401)', async () => {
    const res = await postDecision('ar-1', { decisionType: 'DENY' }, {});
    expect(res.status).toBe(401);
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('rejects a decision submission from a non-REVIEWER token (403)', async () => {
    const res = await postDecision(
      'ar-1',
      { decisionType: 'DENY' },
      { authorization: 'Bearer mock-token-viewer' },
    );
    expect(res.status).toBe(403);
    expect(recordDecision).not.toHaveBeenCalled();
  });
});
