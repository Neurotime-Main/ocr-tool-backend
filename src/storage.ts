import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
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

/**
 * The uploaded file is gone and will not come back.
 *
 * Distinguished from other read failures so the queue stops retrying: a stalled
 * download is worth another attempt, a file the container no longer has is not.
 */
export class MissingSourceFileError extends Error {
  override readonly name = 'MissingSourceFileError';
}

export interface FileStorage {
  saveTemporaryFile(tempPath: string): Promise<string>;
  materialize(key: string, destinationDir: string): Promise<string>;
  createReadStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  /**
   * Stores an object that must be readable without a signature.
   *
   * Published page images are linked from `media_results` rows and opened by
   * readers who have no credentials for this Space, so unlike the source PDFs
   * they are written public-read.
   */
  savePublicObject(key: string, body: Buffer, contentType: string): Promise<void>;
  /**
   * The address a stored public object is served at.
   *
   * Owned by the storage driver rather than assembled by callers, because only
   * the driver knows the origin: a Space answers on its own hostname whether or
   * not a friendlier domain has been pointed at it.
   */
  publicUrl(key: string): string;
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
      throw new MissingSourceFileError(
        'The uploaded PDF is no longer on disk. Uploads are working files kept on this container, so '
        + 'a deploy or restart clears them; anything already recognised or published is unaffected. '
        + 'Re-upload this file to work on it again, or set STORAGE_DRIVER=spaces to keep uploads in '
        + 'object storage.',
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

  async savePublicObject(key: string, body: Buffer) {
    // Local development has no public host; the bytes are written under the
    // storage root so the path in the URL at least resolves to a real file.
    const target = path.join(this.root, key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  publicUrl(key: string) {
    return `${config.mediaImages.baseUrl || 'file://'}/${key}`;
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

  async savePublicObject(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentLength: body.length,
      ContentType: contentType,
      ACL: 'public-read',
      // These are addressed by a content hash, so a changed image is a changed
      // URL and this can be cached indefinitely.
      CacheControl: 'public, max-age=31536000, immutable',
    }));
  }

  /**
   * The Space's own public origin, used unless a custom domain is configured.
   *
   * Defaulting to a friendly hostname that nobody has pointed at the bucket yet
   * produces links that look right and 404 for everyone, which is worse than an
   * ugly URL that works. `MEDIA_IMAGE_BASE_URL` overrides this once the CDN or
   * CNAME is actually in place.
   */
  publicUrl(key: string) {
    if (config.mediaImages.baseUrl) return `${config.mediaImages.baseUrl}/${key}`;
    const host = (config.spaces.endpoint ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return `https://${this.bucket}.${host}/${key}`;
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

/**
 * Uploaded PDFs while they are being worked on.
 *
 * These are working files, not output. They are read constantly during a
 * session -- the viewer streams them, preparation parses them, recognition and
 * publishing rasterise pages from them -- and then they are of no further use:
 * what survives is the recognised text in Postgres and the published images.
 * Keeping them in object storage meant a bucket that grew by a few hundred
 * megabytes a week and held nothing anyone would ever open again.
 *
 * So they live on the container's own disk. The cost is honest and bounded: a
 * deploy or restart takes the disk with it, and any document still being worked
 * on has to be uploaded again. Nothing already recognised or published is
 * affected, because none of that depends on the PDF any more.
 *
 * Set STORAGE_DRIVER=spaces to keep the old behaviour where the file outlives
 * the container.
 */
class SourceStorage implements FileStorage {
  constructor(
    private readonly local: LocalFileStorage,
    private readonly remote: SpacesFileStorage | undefined,
    private readonly preferRemote: boolean,
  ) {}

  /**
   * Files uploaded before this change carry the bucket prefix in their key, and
   * are still in the bucket. Routing on the key keeps those documents readable
   * instead of orphaning them the moment the default changed.
   */
  private forKey(key: string): FileStorage {
    if (this.remote && key.includes('/')) return this.remote;
    return this.local;
  }

  saveTemporaryFile(tempPath: string) {
    return (this.preferRemote && this.remote ? this.remote : this.local).saveTemporaryFile(tempPath);
  }

  materialize(key: string, destinationDir: string) { return this.forKey(key).materialize(key, destinationDir); }
  createReadStream(key: string) { return this.forKey(key).createReadStream(key); }
  delete(key: string) { return this.forKey(key).delete(key); }
  savePublicObject(key: string, body: Buffer, contentType: string) {
    return this.forKey(key).savePublicObject(key, body, contentType);
  }
  publicUrl(key: string) { return this.forKey(key).publicUrl(key); }

  async check(): Promise<StorageStatus> {
    const status = await (this.preferRemote && this.remote ? this.remote : this.local).check();
    return { ...status, driver: `${status.driver} (uploads)` };
  }
}

const spacesConfigured = Boolean(
  config.spaces.bucket && config.spaces.accessKeyId && config.spaces.secretAccessKey && config.spaces.endpoint,
);

function createSpaces() {
  if (!spacesConfigured) return undefined;
  return new SpacesFileStorage(config.spaces.bucket, config.spaces.prefix);
}

const spaces = createSpaces();

export const storage: FileStorage = new SourceStorage(
  new LocalFileStorage(config.storageDir),
  spaces,
  isSpacesDriver(config.storageDriver),
);

/**
 * Where published page images go: always the Space when one is configured.
 *
 * Unlike the uploads above these are output. Their addresses are written into
 * `media_results` and opened later by people with no access to this machine, so
 * they have to outlive the container that made them.
 */
export const mediaStorage: FileStorage = spaces ?? storage;

/** True when published URLs will actually resolve for someone else. */
export function mediaStorageIsPublic() {
  return mediaStorage instanceof SpacesFileStorage;
}

/** True when an uploaded PDF outlives the container it was uploaded to. */
export function uploadsAreDurable() {
  return isSpacesDriver(config.storageDriver) && spacesConfigured;
}
