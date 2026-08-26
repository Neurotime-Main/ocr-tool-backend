import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from './config.js';

export interface FileStorage {
  saveTemporaryFile(tempPath: string): Promise<string>;
  materialize(key: string, destinationDir: string): Promise<string>;
  createReadStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

export class LocalFileStorage implements FileStorage {
  constructor(private readonly root: string) {}

  async saveTemporaryFile(tempPath: string) {
    await mkdir(this.root, { recursive: true });
    const key = `${randomUUID()}.pdf`;
    await rename(tempPath, this.resolve(key));
    return key;
  }

  resolve(key: string) {
    const safeKey = path.basename(key);
    return path.join(this.root, safeKey);
  }

  async materialize(key: string, _destinationDir: string) {
    return this.resolve(key);
  }

  async createReadStream(key: string) {
    return createReadStream(this.resolve(key));
  }

  async delete(key: string) {
    await unlink(this.resolve(key)).catch(() => undefined);
  }
}

export class S3FileStorage implements FileStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    private readonly prefix: string,
  ) {
    this.client = new S3Client({
      region: config.s3.region,
      endpoint: config.s3.endpoint,
      forcePathStyle: config.s3.forcePathStyle,
    });
  }

  private newKey() {
    return `${this.prefix}/${randomUUID()}.pdf`;
  }

  async saveTemporaryFile(tempPath: string) {
    const key = this.newKey();
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(tempPath),
        ContentType: 'application/pdf',
        ServerSideEncryption: 'AES256',
      }));
      return key;
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }

  async createReadStream(key: string) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error('S3 returned an empty document body.');
    return result.Body as Readable;
  }

  async materialize(key: string, destinationDir: string) {
    await mkdir(destinationDir, { recursive: true });
    const destination = path.join(destinationDir, path.basename(key));
    await pipeline(await this.createReadStream(key), createWriteStream(destination));
    return destination;
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function createStorage(): FileStorage {
  if (config.storageDriver === 's3') {
    if (!config.s3.bucket) throw new Error('AWS_S3_BUCKET is required when STORAGE_DRIVER=s3.');
    return new S3FileStorage(config.s3.bucket, config.s3.prefix);
  }
  if (config.storageDriver === 'local') return new LocalFileStorage(config.storageDir);
  throw new Error(`Unsupported STORAGE_DRIVER: ${config.storageDriver}`);
}

export const storage = createStorage();
