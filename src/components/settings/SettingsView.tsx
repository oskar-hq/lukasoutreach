import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  SETTING_GROUP_LABELS,
  SETTING_GROUPS,
  SETTING_KEYS,
  SETTINGS,
  settingDefinition,
  type SettingDefinition,
  type SettingGroup,
  type SettingKey,
  type SettingState,
  type SettingsHistoryEntry,
  type SettingsResponse,
  type SettingsTestService,
  type SettingsUpdateRequest,
  type SettingValue,
} from '../../../shared/settings';
import { cn } from '../../lib/cn';
import { ApiError, settingsApi } from '../../lib/leadSearchApi';
import { useHotkeys } from '../../lib/useHotkeys';
import { useAccess, useAuth } from '../../state/auth';
import { FOUNDER_IDS } from '../../data/founders';
import { useLeadSearch } from '../leadSearch/LeadSearchProvider';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { StatusLine } from '../ui/Status';
import { LinkedInSetup, SearchAccountPicker } from './LinkedInSetup';
import { MetaRecheck } from './MetaRecheck';
import { UnsentInvites } from './UnsentInvites';
import type { NavBadge } from './SettingsPage';
import { SettingsOverview } from './SettingsOverview';
import { SHORT_LABELS, subpageOf, subpagesOf, UPDATE_PAGE, type QuickToggle, type SettingsSection, type SettingsSubpage } from './settingsNav';
import { QuickSwitch } from './QuickSwitch';
import { MenuList, MenuRow, type RowBadge } from './MenuRow';
import { formatValue, SettingField, validateDraft, type DraftValue } from './SettingField';
import { EASE_OUT } from '../../lib/motion';
import { ROW_GAP } from './look';

type Draft = Partial<Record<SettingKey, DraftValue>>;

/** Gruppen mit Verbindungstest (Treg/Close/Slack mit eigenem Namen, weil sie sich eine Gruppe teilen). */
const TESTS: Partial<Record<SettingGroup, { service: SettingsTestService; label?: string }[]>> = {
  unipile: [{ service: 'unipile' }],
  anthropic: [{ service: 'anthropic' }],
  meta: [{ service: 'meta' }],
  clay: [{ service: 'treg', label: 'Treg testen' }],
  crm: [
    { service: 'close', label: 'Close testen' },
    { service: 'slack', label: 'Slack-Testnachricht' },
  ],
};

const ACTION_LABEL: Record<SettingsHistoryEntry['action'], string> = {
  set: 'geändert',
  reset: 'zurückgesetzt (.env oder Standard)',
  trial: 'auf Probe geändert',
  confirmed: 'Probe behalten',
  reverted: 'Probe zurückgesetzt',
};

const timeFormat = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function changedEntries(draft: Draft): [SettingKey, Exclude<DraftValue, undefined>][] {
  return SETTING_KEYS.flatMap((key) => (draft[key] === undefined ? [] : [[key, draft[key] as Exclude<DraftValue, undefined>]]));
}

/** Gespeicherter Stand eines Felds – ändert er sich, wird das Feld neu aufgebaut (z. B. schließt das Schlüssel-Feld). */
function savedSignature(state: SettingState): string {
  return JSON.stringify([state.source, state.value, state.secret, state.stored]);
}

/** Erstes Bedienelement zum Fokussieren: Eingabe vor Auswahl vor Knopf (die Stepper-Knöpfe „−/+“ stehen vor dem Feld). */
function firstControl(container: Element): HTMLElement | null {
  return (
    container.querySelector<HTMLElement>('input:not([disabled])') ??
    container.querySelector<HTMLElement>('[role=radio][tabindex="0"]') ??
    container.querySelector<HTMLElement>('button:not([tabindex="-1"])')
  );
}

/** Kommagetrennte Account-IDs (`UNIPILE_WARMUP_ACCOUNTS`) als Liste. */
function splitIds(value: string | undefined): string[] {
  return (value ?? '').split(',').map((id) => id.trim()).filter(Boolean);
}

/** Wirksamer Text-Wert oder undefined (leer/nicht gesetzt). */
function savedText(state: SettingState | undefined): string | undefined {
  return typeof state?.value === 'string' && state.value ? state.value : undefined;
}

/** Konten-Felder, die im LinkedIn-Bereich unter „IDs von Hand eintragen“ liegen. */
const ACCOUNT_KEYS: readonly SettingKey[] = ['UNIPILE_ACCOUNT_NICK', 'UNIPILE_ACCOUNT_JOHANNES', 'UNIPILE_WARMUP_ACCOUNTS', 'UNIPILE_ACCOUNTS_USED'];

/**
 * Kennzeichen der Seitenleiste – nur was abweicht: Fehler, Entwurf, Problem am Wert, laufende Probe, fehlender
 * Zugang im echten Betrieb, ausgeschaltete Sicherung.
 */
function navBadges(data: SettingsResponse, draft: Draft, errors: Partial<Record<SettingKey, string>>, live: boolean): Partial<Record<SettingsSection, NavBadge>> {
  const states = new Map(data.settings.map((state) => [state.key, state]));
  const set = (key: SettingKey) => states.get(key)?.secret?.set === true;
  const filled = (key: SettingKey) => typeof states.get(key)?.value === 'string' && states.get(key)?.value !== '';
  const badges: Partial<Record<SettingsSection, NavBadge>> = {};
  for (const group of SETTING_GROUPS) {
    const keys = SETTINGS.filter((definition) => definition.group === group).map((definition) => definition.key);
    if (keys.some((key) => errors[key])) badges[group] = { text: 'Prüfen', tone: 'bad' };
    else if (keys.some((key) => draft[key] !== undefined)) badges[group] = { text: 'geändert', tone: 'accent' };
    else if (keys.some((key) => data.trial?.keys.includes(key))) badges[group] = { text: 'auf Probe', tone: 'warn' };
    // Im Notfallmodus gespeicherte (ignorierte) Werte gehören auch geprüft.
    else if (keys.some((key) => states.get(key)?.problem || (data.safeMode && states.get(key)?.stored))) badges[group] = { text: 'Prüfen', tone: 'warn' };
  }
  const missing = (group: SettingGroup, ok: boolean) => {
    if (live && !ok && !badges[group]) badges[group] = { text: 'Fehlt', tone: 'warn' };
  };
  missing('unipile', filled('UNIPILE_DSN') && set('UNIPILE_API_KEY'));
  missing('anthropic', set('ANTHROPIC_API_KEY'));
  missing('meta', set('META_ACCESS_TOKEN'));
  if (states.get('BACKUP_HOUR_UTC')?.value === 'off' && !badges.backup) badges.backup = { text: 'Aus', tone: 'warn' };
  return badges;
}

/** Verlauf: `null` heißt „kein Wert in der Software“ (dann gilt .env oder Standard), `''` „leer“. */
function historyValue(key: SettingKey, value: SettingValue | null | undefined): string {
  if (value === null || value === undefined) return '.env/Standard';
  if (value === '') return 'leer';
  return formatValue(settingDefinition(key), value);
}

/**
 * Werte der .env in der Software ändern (Vertrag `shared/settings.ts`). Zeigt genau einen Bereich der Untermenüs
 * („Auf einen Blick“, eine Gruppe oder den Verlauf); `null` = gerade ein anderer Bereich – dann bleiben nur Entwürfe
 * und die Leiste unten. Kennzeichen für die Seitenleiste meldet `onBadges`.
 */
export function SettingsView({
  section,
  page,
  notices = false,
  onNavigate,
  onBadges,
  onSaved,
  quick,
}: {
  section: 'overview' | SettingGroup | 'history' | null;
  /** Offene Unterseite (`<group>.<name>`) oder `null` = Liste des Bereichs. */
  page: string | null;
  /** Auf den Menüs (kein Bereich offen): Notfallmodus und Probe trotzdem zeigen. */
  notices?: boolean;
  /** In einen Bereich und optional auf eine Unterseite wechseln. */
  onNavigate: (section: SettingsSection, page?: string | null) => void;
  onBadges: (badges: Partial<Record<SettingsSection, NavBadge>>) => void;
  /** Nach erfolgreichem Speichern – die Seite blendet „Gespeichert“ neben dem Titel ein. */
  onSaved?: () => void;
  /** Einfache Seite: statt der Unterseiten nur diese Schalter, die sofort speichern. */
  quick?: readonly QuickToggle[];
}) {
  const active = section !== null;
  const { auth } = useAuth();
  const access = useAccess();
  const { config } = useLeadSearch();
  // Ohne geladene Konfiguration gilt der echte Betrieb (die Software läuft immer echt; nur Tests simulieren).
  const live = config.status === 'ready' ? config.config.mode === 'live' : true;
  const username = auth.status === 'authenticated' ? auth.user.username : null;
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Partial<Record<SettingKey, string>>>({});
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string; id: number } | null>(null);
  // Ein dauerhafter, unsichtbarer Bereich für Ansagen (Gespeichert, Testergebnis) – Screenreader lesen ihn zuverlässig.
  const [announcement, setAnnouncement] = useState('');
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<{ needsPassword: boolean; confirms: string[]; error: { text: string; id: number } | null } | null>(null);
  const messageId = useRef(0);
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  // Abstand zwischen Server- und Browseruhr – für die Restzeit der Probe.
  const clockOffset = useRef(0);
  const [manualAccounts, setManualAccounts] = useState(false);
  /** Schalter, der gerade auf Passwort oder Rückfrage wartet – bei „Abbrechen“ springt er zurück. */
  const quickPending = useRef<SettingKey | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ key: SettingKey; seq: number } | null>(null);
  const focusSeq = useRef(0);

  const say = useCallback((tone: 'good' | 'bad', text: string) => {
    setMessage({ tone, text, id: ++messageId.current });
    if (tone === 'good') setAnnouncement(text);
  }, []);

  const apply = useCallback((response: SettingsResponse) => {
    clockOffset.current = response.serverTime - Date.now();
    setData(response);
  }, []);

  const load = useCallback(() => {
    setLoadError(null);
    settingsApi
      .get()
      .then(apply)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) {
          setLoadError('Einstellungen in der Software gibt es auf diesem Server noch nicht – sie kommen mit dem nächsten Update.');
        } else if (error instanceof ApiError && error.code !== 'offline' && error.code !== 'error') {
          setLoadError(error.message);
        } else {
          setLoadError('Die Einstellungen ließen sich nicht laden. Ist der Server erreichbar?');
        }
      });
  }, [apply]);

  useEffect(load, [load]);

  // Kennzeichen für die Seitenleiste – nur melden, wenn sich etwas geändert hat.
  const badges = data ? navBadges(data, draft, errors, live) : {};
  const badgeKey = JSON.stringify(badges);
  useEffect(() => {
    onBadges(JSON.parse(badgeKey) as Partial<Record<SettingsSection, NavBadge>>);
  }, [badgeKey, onBadges]);

  const states = useMemo(() => new Map((data?.settings ?? []).map((state) => [state.key, state])), [data]);
  const changes = changedEntries(draft);

  // Unten liegt die Leiste – beim Tabben soll das fokussierte Feld nicht darunter verschwinden. In anderen Bereichen
  // (Vorlagen, Automatische Suche) haben diese ihre eigene Leiste; offene Entwürfe zeigt dort die Seitenleiste.
  const barVisible = active && (changes.length > 0 || !!message);
  useEffect(() => {
    if (!barVisible) return;
    document.documentElement.style.scrollPaddingBottom = '120px';
    return () => {
      document.documentElement.style.scrollPaddingBottom = '';
    };
  }, [barVisible]);

  const setValue = (key: SettingKey, value: DraftValue) => {
    const state = states.get(key);
    const definition = settingDefinition(key);
    // Wieder beim wirksamen Wert angekommen → keine Änderung (Geheimnisse sieht die Seite nie, dort gilt das nicht).
    const unchanged = value !== null && value !== undefined && definition.type !== 'secret' && state && value === state.value;
    setDraft((current) => ({ ...current, [key]: unchanged ? undefined : value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    // Alte Meldung („nicht in Ordnung“, „Gespeichert“) passt nach einer Änderung nicht mehr – die Fehler stehen am Feld.
    setMessage(null);
  };

  /** Fokus auf das erste fehlerhafte Feld (Reihenfolge wie im Katalog): erst in den Bereich wechseln, nach dem Rendern fokussieren. */
  const focusFirst = (found: Partial<Record<SettingKey, string>>) => {
    const first = SETTING_KEYS.find((key) => found[key]);
    if (!first) return;
    onNavigate(settingDefinition(first).group, subpageOf(first).id);
    if (ACCOUNT_KEYS.includes(first)) setManualAccounts(true);
    setFocusRequest({ key: first, seq: ++focusSeq.current });
  };

  useEffect(() => {
    if (!focusRequest) return;
    const frame = requestAnimationFrame(() => {
      const container = document.querySelector(`[data-testid="setting-${focusRequest.key}"]`);
      const control = container ? firstControl(container) : null;
      container?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      control?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);

  /** Prüft den Entwurf wie das Backend, bevor etwas geschickt wird. */
  const validate = (): boolean => {
    const found: Partial<Record<SettingKey, string>> = {};
    for (const [key, value] of changes) {
      const problem = validateDraft(settingDefinition(key), value);
      if (problem) found[key] = problem;
    }
    // Adresse mit gebundenem Geheimnis nur zusammen mit neuem Geheimnis (sonst könnte der Schlüssel woandershin gehen).
    for (const [key, value] of changes) {
      const bound = settingDefinition(key).boundSecret;
      if (bound && value !== null && !(typeof draft[bound] === 'string' && draft[bound] !== '')) {
        found[bound] = `Beim Ändern von „${settingDefinition(key).label}“ bitte „${settingDefinition(bound).label}“ neu eingeben.`;
      }
    }
    // Probe-Werte (Server und Anmeldung) nur einzeln – einer pro Speichern.
    const trialKeys = changes.filter(([key]) => settingDefinition(key).trial);
    if (trialKeys.length && changes.length > 1) {
      for (const [key] of trialKeys) found[key] = 'Diesen Wert bitte allein speichern – er gilt erst auf Probe.';
    }
    setErrors(found);
    const count = Object.keys(found).length;
    if (count) {
      say('bad', count === 1 ? '1 Wert ist noch nicht in Ordnung.' : `${count} Werte sind noch nicht in Ordnung.`);
      focusFirst(found);
    }
    return count === 0;
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (saving || !changes.length || dialogRef.current || !validate()) return;
    const needsPassword = changes.some(([key]) => settingDefinition(key).reauth);
    const confirms = changes.flatMap(([key, value]) => {
      const text = value === null ? undefined : settingDefinition(key).confirm?.[String(value)];
      return text ? [text] : [];
    });
    if (needsPassword || confirms.length) setDialog({ needsPassword, confirms, error: null });
    else void save();
  };

  // ↵ speichert auch, wenn der Fokus auf einem Schalter oder einer Auswahl liegt (in Textfeldern übernimmt das Formular).
  useHotkeys({ enter: () => submit() }, active && changes.length > 0 && !dialog);

  const save = async (password?: string) => {
    if (!data) return;
    setSaving(true);
    const trial = changes.some(([key]) => settingDefinition(key).trial);
    const body: SettingsUpdateRequest = { changes: Object.fromEntries(changes), version: data.version, ...(password ? { password } : {}) };
    try {
      apply(await settingsApi.update(body));
      setDraft({});
      setErrors({});
      setDialog(null);
      quickPending.current = null;
      say('good', trial ? 'Gilt jetzt auf Probe – prüf es und tipp oben auf „Behalten“.' : 'Gespeichert – gilt ab sofort für alle.');
      onSaved?.();
    } catch (error) {
      if (!(error instanceof ApiError)) {
        setDialog(null);
        say('bad', 'Speichern hat nicht geklappt. Versuch es noch einmal.');
      } else if ((error.code === 'reauth_failed' || error.code === 'too_many_attempts') && dialogRef.current) {
        setDialog((current) => (current ? { ...current, error: { text: error.message, id: ++messageId.current } } : current));
      } else {
        setDialog(null);
        if (error.code === 'invalid_setting' && error.field && (SETTING_KEYS as readonly string[]).includes(error.field)) {
          const found = { [error.field as SettingKey]: error.message };
          setErrors(found);
          say('bad', error.message);
          focusFirst(found);
        } else if (error.code === 'settings_changed') {
          // Neu laden, Entwurf behalten: Die eigenen Änderungen stehen noch da.
          load();
          say('bad', 'Inzwischen hat jemand anderes gespeichert – prüf deine Änderungen und speichere noch einmal.');
        } else {
          say('bad', error.message);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  /**
   * Schalter einer einfachen Seite: gilt sofort. Braucht der Wert Passwort oder Rückfrage (Sicherung aus), geht es über
   * denselben Dialog wie „Speichern“.
   */
  const quickSet = async (key: SettingKey, value: SettingValue) => {
    if (!data || saving) return;
    const definition = settingDefinition(key);
    const confirm = definition.confirm?.[String(value)];
    if (definition.reauth || confirm) {
      quickPending.current = key;
      setValue(key, value);
      setDialog({ needsPassword: !!definition.reauth, confirms: confirm ? [confirm] : [], error: null });
      return;
    }
    setSaving(true);
    try {
      apply(await settingsApi.update({ changes: { [key]: value }, version: data.version }));
      setDraft((current) => ({ ...current, [key]: undefined }));
      setAnnouncement('Gespeichert');
      onSaved?.();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'settings_changed') load();
      say('bad', error instanceof ApiError ? error.message : 'Speichern hat nicht geklappt. Versuch es noch einmal.');
    } finally {
      setSaving(false);
    }
  };

  // Laden und Fehler nur im eigenen Bereich zeigen, nicht unter Vorlagen oder Automatischer Suche.
  if (!active && (loadError || !data)) return null;
  if (loadError) {
    return (
      <div className="py-16">
        <p className="text-[15px] text-ink-2" role="alert" data-testid="settings-load-error">
          {loadError}
        </p>
        <Button variant="secondary" className="mt-6" onClick={load}>
          Erneut versuchen
        </Button>
      </div>
    );
  }
  if (!data) {
    return (
      <p role="status" className="py-16 text-[14px] text-ink-3">
        Einstellungen werden geladen …
      </p>
    );
  }

  // Wirksamer Wert inklusive Entwurf – entscheidet, welche Felder unter der aktuellen Wahl etwas bewirken.
  const get = (key: SettingKey) => (draft[key] !== undefined ? draft[key] : states.get(key)?.value);
  const APPLIES: Partial<Record<SettingKey, () => boolean>> = {
    TREG_TOKEN: () => get('ENRICHMENT_PROVIDER') !== 'clay',
    TREG_MAX_COST_USD: () => get('ENRICHMENT_PROVIDER') !== 'clay',
    CLAY_WEBHOOK_URL: () => get('ENRICHMENT_PROVIDER') === 'clay',
    CLAY_WEBHOOK_TOKEN: () => get('ENRICHMENT_PROVIDER') === 'clay',
    CLAY_CALLBACK_SECRET: () => get('ENRICHMENT_PROVIDER') === 'clay',
    UPDATE_HOUR: () => get('UPDATE_AUTO') === true,
  };
  /** Feld zeigen? Was gerade nichts bewirkt, fällt weg – außer es hat einen Entwurf, Fehler, ein Problem oder einen gespeicherten Wert im Notfallmodus. */
  const visible = (key: SettingKey) => {
    const state = states.get(key);
    if (draft[key] !== undefined || errors[key] || state?.problem || (data.safeMode && state?.stored)) return true;
    return APPLIES[key]?.() ?? true;
  };

  const renderField = (definition: SettingDefinition, solo = false, inline = false) => {
    const state = states.get(definition.key);
    if (!state || !visible(definition.key)) return null;
    if (inline) {
      const label = SHORT_LABELS[definition.key] ?? definition.label;
      // Ein/Aus direkt auf der Seite: Schalter, der sofort gilt (Passwort oder Rückfrage, wo der Wert sie verlangt).
      const onOff = definition.type === 'choice' && definition.options?.length === 2 && definition.options.every((option) => option.value === 'on' || option.value === 'off');
      if ((definition.type === 'boolean' || onOff) && !errors[definition.key] && !state.problem && !(data.safeMode && state.stored)) {
        const value = get(definition.key);
        return (
          <QuickSwitch
            key={definition.key}
            label={label}
            on={value === true || value === 'on'}
            disabled={saving || data.safeMode || !!definition.readOnlyReason}
            onChange={(on) => void quickSet(definition.key, definition.type === 'boolean' ? on : on ? 'on' : 'off')}
            testId={`setting-${definition.key}`}
          />
        );
      }
      definition = { ...definition, label };
    }
    return (
      <SettingField
        // Neu aufbauen, wenn sich der gespeicherte Stand dieses Werts ändert – sonst bleibt der Fokus, wo er ist.
        key={`${definition.key}-${savedSignature(state)}`}
        definition={definition}
        state={state}
        draft={draft[definition.key]}
        onDraft={(value) => setValue(definition.key, value)}
        error={errors[definition.key]}
        safeMode={data.safeMode}
        solo={solo}
        note={definition.key === 'TRUST_PROXY_HOPS' ? `Der Server sieht dich gerade als ${data.clientIp}.` : undefined}
      />
    );
  };
  const fieldList = (definitions: readonly SettingDefinition[]) => definitions.length > 0 && <div className={ROW_GAP}>{definitions.map((definition) => renderField(definition))}</div>;

  /** Unterseite sichtbar? Fällt weg, wenn keiner ihrer Werte unter der aktuellen Wahl etwas bewirkt (Treg ↔ Clay). */
  const pageVisible = (entry: SettingsSubpage) => !!entry.extra || entry.keys.some(visible);

  /** Kennzeichen einer Zeile – nur was abweicht. */
  const pageBadge = (entry: SettingsSubpage): RowBadge | null => {
    if (entry.keys.some((key) => errors[key])) return { text: 'Prüfen', tone: 'bad' };
    if (entry.keys.some((key) => draft[key] !== undefined)) return { text: 'geändert', tone: 'accent' };
    if (entry.keys.some((key) => data.trial?.keys.includes(key))) return { text: 'auf Probe', tone: 'warn' };
    if (entry.keys.some((key) => states.get(key)?.problem || (data.safeMode && states.get(key)?.stored))) return { text: 'Prüfen', tone: 'warn' };
    return null;
  };

  /** Inhalt einer Unterseite: höchstens ein paar Werte, dazu eigene Bausteine (Accounts zuordnen, Such-Account). */
  const pageContent = (entry: SettingsSubpage): ReactNode => {
    const definitions = entry.keys.map(settingDefinition);
    const unsaved = changes.some(([key]) => entry.keys.includes(key));
    if (entry.extra === 'linkedinAccounts' && !data.safeMode) {
      const hasIssue = ACCOUNT_KEYS.some((key) => errors[key] || states.get(key)?.problem);
      return (
        <LinkedInSetup
          drafts={{
            ...(typeof draft.UNIPILE_ACCOUNT_NICK === 'string' ? { nick: draft.UNIPILE_ACCOUNT_NICK } : {}),
            ...(typeof draft.UNIPILE_ACCOUNT_JOHANNES === 'string' ? { johannes: draft.UNIPILE_ACCOUNT_JOHANNES } : {}),
          }}
          saved={{ nick: savedText(states.get('UNIPILE_ACCOUNT_NICK')), johannes: savedText(states.get('UNIPILE_ACCOUNT_JOHANNES')) }}
          warmup={splitIds(typeof draft.UNIPILE_WARMUP_ACCOUNTS === 'string' ? draft.UNIPILE_WARMUP_ACCOUNTS : savedText(states.get('UNIPILE_WARMUP_ACCOUNTS')))}
          used={splitIds(typeof draft.UNIPILE_ACCOUNTS_USED === 'string' ? draft.UNIPILE_ACCOUNTS_USED : savedText(states.get('UNIPILE_ACCOUNTS_USED')))}
          founders={FOUNDER_IDS.filter(
            (id) => (auth.status === 'authenticated' && auth.user.founderNames?.[id]) || savedText(states.get(id === 'nick' ? 'UNIPILE_ACCOUNT_NICK' : 'UNIPILE_ACCOUNT_JOHANNES')),
          )}
          ownFounder={access.role === 'founder' ? access.founder : null}
          onPick={(key, accountId) => setValue(key, accountId)}
          unsaved={unsaved}
          manual={fieldList(definitions)}
          manualOpen={manualAccounts || hasIssue}
          onManualToggle={() => setManualAccounts((value) => !value)}
        />
      );
    }
    if (entry.extra === 'unsentInvites') return <UnsentInvites sendingOn={savedText(states.get('LINKEDIN_ACTIONS')) === 'on'} />;
    if (entry.extra === 'searchAccount' && !data.safeMode) {
      // Such-Account per Klick wählen (11.10.); das Feld UNIPILE_ACCOUNT_ID bleibt zum Eintragen von Hand.
      return (
        <>
          <SearchAccountPicker
            draft={typeof draft.UNIPILE_ACCOUNT_ID === 'string' ? draft.UNIPILE_ACCOUNT_ID : undefined}
            saved={savedText(states.get('UNIPILE_ACCOUNT_ID')) ?? ''}
            onPick={(accountId) => setValue('UNIPILE_ACCOUNT_ID', accountId)}
          />
          <div className="mt-8">{fieldList(definitions)}</div>
        </>
      );
    }
    if (definitions.every((definition) => definition.readOnlyReason)) return <div className="space-y-5">{definitions.map((definition) => renderField(definition))}</div>;
    // Ein Wert allein: Hilfetext sichtbar wie ein Untertitel, die Eingabe darunter in voller Breite.
    if (definitions.length === 1) {
      return (
        <>
          {definitions[0].help && <p className="-mt-6 mb-8 text-[15px] leading-relaxed text-ink-3">{definitions[0].help}</p>}
          {renderField(definitions[0], true)}
        </>
      );
    }
    return fieldList(definitions);
  };

  /**
   * Seite eines Werte-Bereichs (Wunsch des Nutzers 23.10.): oben der große Knopf (Verbindung testen), darunter direkt
   * die wichtigen Werte – Schalter gelten sofort –, dann eigene Bausteine und „Erweitert“ als Zeilen.
   */
  const groupList = (group: SettingGroup) => {
    const unsaved = changes.some(([key]) => settingDefinition(key).group === group);
    const tests = (TESTS[group] ?? []).filter((test) => test.service !== 'treg' || get('ENRICHMENT_PROVIDER') !== 'clay');
    const pages = subpagesOf(group);
    const main = pages.find((entry) => entry.inline);
    // Automatische Updates stehen auf der Seite „Software-Update“.
    const rows = pages.filter((entry) => !entry.inline && pageVisible(entry) && entry.id !== UPDATE_PAGE);
    return (
      <>
        {tests.length > 0 && !data.safeMode && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 pb-10">
            {tests.map((test, index) => (
              <ConnectionTest
                key={`${test.service}-${data.version}`}
                service={test.service}
                label={test.label}
                unsaved={unsaved}
                announce={setAnnouncement}
                big={index === 0}
              />
            ))}
          </div>
        )}
        {main && <div className={ROW_GAP}>{main.keys.map((key) => renderField(settingDefinition(key), false, true))}</div>}
        {rows.length > 0 && (
          <MenuList className={main ? 'pt-10' : undefined}>
            {rows.map((entry) => (
              <MenuRow
                key={entry.id}
                title={entry.label}
                badge={pageBadge(entry)}
                current={page === entry.id}
                onClick={() => onNavigate(group, entry.id)}
                testId={`settings-row-${entry.id}`}
              />
            ))}
          </MenuList>
        )}
        {group === 'meta' && !data.safeMode && (
          <div className="pt-10">
            <MetaRecheck tokenSet={states.get('META_ACCESS_TOKEN')?.secret?.set === true} />
          </div>
        )}
      </>
    );
  };

  return (
    <form onSubmit={submit} noValidate data-testid="settings">
      <p className="sr-only" aria-live="polite" data-testid="settings-announcement">
        {announcement}
      </p>

      {(active || notices) && (data.safeMode || data.trial) && (
        <div className="pt-8">
          {data.safeMode && (
            <StatusLine role="status" testId="safe-mode" className="mb-4 text-[14px] text-ink-2">
              <span className="font-medium text-ink">Notfallmodus ist an</span> – es gilt nur die .env. Gespeicherte Werte kannst du hier nur löschen;
              ausschalten: <code>SETTINGS_SAFE_MODE</code> in der .env auf dem Server entfernen.
            </StatusLine>
          )}
          {data.trial && (
            <TrialBanner
              data={data}
              own={data.trial.username === username}
              clockOffset={clockOffset.current}
              onChange={apply}
              onExpired={() => {
                load();
                say('bad', 'Die Probezeit ist abgelaufen – der Wert wurde automatisch zurückgesetzt.');
              }}
              say={say}
            />
          )}
        </div>
      )}

      {/* Nur der gewählte Bereich ist sichtbar; Entwürfe der anderen bleiben erhalten (Leiste unten zählt sie). */}
      <div hidden={!section} className={quick ? 'pt-10' : 'pb-40 pt-8'}>
        {quick && (
          <div className={ROW_GAP} data-testid="settings-quick">
            {quick.map((toggle) => (
              <QuickSwitch
                key={toggle.key}
                label={toggle.label}
                on={toggle.isOn(get(toggle.key))}
                disabled={saving || data.safeMode}
                onChange={(on) => void quickSet(toggle.key, toggle.valueFor(on))}
                testId={`quick-${toggle.key}`}
              />
            ))}
          </div>
        )}
        {section === 'overview' && (
          <SettingsOverview
            states={states}
            // In den Bereich wechseln, nach dem Rendern zum Feld springen.
            onJump={(key) => {
              onNavigate(settingDefinition(key).group, subpageOf(key).id);
              if (ACCOUNT_KEYS.includes(key)) setManualAccounts(true);
              setFocusRequest({ key, seq: ++focusSeq.current });
            }}
          />
        )}

        {SETTING_GROUPS.map((group) => (
          <section key={group} hidden={section !== group || (!!quick && page === null)} data-testid={`group-${group}`} aria-label={SETTING_GROUP_LABELS[group]}>
            <div hidden={page !== null}>{groupList(group)}</div>
            {/* Alle Unterseiten bleiben geladen (Fokus bei Fehlern, Zustand der Felder) – sichtbar ist nur die offene. */}
            {/* Die wichtigen Werte stehen schon auf der Seite des Bereichs – keine zweite Kopie. */}
            {subpagesOf(group)
              .filter((entry) => !entry.inline)
              .map((entry) => (
                <div key={entry.id} hidden={page !== entry.id} data-testid={`settings-page-${entry.id}`}>
                  {pageContent(entry)}
                </div>
              ))}
          </section>
        ))}

        {section === 'history' && <HistorySection version={data.version} />}
      </div>

      {/* Leiste unten: genau eine Haupt-Aktion. */}
      <AnimatePresence>
        {barVisible && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="glass fixed inset-x-0 bottom-[var(--nav-bottom)] z-40 border-t border-line"
          >
            <div className="mx-auto flex max-w-[760px] flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
              <p
                key={message?.tone === 'bad' ? message.id : 'status'}
                role={message?.tone === 'bad' ? 'alert' : undefined}
                className="flex min-w-0 flex-1 items-baseline gap-2 text-[13.5px] text-ink"
                data-testid="settings-message"
              >
                {message && (changes.length === 0 || message.tone === 'bad') ? (
                  <>
                    <span className={cn('h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full', message.tone === 'good' ? 'bg-good' : 'bg-bad')} aria-hidden />
                    {message.text}
                  </>
                ) : (
                  `${changes.length} ${changes.length === 1 ? 'Änderung' : 'Änderungen'}`
                )}
              </p>
              {changes.length > 0 && (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setDraft({});
                      setErrors({});
                      setMessage(null);
                    }}
                  >
                    Verwerfen
                  </Button>
                  <Button type="submit" variant="primary" shortcut={saving ? undefined : '↵'} disabled={saving} data-testid="settings-save">
                    {saving ? 'Wird gespeichert…' : 'Speichern'}
                  </Button>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <SaveDialog
        dialog={dialog}
        saving={saving}
        onCancel={() => {
          // Während des Speicherns nicht schließen – sonst ginge das Ergebnis verloren.
          if (saving) return;
          setDialog(null);
          const key = quickPending.current;
          quickPending.current = null;
          if (key) setDraft((current) => ({ ...current, [key]: undefined }));
        }}
        onConfirm={(password) => void save(password)}
      />
    </form>
  );
}

/** Rückfrage vor dem Speichern: Passwort (bei Schlüsseln) und Bestätigungstexte (z. B. Live-Modus). */
function SaveDialog({
  dialog,
  saving,
  onCancel,
  onConfirm,
}: {
  dialog: { needsPassword: boolean; confirms: string[]; error: { text: string; id: number } | null } | null;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (password?: string) => void;
}) {
  const [password, setPassword] = useState('');
  const passwordRef = useRef<HTMLInputElement>(null);
  const errorId = dialog?.error?.id;

  useEffect(() => {
    if (!dialog) setPassword('');
  }, [dialog]);
  // Jede Meldung (auch die gleiche zum zweiten Mal): Passwort leeren und Fokus zurück ins Feld.
  useEffect(() => {
    if (errorId === undefined) return;
    setPassword('');
    passwordRef.current?.focus();
  }, [errorId]);

  const describedBy = dialog
    ? [dialog.error && 'settings-dialog-error', ...dialog.confirms.map((_, index) => `settings-confirm-${index}`)]
        .filter(Boolean)
        .join(' ')
    : undefined;

  return (
    <Modal open={!!dialog} onClose={onCancel} labelledBy="settings-dialog-title">
      {dialog && (
        <form
          className="p-6 sm:p-8"
          data-testid="settings-dialog"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            // Portale reichen Ereignisse im React-Baum weiter – das Formular der Seite darf das nicht noch einmal bekommen.
            event.stopPropagation();
            if (!saving && (!dialog.needsPassword || password)) onConfirm(dialog.needsPassword ? password : undefined);
          }}
        >
          <h2 id="settings-dialog-title" className="text-[20px] font-semibold">
            {dialog.needsPassword ? 'Zur Sicherheit: dein Passwort' : 'Wirklich speichern?'}
          </h2>
          {dialog.confirms.map((text, index) => (
            <p key={text} id={`settings-confirm-${index}`} className="mt-3 text-[14.5px] leading-relaxed text-ink-2">
              {text}
            </p>
          ))}
          {dialog.needsPassword && (
            <>
              <label htmlFor="settings-password" className="mb-2 mt-5 block text-[13px] font-medium text-ink-2">
                Passwort
              </label>
              <input
                ref={passwordRef}
                id="settings-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={!!dialog.error}
                aria-describedby={describedBy}
                className="h-12 w-full rounded-2xl border border-transparent bg-surface-3 px-4 text-[16px] text-ink outline-none transition-colors focus:border-accent"
              />
            </>
          )}
          {dialog.error && (
            <p
              key={dialog.error.id}
              id="settings-dialog-error"
              role="alert"
              className="mt-3 flex items-baseline gap-2 text-[14px] text-ink"
              data-testid="settings-dialog-error"
            >
              <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
              {dialog.error.text}
            </p>
          )}
          <div className="mt-7 flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={saving}>
              Abbrechen
            </Button>
            <Button
              type="submit"
              variant="primary"
              shortcut={saving ? undefined : '↵'}
              disabled={saving || (dialog.needsPassword && !password)}
              autoFocus={!dialog.needsPassword}
              data-testid="settings-dialog-confirm"
            >
              {saving ? 'Wird gespeichert…' : 'Speichern'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** Probe-Änderung: Restzeit, „Behalten“ (nur wer sie gestartet hat, mit der neuen Sitzung) oder „Zurücksetzen“. */
function TrialBanner({
  data,
  own,
  clockOffset,
  onChange,
  onExpired,
  say,
}: {
  data: SettingsResponse;
  own: boolean;
  clockOffset: number;
  onChange: (response: SettingsResponse) => void;
  onExpired: () => void;
  say: (tone: 'good' | 'bad', text: string) => void;
}) {
  const trial = data.trial!;
  const remaining = () => Math.max(0, Math.round((trial.revertsAt - (Date.now() + clockOffset)) / 1000));
  const [seconds, setSeconds] = useState(remaining);
  const [busy, setBusy] = useState(false);
  const expiredRef = useRef(onExpired);
  expiredRef.current = onExpired;

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = remaining();
      setSeconds(next);
      if (next === 0) {
        window.clearInterval(timer);
        expiredRef.current();
      }
    }, 1000);
    return () => window.clearInterval(timer);
    // Nur bei einer neuen Probe neu starten.
  }, [trial.revertsAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (kind: 'confirm' | 'revert') => {
    setBusy(true);
    try {
      onChange(await (kind === 'confirm' ? settingsApi.confirmTrial() : settingsApi.revertTrial()));
      say('good', kind === 'confirm' ? 'Behalten – der Wert gilt jetzt dauerhaft.' : 'Zurückgesetzt.');
    } catch (error) {
      say(
        'bad',
        error instanceof ApiError && error.code === 'trial_session_mismatch'
          ? 'Behalten geht nur in dem Fenster, in dem du gespeichert hast – und ohne dich zwischendurch abzumelden.'
          : error instanceof ApiError
            ? error.message
            : 'Das hat nicht geklappt.',
      );
    } finally {
      setBusy(false);
    }
  };

  const labels = trial.keys.map((key) => `„${settingDefinition(key).label}“`).join(', ');
  const minutes = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  // Kein Live-Bereich: Die Restzeit ändert sich jede Sekunde und würde sonst ständig vorgelesen.
  return (
    <div className="mb-10 rounded-[12px] bg-surface-2 p-5" data-testid="trial-banner">
      <p className="text-[15px] font-medium text-ink">
        {labels} {trial.keys.length > 1 ? 'gelten' : 'gilt'} auf Probe – noch <span className="tabular-nums">{minutes}</span>
      </p>
      <p className="mt-1 text-[13.5px] leading-snug text-ink-2">
        {own
          ? 'Prüf in einem privaten Fenster, ob die Anmeldung noch klappt – hier nicht abmelden. '
          : `„Behalten“ kann nur ${trial.username}. `}
        Ohne „Behalten“ wird zurückgesetzt.
        {trial.keys.includes('TRUST_PROXY_HOPS') && ` Der Server sieht dich gerade als ${data.clientIp}.`}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {own && (
          <Button variant="outline" disabled={busy} onClick={() => void act('confirm')} data-testid="trial-confirm">
            Behalten
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={() => void act('revert')} data-testid="trial-revert">
          Jetzt zurücksetzen
        </Button>
      </div>
    </div>
  );
}

/** Verbindung mit den gespeicherten Werten prüfen. */
function ConnectionTest({
  service,
  label = 'Verbindung testen',
  unsaved,
  announce,
  big = false,
}: {
  service: SettingsTestService;
  label?: string;
  unsaved: boolean;
  announce: (text: string) => void;
  /** Haupt-Knopf einer einfachen Seite. */
  big?: boolean;
}) {
  const [state, setState] = useState<{ status: 'idle' | 'running' } | { status: 'done'; ok: boolean; message: string }>({ status: 'idle' });

  const run = async () => {
    setState({ status: 'running' });
    try {
      const result = await settingsApi.test(service);
      setState({ status: 'done', ok: result.ok, message: result.message });
      announce(result.message);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Test hat nicht geklappt.';
      setState({ status: 'done', ok: false, message });
      announce(message);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid={`test-${service}`}>
      <Button size={big ? 'lg' : 'sm'} variant={big ? 'primary' : 'secondary'} disabled={state.status === 'running' || unsaved} onClick={() => void run()}>
        {state.status === 'running' ? 'Wird geprüft…' : label}
      </Button>
      {/* Der Test prüft die gespeicherten Werte. */}
      {unsaved ? (
        <span className="text-[12.5px] text-ink-3">Erst speichern, dann testen.</span>
      ) : (
        state.status === 'done' && (
          <span className="flex items-baseline gap-2 text-[13px] text-ink" data-testid="test-result">
            <span className={cn('h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full', state.ok ? 'bg-good' : 'bg-bad')} aria-hidden />
            {state.message}
          </span>
        )
      )}
    </div>
  );
}

/** Wer hat wann was geändert – Geheimnisse ohne Wert. Lädt beim Öffnen des Bereichs und nach jedem Speichern. */
function HistorySection({ version }: { version: number }) {
  const [entries, setEntries] = useState<SettingsHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    settingsApi
      .history()
      .then((response) => setEntries(response.entries))
      .catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : 'Verlauf ließ sich nicht laden.'));
  }, [version]);

  return (
    <div data-testid="history">
      {error ? (
        <p className="text-[13.5px] text-ink-2">{error}</p>
      ) : !entries ? (
        <p className="text-[13.5px] text-ink-3">Wird geladen …</p>
      ) : entries.length === 0 ? (
        <p className="text-[13.5px] text-ink-3">Noch keine Änderungen.</p>
      ) : (
        <ul className="space-y-4 text-[13px]">
          {entries.map((entry, index) => {
            const definition = settingDefinition(entry.key);
            const values =
              entry.from !== undefined || entry.to !== undefined ? ` · ${historyValue(entry.key, entry.from)} → ${historyValue(entry.key, entry.to)}` : '';
            return (
              <li key={`${entry.at}-${entry.key}-${index}`} className="flex flex-wrap gap-x-3" data-testid="history-entry">
                <span className="tabular-nums text-ink-3">{timeFormat.format(entry.at)}</span>
                <span className="font-semibold text-ink">{entry.username}</span>
                <span className="text-ink-2">
                  {definition.label} {ACTION_LABEL[entry.action]}
                  {values}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
