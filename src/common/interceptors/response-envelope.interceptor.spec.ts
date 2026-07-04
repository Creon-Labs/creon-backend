import { CallHandler, ExecutionContext, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { RESPONSE_MESSAGE_KEY } from '../constants/response-message.constants';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';

function makeContext(statusCode: number): ExecutionContext {
  const response = { statusCode };
  return {
    switchToHttp: () => ({ getResponse: () => response }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function makeHandler(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

function makeReflector(message: string | undefined): Reflector {
  return {
    getAllAndOverride: jest.fn(() => message),
  } as unknown as Reflector;
}

describe('ResponseEnvelopeInterceptor', () => {
  it('wraps a normal 200 response with the @ResponseMessage value', (done) => {
    const interceptor = new ResponseEnvelopeInterceptor(
      makeReflector('Campaigns retrieved'),
    );
    interceptor
      .intercept(makeContext(200), makeHandler([{ id: '1' }]))
      .subscribe((result) => {
        expect(result).toEqual({
          statusCode: 200,
          message: 'Campaigns retrieved',
          data: [{ id: '1' }],
        });
        done();
      });
  });

  it('falls back to the default message when @ResponseMessage is missing', (done) => {
    const interceptor = new ResponseEnvelopeInterceptor(
      makeReflector(undefined),
    );
    interceptor
      .intercept(makeContext(201), makeHandler({ id: '1' }))
      .subscribe((result) => {
        expect(result).toEqual({
          statusCode: 201,
          message: 'Success',
          data: { id: '1' },
        });
        done();
      });
  });

  it('skips enveloping a 204 response', (done) => {
    const interceptor = new ResponseEnvelopeInterceptor(
      makeReflector('Ignored'),
    );
    interceptor
      .intercept(makeContext(HttpStatus.NO_CONTENT), makeHandler(undefined))
      .subscribe((result) => {
        expect(result).toBeUndefined();
        done();
      });
  });

  it('skips enveloping when the handler returns undefined on a non-204 route', (done) => {
    const interceptor = new ResponseEnvelopeInterceptor(
      makeReflector('Ignored'),
    );
    interceptor
      .intercept(makeContext(200), makeHandler(undefined))
      .subscribe((result) => {
        expect(result).toBeUndefined();
        done();
      });
  });

  it('wraps a legitimate null payload rather than skipping it', (done) => {
    const interceptor = new ResponseEnvelopeInterceptor(
      makeReflector('Campaign refund retrieved'),
    );
    interceptor
      .intercept(makeContext(200), makeHandler(null))
      .subscribe((result) => {
        expect(result).toEqual({
          statusCode: 200,
          message: 'Campaign refund retrieved',
          data: null,
        });
        done();
      });
  });

  it('reads the real @ResponseMessage decorator end to end via a real Reflector', (done) => {
    class Dummy {
      handler() {}
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method -- used only as a metadata target, never called unbound
    const handlerRef = Dummy.prototype.handler;
    Reflect.defineMetadata(
      RESPONSE_MESSAGE_KEY,
      'Login successful',
      handlerRef,
    );
    const context = {
      switchToHttp: () => ({ getResponse: () => ({ statusCode: 200 }) }),
      getHandler: () => handlerRef,
      getClass: () => Dummy,
    } as unknown as ExecutionContext;

    new ResponseEnvelopeInterceptor(new Reflector())
      .intercept(context, makeHandler({ userId: 'u1' }))
      .subscribe((result) => {
        expect(result).toEqual({
          statusCode: 200,
          message: 'Login successful',
          data: { userId: 'u1' },
        });
        done();
      });
  });
});
