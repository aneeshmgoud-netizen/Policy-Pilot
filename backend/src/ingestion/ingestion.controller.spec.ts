import { HttpStatus } from '@nestjs/common';
import { IngestionController } from './ingestion.controller';

function mockResponse() {
  return { status: jest.fn().mockReturnThis() } as any;
}

describe('IngestionController', () => {
  it('returns 202 for a new (non-duplicate) request', async () => {
    const service = {
      ingest: jest
        .fn()
        .mockResolvedValue({ requestId: 'req-1', status: 'PENDING', duplicate: false }),
    };
    const controller = new IngestionController(service as any);
    const res = mockResponse();

    const result = await controller.create({} as any, 'idem-1', res);

    expect(service.ingest).toHaveBeenCalledWith({}, 'idem-1');
    expect(res.status).toHaveBeenCalledWith(HttpStatus.ACCEPTED);
    expect(result.duplicate).toBe(false);
  });

  it('returns 200 for a duplicate request', async () => {
    const service = {
      ingest: jest.fn().mockResolvedValue({
        requestId: 'req-1',
        status: 'PENDING',
        duplicate: true,
        message: 'dup',
      }),
    };
    const controller = new IngestionController(service as any);
    const res = mockResponse();

    await controller.create({} as any, undefined, res);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
  });
});
