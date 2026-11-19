import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  FEEDBACK_ANSWER_MAX,
  FEEDBACK_IMAGE_MAX_BYTES,
  FEEDBACK_IMAGES_MAX,
  FEEDBACK_TEXT_MAX,
  type FeedbackContext,
  type FeedbackCreateRequest,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackStatus,
  type FeedbackUpdateRequest,
} from '../../../shared/feedback.js';
import type { Database } from '../db/database.js';

/**
 * Feedback vom Kunden (Vertrag `shared/feedback.ts`, Migration 53). Bilder liegen als Dateien unter
 * `DATA_DIR/feedback/<id>/<n>.<jpg|png>` – nicht in der Datenbank, damit Sicherungen klein bleiben.
 */

interface Row {
  id: string;
  number: number;
  created_at: number;
  updated_at: number;
  username: string;
  by_name: string;
  founder: string | null;
  kind: FeedbackKind;
  text: string;
  status: FeedbackStatus;
  answer: string | null;
  image_count: number;
  context: string | null;
}

export class FeedbackError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const IMAGE = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/;

function toItem(row: Row): FeedbackItem {
  let context: FeedbackContext | null = null;
  try {
    context = row.context ? (JSON.parse(row.context) as FeedbackContext) : null;
  } catch {
    context = null;
  }
  return {
    id: row.id,
    number: row.number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    by: row.by_name,
    username: row.username,
    kind: row.kind,
    text: row.text,
    status: row.status,
    answer: row.answer,
    imageCount: row.image_count,
    context,
  };
}

/** Zusammenhang kürzen – nie mehr als nötig speichern. */
function cleanContext(context: FeedbackContext | undefined): FeedbackContext | null {
  if (!context) return null;
  const short = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : null);
  return {
    view: short(context.view, 40),
    leadId: short(context.leadId, 64),
    path: short(context.path, 300),
    trail: Array.isArray(context.trail) ? context.trail.slice(-40).map((line) => String(line).slice(0, 200)) : [],
    errors: Array.isArray(context.errors) ? context.errors.slice(-20).map((line) => String(line).slice(0, 300)) : [],
    version: short(context.version, 60),
    device: context.device
      ? {
          width: Number(context.device.width) || 0,
          height: Number(context.device.height) || 0,
          standalone: !!context.device.standalone,
          touch: !!context.device.touch,
          userAgent: String(context.device.userAgent ?? '').slice(0, 300),
        }
      : null,
  };
}

export class FeedbackStore {
  constructor(
    private readonly db: Database,
    private readonly dataDir: string,
  ) {}

  private dir(id: string): string {
    return path.join(this.dataDir, 'feedback', id);
  }

  create(input: FeedbackCreateRequest, author: { username: string; name: string; founder: string | null }, now: number): FeedbackItem {
    const text = (input.text ?? '').trim();
    if (!text) throw new FeedbackError(400, 'Schreib kurz, was passiert ist oder was du dir wünschst.');
    if (text.length > FEEDBACK_TEXT_MAX) throw new FeedbackError(400, `Höchstens ${FEEDBACK_TEXT_MAX} Zeichen.`);
    const images = (input.images ?? []).slice(0, FEEDBACK_IMAGES_MAX);
    const decoded: Array<{ ext: string; data: Buffer }> = [];
    for (const image of images) {
      const match = typeof image === 'string' ? image.match(IMAGE) : null;
      if (!match) continue;
      const data = Buffer.from(match[2], 'base64');
      if (data.length === 0 || data.length > FEEDBACK_IMAGE_MAX_BYTES) continue;
      decoded.push({ ext: match[1] === 'png' ? 'png' : match[1] === 'webp' ? 'webp' : 'jpg', data });
    }
    const context = cleanContext(input.context);
    // Version des Servers, falls die Oberfläche sie nicht kennt (Build-Argument APP_COMMIT).
    if (context && !context.version) context.version = process.env.APP_COMMIT?.trim().slice(0, 12) || null;
    const kind: FeedbackKind = input.kind ?? (context?.errors?.length ? 'bug' : 'wish');
    const id = randomUUID();
    const number = ((this.db.prepare('SELECT MAX(number) AS n FROM feedback').get() as { n: number | null }).n ?? 0) + 1;
    if (decoded.length) {
      mkdirSync(this.dir(id), { recursive: true });
      decoded.forEach((image, index) => writeFileSync(path.join(this.dir(id), `${index + 1}.${image.ext}`), image.data));
    }
    this.db
      .prepare(
        `INSERT INTO feedback (id, number, created_at, updated_at, username, by_name, founder, kind, text, status, answer, image_count, context)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', NULL, ?, ?)`,
      )
      .run(id, number, now, now, author.username, author.name, author.founder, kind, text, decoded.length, context ? JSON.stringify(context) : null);
    return this.get(id)!;
  }

  get(id: string): FeedbackItem | null {
    const row = this.db.prepare('SELECT * FROM feedback WHERE id = ? OR CAST(number AS TEXT) = ?').get(id, id.replace(/^#/, '')) as Row | undefined;
    return row ? toItem(row) : null;
  }

  list(options: { status?: FeedbackStatus | 'open' | null; username?: string | null; limit?: number }): FeedbackItem[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.status === 'open') where.push("status IN ('new', 'planned', 'in_progress')");
    else if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.username) {
      where.push('username = ?');
      params.push(options.username);
    }
    const rows = this.db
      .prepare(`SELECT * FROM feedback ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, options.limit ?? 100) as unknown as Row[];
    return rows.map(toItem);
  }

  update(id: string, change: FeedbackUpdateRequest, now: number): { before: FeedbackItem; after: FeedbackItem } {
    const before = this.get(id);
    if (!before) throw new FeedbackError(404, 'Meldung nicht gefunden.');
    const answer = change.answer === undefined ? before.answer : change.answer?.trim() ? change.answer.trim().slice(0, FEEDBACK_ANSWER_MAX) : null;
    const status = change.status ?? before.status;
    this.db.prepare('UPDATE feedback SET status = ?, answer = ?, updated_at = ? WHERE id = ?').run(status, answer, now, before.id);
    return { before, after: this.get(before.id)! };
  }

  /** Bild n (1-basiert) als Datei: Inhalt und Typ. */
  image(id: string, n: number): { data: Buffer; type: string } | null {
    const item = this.get(id);
    if (!item || n < 1 || n > item.imageCount) return null;
    try {
      const file = readdirSync(this.dir(item.id)).find((name) => name.startsWith(`${n}.`));
      if (!file) return null;
      const ext = file.split('.').pop();
      return { data: readFileSync(path.join(this.dir(item.id), file)), type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' };
    } catch {
      return null;
    }
  }

  /** Founder der Meldung (für Meldungen an den Melder). */
  founderOf(id: string): string | null {
    const row = this.db.prepare('SELECT founder FROM feedback WHERE id = ?').get(id) as { founder: string | null } | undefined;
    return row?.founder ?? null;
  }

  /** Nur Tests/Reset der Simulation. */
  reset(): void {
    this.db.exec('DELETE FROM feedback;');
    rmSync(path.join(this.dataDir, 'feedback'), { recursive: true, force: true });
  }
}
