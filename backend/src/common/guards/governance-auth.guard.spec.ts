import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticatedRequest } from './dashboard-auth.guard';
import { GovernanceAuthGuard } from './governance-auth.guard';

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

describe('GovernanceAuthGuard', () => {
  const guard = new GovernanceAuthGuard();

  it('allows a valid GOVERNANCE_APPROVER token and attaches the user', () => {
    const { context, getRequest } = mockContext(
      'Bearer mock-token-governance',
    );
    expect(guard.canActivate(context)).toBe(true);
    expect(getRequest().user).toEqual({
      token: 'mock-token-governance',
      id: 'governance:priya',
      displayName: 'Priya Anand (governance)',
      role: 'GOVERNANCE_APPROVER',
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

  it('rejects a valid token belonging to a non-governance role', () => {
    const { context } = mockContext('Bearer mock-token-viewer');
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('rejects a REVIEWER token at the governance boundary', () => {
    const { context } = mockContext('Bearer mock-token-alice');
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
