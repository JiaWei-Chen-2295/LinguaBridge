import { Client } from "minio";
import type { GatewayConfig, ObjectStorageConfig } from "../config";

export interface PutObjectInput {
  key: string;
  body: Buffer | string;
  contentType: string;
  metadata?: Record<string, string>;
}

export interface PutFileInput {
  key: string;
  filePath: string;
  contentType: string;
  metadata?: Record<string, string>;
}

export interface PutObjectResult {
  key: string;
  sizeBytes: number;
}

export interface DeletePrefixResult {
  prefix: string;
  deletedKeys: string[];
}

export interface ObjectStorage {
  ensureReady(): Promise<void>;
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  putFile(input: PutFileInput): Promise<PutObjectResult>;
  deleteObject(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<DeletePrefixResult>;
  makeSessionPrefix(userId: string, sessionId: string): string;
}

interface ListedObject {
  name?: string;
}

export function createObjectStorage(config: GatewayConfig): ObjectStorage {
  if (
    config.objectStorage.provider === "minio" ||
    config.objectStorage.provider === "oss"
  ) {
    return new MinioObjectStorage(config.objectStorage);
  }

  return new DisabledObjectStorage(config.objectStorage);
}

class DisabledObjectStorage implements ObjectStorage {
  public constructor(private readonly config: ObjectStorageConfig) {}

  public async ensureReady(): Promise<void> {
    return Promise.resolve();
  }

  public async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    return Promise.resolve({
      key: this.withGlobalPrefix(input.key),
      sizeBytes: objectSize(input.body)
    });
  }

  public async putFile(input: PutFileInput): Promise<PutObjectResult> {
    const { stat } = await import("node:fs/promises");
    const fileStat = await stat(input.filePath);
    return Promise.resolve({
      key: this.withGlobalPrefix(input.key),
      sizeBytes: fileStat.size
    });
  }

  public async deleteObject(_key: string): Promise<void> {
    return Promise.resolve();
  }

  public async deletePrefix(prefix: string): Promise<DeletePrefixResult> {
    return Promise.resolve({
      prefix: this.withGlobalPrefix(prefix),
      deletedKeys: []
    });
  }

  public makeSessionPrefix(userId: string, sessionId: string): string {
    return sessionPrefix(userId, sessionId);
  }

  private withGlobalPrefix(key: string): string {
    return `${this.config.objectPrefix}${stripLeadingSlashes(key)}`;
  }
}

class MinioObjectStorage implements ObjectStorage {
  private readonly client: Client;

  public constructor(private readonly config: ObjectStorageConfig) {
    this.client = new Client({
      endPoint: config.minio.endPoint,
      port: config.minio.port,
      useSSL: config.minio.useSSL,
      accessKey: config.minio.accessKey,
      secretKey: config.minio.secretKey,
      region: config.region
    });
  }

  public async ensureReady(): Promise<void> {
    const exists = await this.client.bucketExists(this.config.bucket);
    if (!exists) {
      await this.client.makeBucket(this.config.bucket, this.config.region);
    }
  }

  public async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const key = this.withGlobalPrefix(input.key);
    const sizeBytes = objectSize(input.body);
    await this.client.putObject(
      this.config.bucket,
      key,
      input.body,
      sizeBytes,
      {
        "Content-Type": input.contentType,
        ...(input.metadata ?? {})
      }
    );

    return { key, sizeBytes };
  }

  public async putFile(input: PutFileInput): Promise<PutObjectResult> {
    const key = this.withGlobalPrefix(input.key);
    const { stat } = await import("node:fs/promises");
    const fileStat = await stat(input.filePath);
    await this.client.fPutObject(this.config.bucket, key, input.filePath, {
      "Content-Type": input.contentType,
      ...(input.metadata ?? {})
    });

    return { key, sizeBytes: fileStat.size };
  }

  public async deleteObject(key: string): Promise<void> {
    await this.client.removeObject(this.config.bucket, this.withGlobalPrefix(key));
  }

  public async deletePrefix(prefix: string): Promise<DeletePrefixResult> {
    const normalizedPrefix = this.withGlobalPrefix(prefix);
    const keys = await this.listKeys(normalizedPrefix);
    if (keys.length > 0) {
      await this.client.removeObjects(this.config.bucket, keys);
    }

    return {
      prefix: normalizedPrefix,
      deletedKeys: keys
    };
  }

  public makeSessionPrefix(userId: string, sessionId: string): string {
    return sessionPrefix(userId, sessionId);
  }

  private async listKeys(prefix: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const keys: string[] = [];
      const stream = this.client.listObjects(this.config.bucket, prefix, true);

      stream.on("data", (item: ListedObject) => {
        if (typeof item.name === "string" && item.name.length > 0) {
          keys.push(item.name);
        }
      });
      stream.on("error", (error: unknown) => reject(error));
      stream.on("end", () => resolve(keys));
    });
  }

  private withGlobalPrefix(key: string): string {
    return `${this.config.objectPrefix}${stripLeadingSlashes(key)}`;
  }
}

function sessionPrefix(userId: string, sessionId: string): string {
  return `users/${userId}/sessions/${sessionId}/`;
}

function stripLeadingSlashes(value: string): string {
  return value.replace(/^\/+/, "");
}

function objectSize(value: Buffer | string): number {
  return Buffer.isBuffer(value)
    ? value.byteLength
    : Buffer.byteLength(value, "utf8");
}
