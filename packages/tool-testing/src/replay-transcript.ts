import fs from 'node:fs';
import path from 'node:path';

/**
 * A transcript a tool wrote, recorded, with `{{cwd}}` and `{{sessionId}}` where it named its workspace and session,
 * and where the tool keeps such a file in its store.
 */
export interface RecordedTranscript {
  readonly text: string;
  /** The file the tool writes the session `sessionId` of workspace `cwd` to, in its store `store`. */
  place(store: string, cwd: string, sessionId: string): string;
  /** A user message the transcript holds, which reading it must return. */
  readonly userText: string;
}

/** Write `transcript` into `store` as the tool would for session `sessionId` in workspace `cwd`; returns the file. */
export function replayTranscript(transcript: RecordedTranscript, { store, cwd, sessionId }: { store: string; cwd: string; sessionId: string }): string {
  const file = transcript.place(store, cwd, sessionId);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, transcript.text.replaceAll('{{cwd}}', cwd).replaceAll('{{sessionId}}', sessionId));

  return file;
}
