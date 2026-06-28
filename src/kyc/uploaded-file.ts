/**
 * Minimal shape of a multipart file as produced by multer's in-memory storage
 * (the default backing Nest's `FileFieldsInterceptor`). We declare only the
 * fields we consume so we don't need to depend on `@types/multer`.
 */
export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}
