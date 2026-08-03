import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

// The PDF-mandated guarantee this filter exists for: an unanticipated error
// (a raw DB error, a downstream timeout, anything not deliberately thrown as
// an HttpException) must never leak its message, stack, cause, or any
// exception-derived text into the application log or the HTTP response.
// Getters that throw if touched prove the body is genuinely never read,
// which is a stronger guarantee than asserting on redaction output.
function makeUnreadableError(): Error {
  const err = new Error('placeholder');
  for (const prop of ['message', 'stack', 'cause', 'name']) {
    Object.defineProperty(err, prop, {
      get() {
        throw new Error(`must not read err.${prop}`);
      },
    });
  }
  return err;
}

function makeHost(request: { method: string; path: string; route?: { path: string } }) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  it('never reads message/stack/cause/name off an unexpected exception', () => {
    const filter = new AllExceptionsFilter();
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host, status, json } = makeHost({
      method: 'POST',
      path: '/api/v1/access-requests/abc/decisions',
      route: { path: '/access-requests/:id/decisions' },
    });

    expect(() => filter.catch(makeUnreadableError(), host)).not.toThrow();

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Internal server error',
    });
    errorSpy.mockRestore();
  });

  it('logs only a stable code plus method/route — never sensitive request data', () => {
    const filter = new AllExceptionsFilter();
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = makeHost({
      method: 'POST',
      path: '/api/v1/access-requests/EMP-52190/decisions',
      route: { path: '/access-requests/:id/decisions' },
    });

    filter.catch(makeUnreadableError(), host);

    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('UNHANDLED_EXCEPTION');
    expect(logged).toContain('method=POST');
    // The route template, not the raw path with its interpolated id.
    expect(logged).toContain('route=/access-requests/:id/decisions');
    expect(logged).not.toContain('EMP-52190');
    errorSpy.mockRestore();
  });

  it('lets an HttpException pass through with its own status and body untouched', () => {
    const filter = new AllExceptionsFilter();
    const { host, status, json } = makeHost({ method: 'GET', path: '/api/v1/access-requests' });

    filter.catch(new BadRequestException('bad payload'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: 'bad payload' }),
    );
  });
});
