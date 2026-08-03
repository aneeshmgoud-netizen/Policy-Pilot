import {
  ConflictException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { GovernancePrecedentsController } from './governance-precedents.controller';
import { PrecedentGovernanceService } from './precedent-governance.service';

describe('GovernancePrecedentsController (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const list = jest.fn();
  const approve = jest.fn();
  const revoke = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GovernancePrecedentsController],
      providers: [
        {
          provide: PrecedentGovernanceService,
          useValue: { list, approve, revoke },
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
    list.mockReset();
    approve.mockReset();
    revoke.mockReset();
  });

  const GOVERNANCE_AUTH = {
    authorization: 'Bearer mock-token-governance',
  };

  function post(
    path: string,
    body: unknown = {},
    headers: Record<string, string> = GOVERNANCE_AUTH,
  ) {
    return fetch(`${baseUrl}/api/v1/governance/precedents/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('rejects a request with no Authorization header (401)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/governance/precedents`);
    expect(res.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects an invalid bearer token (401)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/governance/precedents`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects a VIEWER token (403)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/governance/precedents`, {
      headers: { authorization: 'Bearer mock-token-viewer' },
    });
    expect(res.status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects a REVIEWER token at the governance boundary (403)', async () => {
    const res = await post(
      'precedent-1/approve',
      {},
      { authorization: 'Bearer mock-token-alice' },
    );
    expect(res.status).toBe(403);
    expect(approve).not.toHaveBeenCalled();
  });

  it('forwards an optional list status for an authenticated approver', async () => {
    list.mockResolvedValue([{ id: 'precedent-1', status: 'PROPOSED' }]);
    const res = await fetch(
      `${baseUrl}/api/v1/governance/precedents?status=PROPOSED`,
      { headers: GOVERNANCE_AUTH },
    );

    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith('PROPOSED');
    await expect(res.json()).resolves.toEqual([
      { id: 'precedent-1', status: 'PROPOSED' },
    ]);
  });

  it('rejects revoke without revokedReason before the service runs', async () => {
    const res = await post('precedent-1/revoke');
    expect(res.status).toBe(400);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('forwards a valid approval and returns its result', async () => {
    const approved = { id: 'precedent-1', status: 'ACTIVE' };
    approve.mockResolvedValue(approved);

    const res = await post('precedent-1/approve');

    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledWith(
      'precedent-1',
      'governance:priya',
    );
    await expect(res.json()).resolves.toEqual(approved);
  });

  it('forwards a valid revocation and returns its result', async () => {
    const revoked = { id: 'precedent-1', status: 'REVOKED' };
    revoke.mockResolvedValue(revoked);

    const res = await post('precedent-1/revoke', {
      revokedReason: 'The governing policy changed.',
    });

    expect(res.status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(
      'precedent-1',
      { revokedReason: 'The governing policy changed.' },
      'governance:priya',
    );
    await expect(res.json()).resolves.toEqual(revoked);
  });

  it('derives governanceActorId only from the authenticated bearer token', async () => {
    approve.mockResolvedValue({ id: 'precedent-1', status: 'ACTIVE' });

    await post(
      'precedent-1/approve',
      {},
      {
        authorization: 'Bearer mock-token-governance',
        'x-governance-actor-id': 'attacker:impersonation',
      },
    );

    expect(approve.mock.calls[0][1]).toBe('governance:priya');
  });

  it.each([
    ['approve', approve, {}, new ConflictException('already approved'), 409],
    [
      'revoke',
      revoke,
      { revokedReason: 'Duplicate revoke' },
      new ConflictException('already revoked'),
      409,
    ],
    ['approve', approve, {}, new NotFoundException('missing'), 404],
    [
      'revoke',
      revoke,
      { revokedReason: 'Missing record' },
      new NotFoundException('missing'),
      404,
    ],
  ])(
    'maps a service failure from %s to HTTP %s',
    async (action, serviceMethod, body, failure, expectedStatus) => {
      serviceMethod.mockRejectedValue(failure);

      const response = await post(`precedent-1/${action}`, body);

      expect(response.status).toBe(expectedStatus);
    },
  );
});
