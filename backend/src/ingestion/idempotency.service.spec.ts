import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyService } from './idempotency.service';

function makePrismaMock() {
  return {
    idempotencyKey: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    accessRequest: {
      findUnique: jest.fn(),
    },
  } as unknown as PrismaService & {
    idempotencyKey: { findUnique: jest.Mock; upsert: jest.Mock };
    accessRequest: { findUnique: jest.Mock };
  };
}

describe('IdempotencyService', () => {
  it('returns the linked access request when the idempotency key is on file', async () => {
    const prisma = makePrismaMock();
    const accessRequest = { id: 'ar-1', requestId: 'req-1', status: 'PENDING' };
    prisma.idempotencyKey.findUnique.mockResolvedValue({ accessRequest });
    const service = new IdempotencyService(prisma);

    const result = await service.findExisting('req-999', 'key-abc');

    expect(result).toBe(accessRequest);
    expect(prisma.accessRequest.findUnique).not.toHaveBeenCalled();
  });

  it('falls back to request_id when the key is not on file, and records the new key', async () => {
    const prisma = makePrismaMock();
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    const accessRequest = { id: 'ar-1', requestId: 'req-1', status: 'PENDING' };
    prisma.accessRequest.findUnique.mockResolvedValue(accessRequest);
    const service = new IdempotencyService(prisma);

    const result = await service.findExisting('req-1', 'key-new');

    expect(result).toBe(accessRequest);
    expect(prisma.idempotencyKey.upsert).toHaveBeenCalledWith({
      where: { key: 'key-new' },
      update: {},
      create: { key: 'key-new', accessRequestId: 'ar-1' },
    });
  });

  it('returns null and records nothing when neither the key nor the request_id match', async () => {
    const prisma = makePrismaMock();
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.accessRequest.findUnique.mockResolvedValue(null);
    const service = new IdempotencyService(prisma);

    const result = await service.findExisting('req-brand-new', 'key-new');

    expect(result).toBeNull();
    expect(prisma.idempotencyKey.upsert).not.toHaveBeenCalled();
  });

  it('skips the key lookup entirely when no key is provided', async () => {
    const prisma = makePrismaMock();
    prisma.accessRequest.findUnique.mockResolvedValue(null);
    const service = new IdempotencyService(prisma);

    await service.findExisting('req-1', undefined);

    expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
  });
});
