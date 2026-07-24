import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { ApiKeyGuard } from './guards/api-key.guard';
import { IngestionController } from './ingestion.controller';
import { IngestionService } from './ingestion.service';

// Integration test: boots the real NestJS HTTP pipeline (ApiKeyGuard +
// global ValidationPipe + AllExceptionsFilter) around IngestionController with
// a mocked IngestionService, then drives it over real HTTP. This is what the
// pure-unit specs can't cover — guard registration, pipe wiring, and the
// whitelist/forbidNonWhitelisted behavior. The service is mocked so no
// Postgres/Redis is required.

const API_KEY = 'integration-test-key';

const VALID_BODY = {
  request_id: 'req_access_2026_44821',
  employee_id: 'EMP-52190',
  request_type: 'GRANT_ENTITLEMENT',
  timestamp: '2026-07-01T09:15:00Z',
  requester: {
    title: 'Data Analyst',
    department: 'Finance Analytics',
    cost_center: 'CC-FIN-07',
  },
  target: {
    system_name: 'DATA_WAREHOUSE',
    entitlement_key: 'FIN_DATASET_EDIT',
    justification: 'Need to build quarterly revenue models.',
  },
};

describe('Ingestion HTTP integration', () => {
  let app: INestApplication;
  let baseUrl: string;
  const ingest = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IngestionController],
      providers: [
        ApiKeyGuard,
        { provide: IngestionService, useValue: { ingest } },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'INGESTION_API_KEY' ? API_KEY : undefined,
          },
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
    ingest.mockReset();
  });

  function post(body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/api/v1/access-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('rejects a request with no API key (401) and never calls the service', async () => {
    const res = await post(VALID_BODY);
    expect(res.status).toBe(401);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong API key (401)', async () => {
    const res = await post(VALID_BODY, { 'x-api-key': 'nope' });
    expect(res.status).toBe(401);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('accepts a valid request (202) and forwards it to the service', async () => {
    ingest.mockResolvedValue({
      requestId: VALID_BODY.request_id,
      status: 'PENDING',
      duplicate: false,
    });

    const res = await post(VALID_BODY, {
      'x-api-key': API_KEY,
      'idempotency-key': 'idem-123',
    });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ duplicate: false });
    // The whitelisted, transformed DTO reaches the service with the idempotency
    // key from the header.
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0][1]).toBe('idem-123');
    expect(ingest.mock.calls[0][0]).toMatchObject(VALID_BODY);
  });

  it('returns 200 for a duplicate', async () => {
    ingest.mockResolvedValue({
      requestId: VALID_BODY.request_id,
      status: 'PENDING',
      duplicate: true,
      message: 'already received',
    });

    const res = await post(VALID_BODY, { 'x-api-key': API_KEY });
    expect(res.status).toBe(200);
  });

  it('rejects an invalid body (400) via the validation pipe before the service runs', async () => {
    const res = await post(
      { ...VALID_BODY, employee_id: 'not-an-id' },
      { 'x-api-key': API_KEY },
    );
    expect(res.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rejects unknown fields (400) via forbidNonWhitelisted', async () => {
    const res = await post(
      { ...VALID_BODY, role: 'admin' },
      { 'x-api-key': API_KEY },
    );
    expect(res.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });
});
