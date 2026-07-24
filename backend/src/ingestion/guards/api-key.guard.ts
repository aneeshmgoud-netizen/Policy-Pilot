import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';

// Shared-secret guard for the ingestion webhook. There is no upstream
// system issuing real credentials yet, so this is a deliberate stand-in for
// the security boundary: a static key set via INGESTION_API_KEY, checked
// against the X-API-Key header. A production deployment would replace this
// with mTLS or OAuth2 client-credentials from the upstream HRIS/ITSM
// system, but the boundary itself — every ingestion call must present a
// valid credential — is real and enforced.
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const providedKey = request.header('x-api-key');
    const expectedKey = this.configService.get<string>('INGESTION_API_KEY');

    // Deny by default: an unconfigured secret must never be treated as "no
    // auth required".
    if (!expectedKey || !providedKey || !secureEquals(providedKey, expectedKey)) {
      throw new UnauthorizedException('Invalid or missing API key');
    }

    return true;
  }
}

// Constant-time comparison. A plain `===`/`!==` short-circuits on the first
// differing byte, leaking key material one character at a time via response
// timing. Hashing both sides to a fixed 32-byte digest before timingSafeEqual
// keeps the comparison constant-time regardless of input length (and avoids
// timingSafeEqual throwing on length-mismatched buffers).
function secureEquals(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}
