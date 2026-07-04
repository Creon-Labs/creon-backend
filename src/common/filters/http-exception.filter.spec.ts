import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

function makeHost() {
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('HttpExceptionFilter', () => {
  it('maps a NotFoundException with a custom message, preserving the reason phrase', () => {
    const { host, response } = makeHost();
    new HttpExceptionFilter().catch(
      new NotFoundException('Campaign not found'),
      host,
    );
    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 404,
      message: 'Campaign not found',
      error: 'Not Found',
      data: null,
    });
  });

  it('preserves a string[] message from a ValidationPipe-style BadRequestException', () => {
    const { host, response } = makeHost();
    new HttpExceptionFilter().catch(
      new BadRequestException([
        'walletAddress must be longer than or equal to 56 characters',
      ]),
      host,
    );
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 400,
      message: ['walletAddress must be longer than or equal to 56 characters'],
      error: 'Bad Request',
      data: null,
    });
  });

  it('maps a ForbiddenException', () => {
    const { host, response } = makeHost();
    new HttpExceptionFilter().catch(
      new ForbiddenException('Insufficient role'),
      host,
    );
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 403,
      message: 'Insufficient role',
      error: 'Forbidden',
      data: null,
    });
  });

  it('handles a plain-string HttpException body', () => {
    const { host, response } = makeHost();
    new HttpExceptionFilter().catch(
      new HttpException('plain message', 400),
      host,
    );
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 400,
      message: 'plain message',
      error: 'HttpException',
      data: null,
    });
  });

  it('maps an unknown error to a generic 500 and logs it', () => {
    const { host, response } = makeHost();
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    new HttpExceptionFilter().catch(new Error('boom'), host);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Internal server error',
      error: 'Internal Server Error',
      data: null,
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
