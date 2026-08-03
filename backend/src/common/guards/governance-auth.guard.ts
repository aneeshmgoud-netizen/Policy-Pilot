import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from './dashboard-auth.guard';
import { findMockUserByToken } from '../mock-users.constant';

const BEARER_PREFIX = 'Bearer ';

/** Authenticates governance routes and requires a distinct approver credential. */
@Injectable()
export class GovernanceAuthGuard implements CanActivate {
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

    if (user.role !== 'GOVERNANCE_APPROVER') {
      throw new ForbiddenException(
        `Role ${user.role} is not permitted to access this resource; GOVERNANCE_APPROVER required`,
      );
    }

    request.user = user;
    return true;
  }
}
