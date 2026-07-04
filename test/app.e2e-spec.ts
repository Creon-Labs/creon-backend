import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import type { ApiErrorResponse } from '../src/common/interfaces/api-response.interface';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          statusCode: 200,
          message: 'OK',
          data: 'Hello World!',
        });
      });
  });

  it('/auth/challenge (POST) — validation error returns the error envelope', () => {
    return request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ walletAddress: 'too-short' })
      .expect(400)
      .expect(({ body }: { body: ApiErrorResponse }) => {
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('Bad Request');
        expect(body.data).toBeNull();
        expect(Array.isArray(body.message)).toBe(true);
      });
  });

  it('/auth/logout (POST) — 204 has a genuinely empty body', () => {
    return request(app.getHttpServer())
      .post('/auth/logout')
      .expect(204)
      .expect((res) => {
        expect(res.text).toBe('');
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
