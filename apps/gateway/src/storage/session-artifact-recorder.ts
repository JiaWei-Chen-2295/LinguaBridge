import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderSessionExport } from "../domain/exports";
import type { SessionSnapshot } from "../domain/models";
import type { ObjectStorage, PutObjectResult } from "./object-storage";

export interface StartSessionArtifactsInput {
  userId: string;
  sessionId: string;
}

export interface AppendAudioFrameInput {
  sessionId: string;
  pcmBase64: string;
  durationMs: number;
}

export interface AppendedAudioFrame {
  sizeBytes: number;
  durationMs: number;
}

export interface FinalizedSessionArtifacts {
  audioObject?: {
    objectKey: string;
    format: string;
    durationMs: number;
    sizeBytes: number;
  };
  uploadedObjectKeys: string[];
}

interface ActiveSessionArtifacts {
  userId: string;
  sessionId: string;
  prefix: string;
  tempDir: string;
  audioFilePath: string;
  audioSizeBytes: number;
  audioDurationMs: number;
  writeQueue: Promise<void>;
}

export class SessionArtifactRecorder {
  private readonly sessions = new Map<string, ActiveSessionArtifacts>();

  public constructor(private readonly objectStorage: ObjectStorage) {}

  public async startSession(input: StartSessionArtifactsInput): Promise<void> {
    if (this.sessions.has(input.sessionId)) {
      return;
    }

    const tempDir = await mkdtemp(
      path.join(tmpdir(), `lingua-bridge-${input.sessionId}-`)
    );
    const prefix = this.objectStorage.makeSessionPrefix(
      input.userId,
      input.sessionId
    );

    this.sessions.set(input.sessionId, {
      userId: input.userId,
      sessionId: input.sessionId,
      prefix,
      tempDir,
      audioFilePath: path.join(tempDir, "audio.pcm"),
      audioSizeBytes: 0,
      audioDurationMs: 0,
      writeQueue: Promise.resolve()
    });
  }

  public async appendAudioFrame(
    input: AppendAudioFrameInput
  ): Promise<AppendedAudioFrame | undefined> {
    const artifacts = this.sessions.get(input.sessionId);
    if (artifacts === undefined) {
      return undefined;
    }

    const frame = Buffer.from(input.pcmBase64, "base64");
    artifacts.audioSizeBytes += frame.byteLength;
    artifacts.audioDurationMs += input.durationMs;
    artifacts.writeQueue = artifacts.writeQueue.then(() =>
      appendFile(artifacts.audioFilePath, frame)
    );
    await artifacts.writeQueue;

    return {
      sizeBytes: frame.byteLength,
      durationMs: input.durationMs
    };
  }

  public async persistTranscriptSnapshot(
    snapshot: SessionSnapshot
  ): Promise<PutObjectResult | undefined> {
    return this.objectStorage.putObject({
      key: `${this.makePrefix(snapshot)}segments.json`,
      body: renderSegmentsSnapshot(snapshot),
      contentType: "application/json; charset=utf-8",
      metadata: {
        sessionId: snapshot.session.id,
        userId: snapshot.session.userId
      }
    });
  }

  public async persistSessionDocuments(
    snapshot: SessionSnapshot
  ): Promise<string[]> {
    const uploadedObjectKeys: string[] = [];
    const snapshotUpload = await this.persistTranscriptSnapshot(snapshot);
    if (snapshotUpload !== undefined) {
      uploadedObjectKeys.push(snapshotUpload.key);
    }

    for (const format of ["markdown", "srt", "json"] as const) {
      const rendered = renderSessionExport(snapshot, format);
      const upload = await this.objectStorage.putObject({
        key: `${this.makePrefix(snapshot)}exports/${exportFileName(format)}`,
        body: rendered.body,
        contentType: rendered.contentType,
        metadata: {
          sessionId: snapshot.session.id,
          userId: snapshot.session.userId,
          exportFormat: format
        }
      });
      uploadedObjectKeys.push(upload.key);
    }

    return uploadedObjectKeys;
  }

  public async finalizeSession(
    snapshot: SessionSnapshot
  ): Promise<FinalizedSessionArtifacts> {
    const artifacts = this.sessions.get(snapshot.session.id);
    if (artifacts === undefined) {
      return { uploadedObjectKeys: [] };
    }

    await artifacts.writeQueue;
    const uploadedObjectKeys: string[] = [];
    let audioObject: FinalizedSessionArtifacts["audioObject"];

    if (artifacts.audioSizeBytes > 0) {
      const audioUpload = await this.objectStorage.putFile({
        key: `${artifacts.prefix}audio.pcm`,
        filePath: artifacts.audioFilePath,
        contentType: "audio/L16",
        metadata: {
          sessionId: snapshot.session.id,
          userId: snapshot.session.userId,
          sampleRate: "16000",
          channels: "1"
        }
      });
      uploadedObjectKeys.push(audioUpload.key);
      audioObject = {
        objectKey: audioUpload.key,
        format: "pcm_s16le;rate=16000;channels=1",
        durationMs: artifacts.audioDurationMs,
        sizeBytes: audioUpload.sizeBytes
      };
    }

    await this.deleteLocalTemp(snapshot.session.id);
    this.sessions.delete(snapshot.session.id);

    if (audioObject !== undefined) {
      return {
        audioObject,
        uploadedObjectKeys
      };
    }

    return { uploadedObjectKeys };
  }

  public async deleteLocalTemp(sessionId: string): Promise<void> {
    const artifacts = this.sessions.get(sessionId);
    if (artifacts === undefined) {
      return;
    }

    await artifacts.writeQueue.catch(() => undefined);
    await rm(artifacts.tempDir, { recursive: true, force: true });
  }

  private makePrefix(snapshot: SessionSnapshot): string {
    return (
      this.sessions.get(snapshot.session.id)?.prefix ??
      this.objectStorage.makeSessionPrefix(
        snapshot.session.userId,
        snapshot.session.id
      )
    );
  }
}

function renderSegmentsSnapshot(snapshot: SessionSnapshot): string {
  return JSON.stringify(
    {
      session: {
        ...snapshot.session,
        startedAt: snapshot.session.startedAt.toISOString(),
        endedAt: snapshot.session.endedAt?.toISOString()
      },
      segments: snapshot.segments.map((segment) => ({
        ...segment,
        updatedAt: segment.updatedAt.toISOString()
      })),
      revisions: snapshot.revisions.map((revision) => ({
        ...revision,
        createdAt: revision.createdAt.toISOString()
      }))
    },
    null,
    2
  );
}

function exportFileName(format: "markdown" | "srt" | "json"): string {
  if (format === "markdown") {
    return "transcript.md";
  }

  if (format === "srt") {
    return "subtitle.srt";
  }

  return "session.json";
}
