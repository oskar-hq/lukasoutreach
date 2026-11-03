import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_MAX_PER_CATEGORY,
  templateCategory,
  type MessageKind,
  type MessageTemplate,
  type TemplateAudience,
  type TemplateCategory,
  type TemplateSegment,
} from '../../../shared/messages.js';
import type { Database } from '../db/database.js';
import { DEFAULT_TEMPLATES } from './defaults.js';

interface TemplateRow {
  id: string;
  name: string;
  text: string;
  updated_at: number;
  updated_by: string | null;
  /** Nur bei eigenen Vorlagen gesetzt. */
  kind: MessageKind | null;
  stage: number | null;
  audience: TemplateAudience | null;
  /** Segment eigener Vorlagen (Migration 43), NULL = für alle. */
  segment: TemplateSegment | null;
  created_at: number | null;
  deleted_at: number | null;
}

export class TemplateNotFoundError extends Error {
  constructor() {
    super('Vorlage nicht gefunden.');
  }
}

/** 409: schon 26 Vorlagen in der Kategorie bzw. die letzte einer Kategorie soll weg. */
export class TemplateRuleError extends Error {
  constructor(
    readonly code: 'template_limit' | 'last_template',
    message: string,
  ) {
    super(message);
  }
}

/** Kürzel der IDs eigener Vorlagen je Kategorie: „G.1“, „F2.3“ … (wie G1/F2A bei den Standardtexten). */
const ID_PREFIX: Record<TemplateCategory, string> = {
  invite: 'N',
  first_greenfield: 'G',
  first_reactivation: 'R',
  first_active: 'S',
  first_hiring: 'H',
  followup_1: 'F1',
  followup_2: 'F2',
  followup_3: 'F3',
};

/**
 * Standardtexte aus dem Code, darüber die in der Software angepassten Texte und eigene Vorlagen (Tabelle
 * `message_templates`). Reihenfolge je Kategorie: erst die Standardtexte, dann eigene nach Anlagedatum – daraus
 * ergeben sich die Buchstaben A bis Z in der Oberfläche.
 */
export class TemplateStore {
  constructor(private readonly db: Database) {}

  private rows(): TemplateRow[] {
    return this.db.prepare('SELECT * FROM message_templates').all() as unknown as TemplateRow[];
  }

  list(): MessageTemplate[] {
    const rows = this.rows();
    const overrides = new Map(rows.filter((row) => !row.kind).map((row) => [row.id, row]));
    const defaults = DEFAULT_TEMPLATES.flatMap((template): MessageTemplate[] => {
      const row = overrides.get(template.id);
      if (row?.deleted_at) return [];
      return [
        row
          ? { ...template, name: row.name, text: row.text, isDefault: false, updatedAt: row.updated_at, updatedBy: row.updated_by }
          : { ...template, isDefault: true, updatedAt: null, updatedBy: null },
      ];
    });
    const custom = rows
      .filter((row) => row.kind && !row.deleted_at)
      .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0) || a.id.localeCompare(b.id))
      .map(
        (row): MessageTemplate => ({
          id: row.id,
          kind: row.kind!,
          stage: row.stage,
          audience: row.audience ?? 'any',
          segment: row.segment ?? null,
          name: row.name,
          description: '',
          text: row.text,
          isDefault: false,
          custom: true,
          updatedAt: row.updated_at,
          updatedBy: row.updated_by,
        }),
      );
    // Eigene Vorlagen stehen direkt hinter den übrigen ihrer Kategorie (die Reihenfolge der Standardtexte bleibt).
    const all = [...defaults];
    for (const template of custom) {
      const category = templateCategory(template);
      const last = all.findLastIndex((entry) => templateCategory(entry) === category);
      if (last < 0) all.push(template);
      else all.splice(last + 1, 0, template);
    }
    return all;
  }

  get(id: string): MessageTemplate | null {
    return this.list().find((template) => template.id === id) ?? null;
  }

  /** `segment` wirkt nur bei eigenen Vorlagen (Standardtexte haben ein festes Segment); fehlt = bleibt. */
  update(id: string, patch: { name?: string; text: string; segment?: TemplateSegment | null }, by: string | null, now = Date.now()): MessageTemplate {
    const current = this.get(id);
    if (!current) throw new TemplateNotFoundError();
    if (current.custom) {
      this.db
        .prepare('UPDATE message_templates SET name = ?, text = ?, segment = ?, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(patch.name ?? current.name, patch.text, patch.segment === undefined ? (current.segment ?? null) : patch.segment, now, by, id);
    } else {
      this.db
        .prepare(
          `INSERT INTO message_templates (id, name, text, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, text = excluded.text, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .run(id, patch.name ?? current.name, patch.text, now, by);
    }
    return this.get(id)!;
  }

  /** Standardtext wiederherstellen – holt auch einen gelöschten Standardtext zurück. */
  reset(id: string): MessageTemplate {
    if (DEFAULT_TEMPLATES.some((template) => template.id === id)) {
      this.db.prepare('DELETE FROM message_templates WHERE id = ?').run(id);
      return this.get(id)!;
    }
    const current = this.get(id);
    if (!current) throw new TemplateNotFoundError();
    // Eigene Vorlagen haben keinen Standardtext – unverändert zurück.
    return current;
  }

  /** Neue Vorlage am Ende der Kategorie. */
  create(category: TemplateCategory, patch: { name?: string; text: string; segment?: TemplateSegment | null }, by: string | null, now = Date.now()): MessageTemplate {
    const info = TEMPLATE_CATEGORIES.find((entry) => entry.id === category)!;
    const count = this.list().filter((template) => templateCategory(template) === category).length;
    if (count >= TEMPLATE_MAX_PER_CATEGORY) {
      throw new TemplateRuleError('template_limit', `In „${info.label}“ gibt es schon ${TEMPLATE_MAX_PER_CATEGORY} Vorlagen (A bis Z).`);
    }
    // Fortlaufende Nummer je Kürzel – auch gelöschte zählen, damit keine ID zweimal vergeben wird.
    const prefix = ID_PREFIX[category];
    const used = this.rows()
      .map((row) => row.id)
      .filter((id) => id.startsWith(`${prefix}.`))
      .map((id) => Number(id.slice(prefix.length + 1)))
      .filter(Number.isInteger);
    const id = `${prefix}.${Math.max(0, ...used) + 1}`;
    this.db
      .prepare(
        `INSERT INTO message_templates (id, name, text, updated_at, updated_by, kind, stage, audience, segment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, patch.name?.trim() || 'Neue Vorlage', patch.text, now, by, info.kind, info.stage, info.audience, patch.segment ?? null, now);
    return this.get(id)!;
  }

  /** Vorlage ausblenden – die letzte einer Kategorie bleibt. */
  remove(id: string, by: string | null, now = Date.now()): void {
    const current = this.get(id);
    if (!current) throw new TemplateNotFoundError();
    const category = templateCategory(current);
    const siblings = this.list().filter((template) => templateCategory(template) === category);
    if (category && siblings.length <= 1) {
      throw new TemplateRuleError('last_template', 'Die letzte Vorlage einer Kategorie bleibt – ändere stattdessen ihren Text.');
    }
    if (current.custom) {
      this.db.prepare('UPDATE message_templates SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(now, now, by, id);
    } else {
      this.db
        .prepare(
          `INSERT INTO message_templates (id, name, text, updated_at, updated_by, deleted_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .run(id, current.name, current.text, now, by, now);
    }
  }
}
