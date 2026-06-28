import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GlideClient, TimeUnit } from '@valkey/valkey-glide';

/**
 * Thin wrapper around a Valkey connection (via valkey-glide). Used for general
 * caching and for short-lived data such as wallet-auth challenges. Configured
 * from environment variables via {@link ConfigService}; see `.env.example`.
 *
 * The glide client factory is async, so the connection is established in
 * {@link onModuleInit} rather than the constructor.
 */
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private client!: GlideClient;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const host = this.config.getOrThrow<string>('VALKEY_HOST');
    const port = Number(this.config.get<string>('VALKEY_PORT') ?? '6379');
    const password = this.config.get<string>('VALKEY_PASSWORD') || undefined;

    this.client = await GlideClient.createClient({
      addresses: [{ host, port }],
      useTLS: this.config.get<string>('VALKEY_USE_TLS') === 'true',
      credentials: password ? { password } : undefined,
      requestTimeout: 500,
    });
    this.logger.log(`Connected to Valkey at ${host}:${port}`);
  }

  onModuleDestroy(): void {
    this.client?.close();
  }

  /** Get a string value, or null if the key is absent. */
  async get(key: string): Promise<string | null> {
    const value = await this.client.get(key);
    return value === null ? null : value.toString();
  }

  /** Set a string value, optionally expiring after `ttlSeconds`. */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.client.set(
      key,
      value,
      ttlSeconds
        ? { expiry: { type: TimeUnit.Seconds, count: ttlSeconds } }
        : undefined,
    );
  }

  /** Delete a key. No-op if it does not exist. */
  async del(key: string): Promise<void> {
    await this.client.del([key]);
  }

  /** Get a JSON-decoded value, or null if the key is absent. */
  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  /** Set a JSON-encoded value, optionally expiring after `ttlSeconds`. */
  async setJson(
    key: string,
    value: unknown,
    ttlSeconds?: number,
  ): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }
}
