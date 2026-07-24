import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from './api-key.guard';

function mockContext(headerValue: string | undefined): ExecutionContext {
  const request = {
    header: (name: string) =>
      name === 'x-api-key' ? headerValue : undefined,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function makeGuard(configuredKey: string | undefined): ApiKeyGuard {
  const configService = {
    get: jest.fn().mockReturnValue(configuredKey),
  } as unknown as ConfigService;
  return new ApiKeyGuard(configService);
}

describe('ApiKeyGuard', () => {
  it('allows a request with the correct key', () => {
    const guard = makeGuard('secret-123');
    expect(guard.canActivate(mockContext('secret-123'))).toBe(true);
  });

  it('rejects a request with no key', () => {
    const guard = makeGuard('secret-123');
    expect(() => guard.canActivate(mockContext(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a request with the wrong key', () => {
    const guard = makeGuard('secret-123');
    expect(() => guard.canActivate(mockContext('wrong-key'))).toThrow(
      UnauthorizedException,
    );
  });

  it('denies by default when no key is configured, even if a header is sent', () => {
    const guard = makeGuard(undefined);
    expect(() => guard.canActivate(mockContext('anything'))).toThrow(
      UnauthorizedException,
    );
  });
});
