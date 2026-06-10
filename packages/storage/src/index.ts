import { Readable } from 'node:stream';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';

// S3-compatible object storage (MinIO locally). Config from env (12-factor).

let client: S3Client | null = null;

export function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? 'conductor',
        secretAccessKey: process.env.S3_SECRET_KEY ?? 'conductor_dev_pw',
      },
    });
  }
  return client;
}

export function defaultBucket(): string {
  return process.env.S3_BUCKET ?? 'uploads';
}

/** Parse an s3://bucket/key URL into its parts. */
export function parseS3Url(url: string): { bucket: string; key: string } {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(url);
  if (!m) throw new Error(`not an s3:// url: ${url}`);
  return { bucket: m[1]!, key: m[2]! };
}

export async function ensureBucket(bucket = defaultBucket()): Promise<void> {
  try {
    await s3().send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3().send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export async function putObject(key: string, body: string | Buffer, bucket = defaultBucket()): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
}

/** Fetch an object as a Node Readable stream. */
export async function getObjectStream(bucket: string, key: string): Promise<Readable> {
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return res.Body as Readable;
}

/** Fetch an object's full contents as a string. */
export async function getObjectText(bucket: string, key: string): Promise<string> {
  const stream = await getObjectStream(bucket, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
