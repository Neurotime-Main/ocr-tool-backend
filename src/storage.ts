import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { config, isSpacesDriver } from './config.js';

export type StorageStatus = { driver: string; ok: boolean; detail: string };

export interface FileStorage {
  saveTemporaryFile(tempPath: string): Promise<string>;
  materialize(key: string, destinationDir: string): Promise<string>;
  createReadStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  /** Cheap reachability probe for `/api/health`; never throws. */
  check(): Promise<StorageStatus>;
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
    const source = this.resolve(key);
    // The file is read where it already lives, so nothing is copied. It is
    // checked here because a local storage directory does not survive a restart
    // on a host with an ephemeral disk, while the database row does: without
    // this the loss surfaces as an ENOENT from whichever stage touched the file
    // first, naming a path that says nothing about the cause.
    await access(source).catch(() => {
      throw new Error(
        'The stored PDF is missing because STORAGE_DRIVER is set to \'local\'. '
        + (config.runWorkerInProcess
          ? 'This disk is ephemeral and the file was lost during a deploy or restart. '
          : 'The API and OCR worker use separate disks, so the worker cannot read a file the API wrote locally. ')
        + 'Set STORAGE_DRIVER=spaces with the DO_SPACES_* variables on every service, then re-upload the lost PDF.',
      );
    });
    return source;
  }

  async createReadStream(key: string) {
    return createReadStream(this.resolve(key));
  }

  async delete(key: string) {
    await unlink(this.resolve(key)).catch(() => undefined);
  }

  async check(): Promise<StorageStatus> {
    try {
      await mkdir(this.root, { recursive: true });
      return { driver: 'local', ok: true, detail: this.root };
    } catch (error) {
      return { driver: 'local', ok: false, detail: (error as Error).message };
    }
  }
}

export class SpacesFileStorage implements FileStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    private readonly prefix: string,
  ) {
    this.client = new S3Client({
      region: config.spaces.region,
      // Spaces is only reachable through its own endpoint; without this the
      // SDK builds an amazonaws.com hostname and never contacts DigitalOcean.
      endpoint: config.spaces.endpoint,
      forcePathStyle: config.spaces.forcePathStyle,
      // A Spaces key pair is the only credential source: there is no metadata
      // service to fall back to, so passing the keys explicitly turns a typo
      // into an immediate failure rather than a slow provider-chain timeout.
      ...(config.spaces.accessKeyId && config.spaces.secretAccessKey
        ? {
          credentials: {
            accessKeyId: config.spaces.accessKeyId,
            secretAccessKey: config.spaces.secretAccessKey,
          },
        }
        : {}),
      maxAttempts: config.spaces.maxAttempts,
      ...(config.spaces.disableChecksums ? { requestChecksumCalculation: 'WHEN_REQUIRED' as const } : {}),
      // Without these, a stalled connection would hold an OCR slot until the
      // platform kills the request.
      requestHandler: new NodeHttpHandler({
        connectionTimeout: config.spaces.connectionTimeoutMs,
        requestTimeout: config.spaces.requestTimeoutMs,
      }),
    });
  }

  private newKey() {
    return this.prefix ? `${this.prefix}/${randomUUID()}.pdf` : `${randomUUID()}.pdf`;
  }

  async saveTemporaryFile(tempPath: string) {
    const key = this.newKey();
    try {
      const { size } = await stat(tempPath);
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(tempPath),
        // Spaces rejects a streamed body without a length, and the SDK can only
        // infer one for buffers, so uploads fail intermittently without this.
        ContentLength: size,
        ContentType: 'application/pdf',
        // Spaces encrypts at rest by itself and rejects the SSE header, so it
        // is sent only where these variables point at a store that wants one.
        ...(config.spaces.serverSideEncryption
          ? { ServerSideEncryption: config.spaces.serverSideEncryption as 'AES256' }
          : {}),
      }));
      return key;
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }

  async createReadStream(key: string) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error('Spaces returned an empty document body.');
    return result.Body as Readable;
  }

  async materialize(key: string, destinationDir: string) {
    await mkdir(destinationDir, { recursive: true });
    const destination = path.join(destinationDir, path.basename(key));
    await pipeline(await this.createReadStream(key), createWriteStream(destination));
    return destination;
  }

  async delete(key: string) {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      // An object that is already gone is a successful rollback, not a failure.
      if ((error as { name?: string }).name === 'NoSuchKey') return;
      throw error;
    }
  }

  async check(): Promise<StorageStatus> {
    // HeadObject on a key that does not exist is enough to prove the Space,
    // region, and credentials work, and it needs only read permission.
    // HeadBucket would demand a broader grant than the service otherwise uses.
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: `${this.prefix ? `${this.prefix}/` : ''}.markwise-health-probe`,
      }));
      return { driver: 'spaces', ok: true, detail: this.bucket };
    } catch (error) {
      const name = (error as { name?: string }).name;
      // "Not found" is the expected answer and proves the round trip worked.
      if (name === 'NotFound' || name === 'NoSuchKey') {
        return { driver: 'spaces', ok: true, detail: this.bucket };
      }
      return { driver: 'spaces', ok: false, detail: `${name ?? 'Error'}: ${(error as Error).message}` };
    }
  }
}

function createStorage(): FileStorage {
  if (isSpacesDriver(config.storageDriver)) {
    if (!config.spaces.bucket) throw new Error('DO_SPACES_BUCKET is required when STORAGE_DRIVER=spaces.');
    return new SpacesFileStorage(config.spaces.bucket, config.spaces.prefix);
  }
  if (config.storageDriver === 'local') return new LocalFileStorage(config.storageDir);
  throw new Error(`Unsupported STORAGE_DRIVER: ${config.storageDriver}. Use 'local' or 'spaces'.`);
}

export const storage = createStorage();
