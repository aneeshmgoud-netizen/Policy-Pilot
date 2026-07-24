import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Dual-gate idempotency check: an Idempotency-Key header takes precedence
// when present, falling back to the upstream system's own request_id.
//
// If a request_id match is found under a key we haven't seen before, we
// record that key against the existing request rather than ignoring it —
// a retry that reuses the same request_id with a *new* idempotency key is
// still the same logical request, and future retries under either
// identifier should be recognized.
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async findExisting(requestId: string, idempotencyKey?: string) {
    if (idempotencyKey) {
      const byKey = await this.prisma.idempotencyKey.findUnique({
        where: { key: idempotencyKey },
        include: { accessRequest: true },
      });
      if (byKey) {
        return byKey.accessRequest;
      }
    }

    const byRequestId = await this.prisma.accessRequest.findUnique({
      where: { requestId },
    });

    if (byRequestId && idempotencyKey) {
      await this.prisma.idempotencyKey.upsert({
        where: { key: idempotencyKey },
        update: {},
        create: { key: idempotencyKey, accessRequestId: byRequestId.id },
      });
    }

    return byRequestId;
  }
}
