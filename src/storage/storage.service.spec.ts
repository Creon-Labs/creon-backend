import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { StorageService } from './storage.service';

const s3Mock = mockClient(S3Client);

/** Minimal ConfigService stub backed by a plain record. */
function makeConfig(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    R2_BUCKET: 'creon-assets',
    R2_ACCESS_KEY_ID: 'test-key',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_ENDPOINT: 'http://localhost:9000',
    R2_FORCE_PATH_STYLE: 'true',
    R2_PUBLIC_URL: 'http://localhost:9000/creon-assets',
    ...overrides,
  };
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];
      if (value === undefined) {
        throw new Error(`Missing config: ${key}`);
      }
      return value;
    },
  } as unknown as ConfigService;
}

describe('StorageService', () => {
  beforeEach(() => s3Mock.reset());

  it('uploads with the configured bucket and key', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const service = new StorageService(makeConfig());

    const key = await service.upload(
      'a/b.txt',
      Buffer.from('hi'),
      'text/plain',
    );

    expect(key).toBe('a/b.txt');
    expect(
      s3Mock.commandCalls(PutObjectCommand)[0].args[0].input,
    ).toMatchObject({
      Bucket: 'creon-assets',
      Key: 'a/b.txt',
      ContentType: 'text/plain',
    });
  });

  it('deletes by key', async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    const service = new StorageService(makeConfig());

    await service.delete('a/b.txt');

    expect(
      s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input,
    ).toMatchObject({ Bucket: 'creon-assets', Key: 'a/b.txt' });
  });

  it('reports existence via HeadObject', async () => {
    const service = new StorageService(makeConfig());

    s3Mock.on(HeadObjectCommand).resolves({});
    await expect(service.exists('there.txt')).resolves.toBe(true);

    s3Mock.reset();
    s3Mock.on(HeadObjectCommand).rejects(
      Object.assign(new Error('Not Found'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      }),
    );
    await expect(service.exists('missing.txt')).resolves.toBe(false);
  });

  it('builds a public URL when configured', () => {
    const service = new StorageService(makeConfig());

    expect(service.getPublicUrl('x/y.png')).toBe(
      'http://localhost:9000/creon-assets/x/y.png',
    );
  });

  it('throws when building a public URL without R2_PUBLIC_URL', () => {
    const service = new StorageService(
      makeConfig({ R2_PUBLIC_URL: undefined }),
    );

    expect(() => service.getPublicUrl('x')).toThrow(/R2_PUBLIC_URL/);
  });

  it('returns presigned upload and download URLs', async () => {
    const service = new StorageService(makeConfig());

    const uploadUrl = await service.getPresignedUploadUrl(
      'p/q.txt',
      'text/plain',
    );
    const downloadUrl = await service.getPresignedDownloadUrl('p/q.txt');

    expect(uploadUrl).toContain('/creon-assets/p/q.txt');
    expect(uploadUrl).toContain('X-Amz-Signature');
    expect(downloadUrl).toContain('/creon-assets/p/q.txt');
    expect(downloadUrl).toContain('X-Amz-Signature');
  });
});
