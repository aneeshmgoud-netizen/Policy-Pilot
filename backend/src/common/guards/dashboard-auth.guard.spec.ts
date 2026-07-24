import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthenticatedRequest, DashboardAuthGuard } from './dashboard-auth.guard';

function mockContext(authHeader: string | undefined): {
  context: ExecutionContext;
  getRequest: () => AuthenticatedRequest;
} {
  const request = {
    header: (name: string) =>
      name === 'authorization' ? authHeader : undefined,
  } as unknown as AuthenticatedRequest;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, getRequest: () => request };
}

describe('DashboardAuthGuard', () => {
  const guard = new DashboardAuthGuard();

  it('allows a request with a valid REVIEWER token and attaches the user', () => {
    const { context, getRequest } = mockContext('Bearer mock-token-alice');
    expect(guard.canActivate(context)).toBe(true);
    expect(getRequest().user).toEqual({
      token: 'mock-token-alice',
      id: 'reviewer:alice',
      displayName: 'Alice Chen',
      role: 'REVIEWER',
    });
  });

  it('rejects a request with no Authorization header', () => {
    const { context } = mockContext(undefined);
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a header that is not a Bearer token', () => {
    const { context } = mockContext('Basic somevalue');
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects an unknown token', () => {
    const { context } = mockContext('Bearer not-a-real-token');
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a valid token belonging to a non-REVIEWER role', () => {
    const { context } = mockContext('Bearer mock-token-viewer');
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
