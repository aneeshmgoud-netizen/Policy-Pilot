import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateAccessRequestDto } from './create-access-request.dto';

const VALID_PAYLOAD = {
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

async function validatePayload(overrides: Record<string, unknown>) {
  const dto = plainToInstance(CreateAccessRequestDto, {
    ...VALID_PAYLOAD,
    ...overrides,
  });
  return validate(dto);
}

describe('CreateAccessRequestDto', () => {
  it('accepts the PDF sample payload with no errors', async () => {
    const errors = await validatePayload({});
    expect(errors).toHaveLength(0);
  });

  it('rejects a malformed employee_id', async () => {
    const errors = await validatePayload({ employee_id: 'not-an-id' });
    expect(errors.some((e) => e.property === 'employee_id')).toBe(true);
  });

  it('rejects a malformed cost_center', async () => {
    const errors = await validatePayload({
      requester: { ...VALID_PAYLOAD.requester, cost_center: 'INVALID' },
    });
    const requesterError = errors.find((e) => e.property === 'requester');
    expect(
      requesterError?.children?.some((c) => c.property === 'cost_center'),
    ).toBe(true);
  });

  it('rejects an empty justification', async () => {
    const errors = await validatePayload({
      target: { ...VALID_PAYLOAD.target, justification: '' },
    });
    const targetError = errors.find((e) => e.property === 'target');
    expect(
      targetError?.children?.some((c) => c.property === 'justification'),
    ).toBe(true);
  });

  it('rejects a non-ISO8601 timestamp', async () => {
    const errors = await validatePayload({ timestamp: 'not-a-date' });
    expect(errors.some((e) => e.property === 'timestamp')).toBe(true);
  });

  it('rejects a request_type outside the allow-list', async () => {
    const errors = await validatePayload({ request_type: 'DELETE_EVERYTHING' });
    expect(errors.some((e) => e.property === 'request_type')).toBe(true);
  });
});
