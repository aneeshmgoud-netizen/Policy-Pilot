import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { findMockUserByToken, MockDashboardUser } from '../mock-users.constant';

export interface AuthenticatedRequest extends Request {
  user: MockDashboardUser;
}

const BEARER_PREFIX = 'Bearer ';

/**
 * Authenticates and authorizes dashboard-facing endpoints (as opposed to the
 * ingestion webhook's ApiKeyGuard, which is a machine-to-machine credential).
 * Extracts a mock bearer token, resolves it to a fixed reviewer identity (see
 * mock-users.constant.ts), and requires role === 'REVIEWER' to proceed.
 *
 * The resolved identity is attached to the request as `request.user` — this
 * is the ONLY trusted source of reviewerId for a human decision. Any
 * reviewer identity a client attempts to supply elsewhere (e.g. a header or
 * request body field) must never be used in its place.
 */
@Injectable()
export class DashboardAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.header('authorization');

    if (!header || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    const token = header.slice(BEARER_PREFIX.length).trim();
    const user = findMockUserByToken(token);
    if (!user) {
      throw new UnauthorizedException('Invalid bearer token');
    }

    if (user.role !== 'REVIEWER') {
      throw new ForbiddenException(
        `Role ${user.role} is not permitted to access this resource; REVIEWER required`,
      );
    }

    request.user = user;
    return true;
  }
}
