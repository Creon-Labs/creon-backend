import type { StorageService } from '../storage/storage.service';

/** Allowed gallery image MIME types → file extension. */
export const IMAGE_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Allowed document MIME types → file extension. */
export const DOCUMENT_MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
};

export const MAX_IMAGES = 5;
export const MAX_DOCUMENTS = 3;
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

/** Prisma select for media rows (includes objectKey for internal URL mapping). */
export const MEDIA_SELECT = {
  id: true,
  kind: true,
  mimeType: true,
  originalName: true,
  sizeBytes: true,
  sortOrder: true,
  objectKey: true,
  createdAt: true,
} as const;

export type MediaRow = {
  id: string;
  kind: string;
  mimeType: string;
  originalName: string | null;
  sizeBytes: number;
  sortOrder: number;
  objectKey: string;
  createdAt: Date;
};

/** Public media DTO — never includes objectKey. */
export type MediaResponse = {
  id: string;
  kind: string;
  mimeType: string;
  originalName: string | null;
  sizeBytes: number;
  sortOrder: number;
  url: string;
  createdAt: Date;
};

/**
 * Prefer a stable public URL when `R2_PUBLIC_URL` is configured; fall back to a
 * short-lived presigned GET for private / unconfigured public bases.
 */
export async function resolveMediaUrl(
  storage: StorageService,
  objectKey: string,
): Promise<string> {
  try {
    return storage.getPublicUrl(objectKey);
  } catch {
    return storage.getPresignedDownloadUrl(objectKey);
  }
}

/** Map DB media rows to API-facing objects with URLs (strips objectKey). */
export async function mapMediaToResponse(
  storage: StorageService,
  media: MediaRow[],
): Promise<MediaResponse[]> {
  return Promise.all(
    media.map(async (m) => {
      const { objectKey, ...rest } = m;
      return {
        ...rest,
        url: await resolveMediaUrl(storage, objectKey),
      };
    }),
  );
}
