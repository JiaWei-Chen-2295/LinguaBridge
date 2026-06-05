import type { SessionSnapshot, SubtitleSegment } from "./models";

export type ExportFormat = "markdown" | "srt" | "json";

export interface RenderedExport {
  body: string;
  contentType: string;
  filename: string;
}

export function normalizeExportFormat(value: string | undefined): ExportFormat {
  if (value === "srt" || value === "json" || value === "markdown") {
    return value;
  }

  return "markdown";
}

export function renderSessionExport(
  snapshot: SessionSnapshot,
  format: ExportFormat
): RenderedExport {
  if (format === "srt") {
    return {
      body: renderSrt(snapshot.segments),
      contentType: "text/plain; charset=utf-8",
      filename: `${snapshot.session.id}.srt`
    };
  }

  if (format === "json") {
    return {
      body: renderJson(snapshot),
      contentType: "application/json; charset=utf-8",
      filename: `${snapshot.session.id}.json`
    };
  }

  return {
    body: renderMarkdown(snapshot),
    contentType: "text/markdown; charset=utf-8",
    filename: `${snapshot.session.id}.md`
  };
}

export function renderMarkdown(snapshot: SessionSnapshot): string {
  const header = [
    `# LinguaBridge Transcript`,
    ``,
    `- Session: ${snapshot.session.id}`,
    `- Source: ${snapshot.session.sourceLang}`,
    `- Target: ${snapshot.session.targetLang}`,
    `- Started: ${snapshot.session.startedAt.toISOString()}`,
    `- Status: ${snapshot.session.status}`,
    ``,
    `| Time | Status | Source | Translation |`,
    `| --- | --- | --- | --- |`
  ];

  const rows = snapshot.segments.map((segment) => {
    const time = `${formatClock(segment.startAtMs)}-${formatClock(
      segment.endAtMs
    )}`;
    return `| ${time} | ${segment.status} | ${escapeMarkdownTable(
      segment.sourceText
    )} | ${escapeMarkdownTable(segment.targetText)} |`;
  });

  const revisionRows = snapshot.revisions.map((revision) => {
    return `- ${revision.segmentId} r${revision.revision} (${revision.status}): ${revision.reason}`;
  });

  if (revisionRows.length === 0) {
    return [...header, ...rows, ""].join("\n");
  }

  return [
    ...header,
    ...rows,
    "",
    "## Revisions",
    "",
    ...revisionRows,
    ""
  ].join("\n");
}

export function renderSrt(segments: SubtitleSegment[]): string {
  return segments
    .filter((segment) => segment.status !== "draft")
    .map((segment, index) => {
      const timing = `${formatSrtTime(segment.startAtMs)} --> ${formatSrtTime(
        segment.endAtMs
      )}`;
      return [
        String(index + 1),
        timing,
        segment.targetText,
        segment.sourceText
      ].join("\n");
    })
    .join("\n\n");
}

export function renderJson(snapshot: SessionSnapshot): string {
  return JSON.stringify(
    {
      session: serializeSession(snapshot.session),
      segments: snapshot.segments.map((segment) => ({
        ...segment,
        updatedAt: segment.updatedAt.toISOString()
      })),
      revisions: snapshot.revisions.map((revision) => ({
        ...revision,
        createdAt: revision.createdAt.toISOString()
      })),
      usageEvents: snapshot.usageEvents.map((event) => ({
        ...event,
        createdAt: event.createdAt.toISOString()
      }))
    },
    null,
    2
  );
}

function serializeSession(snapshot: SessionSnapshot["session"]): object {
  return {
    ...snapshot,
    startedAt: snapshot.startedAt.toISOString(),
    endedAt: snapshot.endedAt?.toISOString()
  };
}

function formatClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0"
  )}`;
}

function formatSrtTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(
    3,
    "0"
  )}`;
}

function escapeMarkdownTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
