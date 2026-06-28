import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Body types accepted by an S3 `PutObject`. */
export type StorageBody = Buffer | Uint8Array | string;

/**
 * Thin wrapper around an S3-compatible object store (Cloudflare R2 in
 * production, MinIO in local dev). Configured entirely from environment
 * variables via {@link ConfigService}; see `.env.example` for the keys.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl?: string;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.getOrThrow<string>('R2_BUCKET');
    this.publicUrl = this.config.get<string>('R2_PUBLIC_URL');

    const endpoint =
      this.config.get<string>('R2_ENDPOINT') ??
      `https://${this.config.getOrThrow<string>('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`;

    this.client = new S3Client({
      region: 'auto',
      endpoint,
      // Path-style addressing is required by MinIO; R2 works with either but
      // virtual-hosted style is the default (leave R2_FORCE_PATH_STYLE unset).
      forcePathStyle: this.config.get<string>('R2_FORCE_PATH_STYLE') === 'true',
      credentials: {
        accessKeyId: this.config.getOrThrow<string>('R2_ACCESS_KEY_ID'),
        secretAccessKey: this.config.getOrThrow<string>('R2_SECRET_ACCESS_KEY'),
      },
    });
  }

  /** Upload an object. Returns the key it was stored under. */
  async upload(
    key: string,
    body: StorageBody,
    contentType?: string,
  ): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    this.logger.log(`Uploaded object: ${key}`);
    return key;
  }

  /** Fetch an object. The body is available as a stream on the result. */
  async download(key: string): Promise<GetObjectCommandOutput> {
    return this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /** Delete an object. No-op if the key does not exist. */
  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    this.logger.log(`Deleted object: ${key}`);
  }

  /** Whether an object exists in the bucket. */
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (error: unknown) {
      if (this.isNotFound(error)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Presigned URL a client can `PUT` directly to, bypassing this server.
   * @param expiresIn lifetime in seconds (default 15 min).
   */
  async getPresignedUploadUrl(
    key: string,
    contentType?: string,
    expiresIn = 900,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn },
    );
  }

  /**
   * Presigned URL a client can `GET` directly from, bypassing this server.
   * Use this for private objects; for public buckets prefer {@link getPublicUrl}.
   * @param expiresIn lifetime in seconds (default 15 min).
   */
  async getPresignedDownloadUrl(key: string, expiresIn = 900): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn },
    );
  }

  /**
   * Stable public URL for an object, valid only when the bucket is served
   * publicly (R2 `pub-*.r2.dev`, a custom domain, or MinIO anonymous read).
   * Requires `R2_PUBLIC_URL` to be configured.
   */
  getPublicUrl(key: string): string {
    if (!this.publicUrl) {
      throw new Error(
        'R2_PUBLIC_URL is not configured; cannot build a public URL. ' +
          'Use getPresignedDownloadUrl() for private objects instead.',
      );
    }
    return `${this.publicUrl.replace(/\/$/, '')}/${key}`;
  }

  private isNotFound(error: unknown): boolean {
    const meta = (error as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata;
    const name = (error as { name?: string })?.name;
    return (
      meta?.httpStatusCode === 404 ||
      name === 'NotFound' ||
      name === 'NoSuchKey'
    );
  }
}
