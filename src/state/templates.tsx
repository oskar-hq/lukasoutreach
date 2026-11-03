import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { templateCategory, templateLetter, type MessageTemplate, type TemplateAudience, type TemplateSegment } from '../../shared/messages';
import { ApiError, templatesApi } from '../lib/leadSearchApi';
import { readableError } from '../lib/leadView';

type TemplatesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; templates: MessageTemplate[] };

interface TemplatesContextValue {
  state: TemplatesState;
  reload: () => void;
  /** Erneut laden läuft (der alte Stand bleibt sichtbar). */
  reloading: boolean;
  /** Antwort von PUT/Reset übernehmen – die Karten sehen den neuen Text sofort. */
  replace: (template: MessageTemplate) => void;
  /** Neue Vorlage (POST) hinter die übrigen ihrer Kategorie setzen. */
  add: (template: MessageTemplate) => void;
  /** Gelöschte Vorlage entfernen. */
  drop: (id: string) => void;
  byId: (id: string | null | undefined) => MessageTemplate | null;
  /**
   * Erstnachrichten für eine Zielgruppe (G1/G2 bzw. R1/R2), in der Reihenfolge des Servers. Seit 02.11. (Wunsch des
   * Nutzers: „meine geänderten Vorlagen erscheinen nicht“) blendet das Segment nichts mehr aus – auch bei
   * Finanzdienstleistern stehen die Standardtexte vorn, die FDL-Vorlagen sind zusätzlich wählbar.
   */
  firstFor: (audience: Exclude<TemplateAudience, 'any'>, segment?: TemplateSegment) => MessageTemplate[];
  /** Follow-up-Varianten einer Stufe (1–3; höhere Stufen nehmen die von Stufe 3); Segment wie bei `firstFor` ohne Filter. */
  followupsFor: (stage: number, segment?: TemplateSegment) => MessageTemplate[];
}

const TemplatesContext = createContext<TemplatesContextValue | null>(null);

/** Vorlagen aus `GET /api/templates` – einmal je Sitzung geladen, für Karten, Vorlagen-Seite und Dashboard. */
export function TemplatesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TemplatesState>({ status: 'loading' });
  const [reloading, setReloading] = useState(false);
  const requestId = useRef(0);

  const reload = useCallback(() => {
    const id = ++requestId.current;
    // Nur beim allerersten Laden „loading“ – sonst blieben offene Karten nicht stehen (Entwürfe gingen verloren).
    setReloading(true);
    templatesApi
      .list()
      .finally(() => {
        if (id === requestId.current) setReloading(false);
      })
      .then(({ templates }) => {
        if (id === requestId.current) setState({ status: 'ready', templates });
      })
      .catch((error: unknown) => {
        if (id !== requestId.current) return;
        const message = error instanceof ApiError ? readableError(error, 'Die Vorlagen konnten nicht geladen werden.') : 'Die Vorlagen konnten nicht geladen werden.';
        // Ein späterer Fehler beim Nachladen lässt die bekannten Vorlagen stehen.
        setState((current) => (current.status === 'ready' ? current : { status: 'error', message }));
      });
  }, []);

  useEffect(() => reload(), [reload]);

  const replace = useCallback((template: MessageTemplate) => {
    setState((current) =>
      current.status === 'ready'
        ? { status: 'ready', templates: current.templates.map((entry) => (entry.id === template.id ? template : entry)) }
        : current,
    );
  }, []);

  const add = useCallback((template: MessageTemplate) => {
    setState((current) => {
      if (current.status !== 'ready' || current.templates.some((entry) => entry.id === template.id)) return current;
      const category = templateCategory(template);
      let last = -1;
      current.templates.forEach((entry, index) => {
        if (templateCategory(entry) === category) last = index;
      });
      const templates = [...current.templates];
      templates.splice(last < 0 ? templates.length : last + 1, 0, template);
      return { status: 'ready', templates };
    });
  }, []);

  const drop = useCallback((id: string) => {
    setState((current) => (current.status === 'ready' ? { status: 'ready', templates: current.templates.filter((entry) => entry.id !== id) } : current));
  }, []);

  const value = useMemo<TemplatesContextValue>(() => {
    const templates = state.status === 'ready' ? state.templates : [];
    return {
      state,
      reloading,
      reload,
      replace,
      add,
      drop,
      byId: (id) => (id ? (templates.find((template) => template.id === id) ?? null) : null),
      firstFor: (audience) => templates.filter((template) => template.kind === 'first' && template.audience === audience),
      followupsFor: (stage) => {
        const clamped = Math.min(Math.max(stage, 1), 3);
        return templates.filter((template) => template.kind === 'followup' && template.stage === clamped);
      },
    };
  }, [state, reloading, reload, replace, add, drop]);

  return <TemplatesContext.Provider value={value}>{children}</TemplatesContext.Provider>;
}

export function useTemplates(): TemplatesContextValue {
  const value = useContext(TemplatesContext);
  if (!value) throw new Error('useTemplates braucht den TemplatesProvider.');
  return value;
}

/** Kurzname ohne Gruppe: „Greenfield · Kanal noch offen“ → „Kanal noch offen“. */
export function shortTemplateName(template: MessageTemplate): string {
  const index = template.name.indexOf(' · ');
  return index >= 0 ? template.name.slice(index + 3) : template.name;
}

/** Buchstabe einer Vorlage in ihrer Kategorie (A bis Z, wie auf den Karten) – null, wenn unbekannt. */
export function letterOf(templates: readonly MessageTemplate[], id: string | null | undefined): string | null {
  const template = id ? templates.find((entry) => entry.id === id) : undefined;
  if (!template) return null;
  const category = templateCategory(template);
  return templateLetter(templates.filter((entry) => templateCategory(entry) === category).indexOf(template));
}
