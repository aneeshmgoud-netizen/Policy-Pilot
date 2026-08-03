import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { DecisionsController } from './decisions.controller';
import { DecisionsService } from './decisions.service';

// Integration test: drives DecisionsController over real HTTP through the global
// ValidationPipe + exception filter, with a mocked service. This exercises
// routing, auth, and DTO-level validation (outcome must be GRANT/DENY). The
// rationale-required-on-override rule now depends on the AI recommendation,
// which only the (mocked) service knows about, so that rule is covered in
// decisions.service.spec.ts instead of here.

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

  it('rejects an unknown outcome (400) before the service runs', async () => {
    const res = await postDecision('ar-1', { outcome: 'MAYBE' });
    expect(res.status).toBe(400);
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('rejects an unknown precedent reason code (400) before the service runs', async () => {
    const res = await postDecision('ar-1', {
      outcome: 'GRANT',
      reasonCode: 'NOT_A_REAL_CODE',
    });
    expect(res.status).toBe(400);
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('rejects a missing outcome (400)', async () => {
    const res = await postDecision('ar-1', { rationale: 'no outcome given' });
    expect(res.status).toBe(400);
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('accepts a GRANT with rationale (201) and forwards it to the service', async () => {
    recordDecision.mockResolvedValue({
      id: 'hd-1',
      accessRequestId: 'ar-1',
      outcome: 'GRANT',
      overridesRecommendation: true,
      status: 'DECIDED',
      executionStatus: 'PENDING',
    });
    const res = await postDecision('ar-1', {
      outcome: 'GRANT',
      reasonCode: 'BUSINESS_EXCEPTION',
      rationale: 'Business-critical exception approved by CISO.',
    });
    expect(res.status).toBe(201);
    expect(recordDecision).toHaveBeenCalledTimes(1);
    expect(recordDecision.mock.calls[0][1]).toMatchObject({
      outcome: 'GRANT',
      reasonCode: 'BUSINESS_EXCEPTION',
      rationale: 'Business-critical exception approved by CISO.',
    });
  });

  it('rejects a decision with no reason code (400) before the service runs', async () => {
    // Every decision must record why — agreement included. See
    // CreateDecisionDto.reasonCode.
    const res = await postDecision('ar-1', {
      outcome: 'GRANT',
      rationale: 'Looks fine to me.',
    });
    expect(res.status).toBe(400);
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('forwards valid feedback fields to the service unchanged', async () => {
    recordDecision.mockResolvedValue({
      id: 'hd-feedback',
      accessRequestId: 'ar-1',
      outcome: 'GRANT',
      overridesRecommendation: false,
      status: 'DECIDED',
      executionStatus: 'PENDING',
      feedbackCaptured: true,
    });
    const res = await postDecision('ar-1', {
      outcome: 'GRANT',
      reasonCode: 'BUSINESS_EXCEPTION',
      missingContext: 'Approved exception documentation is attached.',
      precedentEligible: true,
    });

    expect(res.status).toBe(201);
    expect(recordDecision).toHaveBeenCalledTimes(1);
    expect(recordDecision.mock.calls[0][1]).toMatchObject({
      outcome: 'GRANT',
      reasonCode: 'BUSINESS_EXCEPTION',
      missingContext: 'Approved exception documentation is attached.',
      precedentEligible: true,
    });
  });

  it('accepts a DENY with no rationale (201) — the DTO does not know whether this is an override', async () => {
    recordDecision.mockResolvedValue({
      id: 'hd-2',
      accessRequestId: 'ar-1',
      outcome: 'DENY',
      overridesRecommendation: false,
      status: 'DECIDED',
      executionStatus: 'PENDING',
    });
    const res = await postDecision('ar-1', { outcome: 'DENY', reasonCode: 'CONFIRMS_POLICY' });
    expect(res.status).toBe(201);
    expect(recordDecision).toHaveBeenCalledTimes(1);
  });

  it('propagates a 409 raised by the service (e.g. request already decided)', async () => {
    const { ConflictException } = await import('@nestjs/common');
    recordDecision.mockRejectedValue(new ConflictException('Access request already decided'));
    const res = await postDecision('ar-1', { outcome: 'DENY', reasonCode: 'CONFIRMS_POLICY' });
    expect(res.status).toBe(409);
  });

  it('derives reviewerId from the authenticated bearer token, not any client-supplied value', async () => {
    recordDecision.mockResolvedValue({
      id: 'hd-3',
      accessRequestId: 'ar-1',
      outcome: 'DENY',
      overridesRecommendation: false,
      status: 'DECIDED',
      executionStatus: 'PENDING',
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
      body: JSON.stringify({ outcome: 'DENY', reasonCode: 'CONFIRMS_POLICY' }),
    });
    expect(recordDecision.mock.calls[0][2]).toBe('reviewer:bob');
  });

  it('rejects a decision submission with no Authorization header (401)', async () => {
    const res = await postDecision('ar-1', { outcome: 'DENY', reasonCode: 'CONFIRMS_POLICY' }, {});
    expect(res.status).toBe(401);
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('rejects a decision submission from a non-REVIEWER token (403)', async () => {
    const res = await postDecision(
      'ar-1',
      { outcome: 'DENY', reasonCode: 'CONFIRMS_POLICY' },
      { authorization: 'Bearer mock-token-viewer' },
    );
    expect(res.status).toBe(403);
    expect(recordDecision).not.toHaveBeenCalled();
  });
});
