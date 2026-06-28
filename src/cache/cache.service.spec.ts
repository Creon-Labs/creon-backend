import { ConfigService } from '@nestjs/config';
import { GlideClient, TimeUnit } from '@valkey/valkey-glide';
import { CacheService } from './cache.service';

/** Minimal ConfigService stub backed by a plain record. */
function makeConfig(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    VALKEY_HOST: 'localhost',
    VALKEY_PORT: '6379',
    VALKEY_USE_TLS: 'false',
    VALKEY_PASSWORD: undefined,
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

/** Fake glide client capturing calls. */
function makeFakeClient() {
  return {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

describe('CacheService', () => {
  let fakeClient: ReturnType<typeof makeFakeClient>;
  let createClient: jest.SpyInstance;

  beforeEach(() => {
    fakeClient = makeFakeClient();
    createClient = jest
      .spyOn(GlideClient, 'createClient')
      .mockResolvedValue(fakeClient as unknown as GlideClient);
  });

  afterEach(() => jest.restoreAllMocks());

  async function init(overrides?: Record<string, string | undefined>) {
    const service = new CacheService(makeConfig(overrides));
    await service.onModuleInit();
    return service;
  }

  it('connects with addresses and no credentials by default', async () => {
    await init();
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        addresses: [{ host: 'localhost', port: 6379 }],
        useTLS: false,
        credentials: undefined,
      }),
    );
  });

  it('passes credentials when a password is configured', async () => {
    await init({ VALKEY_PASSWORD: 'secret' });
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { password: 'secret' } }),
    );
  });

  it('sets with a TTL expiry in seconds', async () => {
    const service = await init();
    await service.set('k', 'v', 300);
    expect(fakeClient.set).toHaveBeenCalledWith('k', 'v', {
      expiry: { type: TimeUnit.Seconds, count: 300 },
    });
  });

  it('sets without expiry when no TTL given', async () => {
    const service = await init();
    await service.set('k', 'v');
    expect(fakeClient.set).toHaveBeenCalledWith('k', 'v', undefined);
  });

  it('wraps the key in an array on del', async () => {
    const service = await init();
    await service.del('k');
    expect(fakeClient.del).toHaveBeenCalledWith(['k']);
  });

  it('returns null from get for an absent key', async () => {
    fakeClient.get.mockResolvedValue(null);
    const service = await init();
    await expect(service.get('missing')).resolves.toBeNull();
  });

  it('round-trips JSON via setJson/getJson', async () => {
    const service = await init();
    await service.setJson('k', { a: 1 }, 60);
    expect(fakeClient.set).toHaveBeenCalledWith('k', '{"a":1}', {
      expiry: { type: TimeUnit.Seconds, count: 60 },
    });

    fakeClient.get.mockResolvedValue('{"a":1}');
    await expect(service.getJson<{ a: number }>('k')).resolves.toEqual({
      a: 1,
    });
  });

  it('closes the client on destroy', async () => {
    const service = await init();
    service.onModuleDestroy();
    expect(fakeClient.close).toHaveBeenCalled();
  });
});
