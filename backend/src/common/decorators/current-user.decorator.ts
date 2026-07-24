import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest } from '../guards/dashboard-auth.guard';
import { MockDashboardUser } from '../mock-users.constant';

/** Reads the authenticated user attached by DashboardAuthGuard. Only usable on a route protected by that guard — guard order matters. */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): MockDashboardUser => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user;
  },
);
