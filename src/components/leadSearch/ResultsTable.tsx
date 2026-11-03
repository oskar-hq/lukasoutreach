import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronRight, ExternalLink, Megaphone } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  CATEGORY_LABELS,
  MANUAL_QUALIFY_STATUSES,
  germanDate,
  isQualifyingCategory,
  TARGET_GROUPS_TEXT,
  metaAdsLabel,
  type MetaAdsCheck,
  type PipelineLead,
} from '../../../shared/leadSearch';
import { cn } from '../../lib/cn';
import { Pill } from '../ui/Pill';
import { Segmented } from '../ui/Segmented';
import {
  categoryIsQualifying,
  categoryLabel,
  fullName,
  percent,
  rejectedSummary,
  sortForResults,
  statusDetail,
  statusView,
} from './status';
import { EASE_OUT } from '../../lib/motion';
import { libraryLink } from '../../lib/leadView';
import { safeHref } from '../../lib/safeHref';

type Filter = 'all' | 'qualified' | 'ads_active' | 'unrated' | 'rejected';
/** Eigene Reiter – alles andere landet unter „Aussortiert“. */
const OWN_TABS: readonly string[] = ['qualified', 'ads_active', 'unrated'];

const COLUMNS = 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,2fr)_minmax(0,0.9fr)]';

/**
 * Von Hand qualifizieren (Wunsch des Nutzers 12.10.): löst auf, ob der Lead danach im Cockpit liegt (`placed`) oder
 * bei der Übergabe mitgeht. Wirft mit deutscher Meldung.
 */
export type QualifyLead = (leadId: string) => Promise<{ placed: boolean }>;

/** Ergebnis eines Laufs: Name, Firma, Begründung, Status – Kategorie und Confidence stehen in den Details. */
export function ResultsTable({ leads, onQualify }: { leads: PipelineLead[]; onQualify?: QualifyLead }) {
  const qualified = leads.filter((lead) => lead.status === 'qualified');
  const adsActive = leads.filter((lead) => lead.status === 'ads_active');
  const unrated = leads.filter((lead) => lead.status === 'unrated');
  // Die Qualifizierten zuerst – „Alle“ ist nur noch der letzte Reiter.
  const [filter, setFilter] = useState<Filter>(() =>
    qualified.length ? 'qualified' : adsActive.length ? 'ads_active' : unrated.length ? 'unrated' : 'all',
  );
  const sorted = useMemo(() => sortForResults(leads), [leads]);
  const visible = sorted.filter((lead) =>
    filter === 'all' ? true : filter === 'rejected' ? !OWN_TABS.includes(lead.status) : lead.status === filter,
  );

  return (
    <section aria-label="Ergebnis der Lead-Suche" data-testid="results">
      <Segmented<Filter>
        ariaLabel="Ergebnis filtern"
        size="sm"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'qualified', label: 'Qualifiziert', count: qualified.length },
          ...(adsActive.length ? [{ value: 'ads_active' as const, label: 'Schalten Meta-Ads', count: adsActive.length }] : []),
          ...(unrated.length ? [{ value: 'unrated' as const, label: 'Nicht bewertet', count: unrated.length }] : []),
          { value: 'rejected', label: 'Aussortiert', count: leads.length - qualified.length - adsActive.length - unrated.length },
          { value: 'all', label: 'Alle', count: leads.length },
        ]}
      />
      {filter === 'rejected' && (
        <p className="mt-3 text-[12.5px] text-ink-3" data-testid="rejected-summary">
          {rejectedSummary(leads)}
          {onQualify && leads.some((lead) => MANUAL_QUALIFY_STATUSES.includes(lead.status)) && (
            <span className="block sm:inline"> · Passt doch einer? „Qualifizieren“ – dann geht er mit in den Tagesstapel.</span>
          )}
        </p>
      )}

      <div className="mt-3" role="table" aria-label="Leads">
        <div
          role="row"
          className={cn(
            'hidden gap-x-4 px-2 pb-2 text-[11.5px] font-semibold text-ink-3 lg:grid',
            COLUMNS,
          )}
        >
          {['Name', 'Firma', 'Begründung', 'Status'].map((label) => (
            <span key={label} role="columnheader">
              {label}
            </span>
          ))}
        </div>
        <div className="space-y-0.5">
          {visible.map((lead) => (
            <ResultRow key={lead.id} lead={lead} onQualify={onQualify} />
          ))}
        </div>
        {visible.length === 0 && <p className="py-10 text-center text-[14px] text-ink-3">Keine Leads in dieser Ansicht.</p>}
      </div>
    </section>
  );
}

function ResultRow({ lead, onQualify }: { lead: PipelineLead; onQualify?: QualifyLead }) {
  const [open, setOpen] = useState(false);
  const qualify = onQualify && MANUAL_QUALIFY_STATUSES.includes(lead.status) ? onQualify : undefined;
  const company = lead.profile?.companyName ?? null;
  const position = lead.profile?.position ?? lead.hit.headline;
  const why = lead.qualification?.reason ?? statusDetail(lead);
  return (
    <div data-testid="result-row" data-status={lead.status}>
      <div
        role="row"
        onClick={(event) => {
          // Klick irgendwo in die Zeile klappt die Details auf – Links behalten ihr eigenes Verhalten.
          if (!(event.target as HTMLElement).closest('a, button')) setOpen((value) => !value);
        }}
        className={cn(
          'grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 rounded-xl px-2 py-3.5 transition-colors duration-150 hover:bg-white/[0.03] lg:items-start lg:gap-y-0',
          open && 'bg-white/[0.03]',
          COLUMNS,
        )}
      >
        <div role="cell" className="min-w-0">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="group flex max-w-full items-center gap-1 text-left text-[14px] font-medium text-ink"
            data-testid="result-toggle"
          >
            <span className="truncate">{fullName(lead)}</span>
            <ChevronRight
              className={cn('h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform duration-200', open && 'rotate-90')}
            />
          </button>
          <p className="truncate text-[12.5px] text-ink-3">{lead.profile?.location ?? lead.hit.location ?? ''}</p>
        </div>

        {/* Mobil: Status oben rechts */}
        <div className="flex items-center justify-end lg:hidden">
          <StatusCell lead={lead} />
        </div>

        <div role="cell" className="col-span-2 min-w-0 lg:col-span-1 lg:pt-1">
          <p className="truncate text-[13.5px] text-ink-2 lg:hidden">{[position, company].filter(Boolean).join(' · ')}</p>
          <p className="hidden truncate text-[13.5px] text-ink lg:block" title={company ?? position}>
            {company ?? position}
          </p>
          {company && (
            <p className="hidden truncate text-[12.5px] text-ink-3 lg:block" title={position}>
              {position}
            </p>
          )}
        </div>
        {why ? (
          <p
            role="cell"
            className="col-span-2 line-clamp-2 text-[13px] leading-[1.5] text-ink-2 lg:col-span-1 lg:pt-1.5"
            title={why}
          >
            {why}
          </p>
        ) : (
          <span role="cell" className="hidden lg:block" />
        )}
        <div role="cell" className="hidden lg:block lg:pt-1.5">
          <StatusCell lead={lead} showDetail={!!lead.qualification?.reason} />
        </div>
        {/* Mobil eigene Zeile unter der Begründung, auf dem Desktop unter dem Status (nächste Grid-Zeile, Spalte 4). */}
        {qualify && (
          <div role="cell" className="col-span-2 flex flex-wrap items-center gap-2 lg:col-span-1 lg:col-start-4 lg:pt-2">
            {/* Erst das Profil ansehen, dann selbst entscheiden (Wunsch des Nutzers 15.10.). */}
            {lead.hit.profileUrl && (
              <a
                href={safeHref(lead.hit.profileUrl)}
                target="_blank"
                rel="noreferrer"
                aria-label={`LinkedIn-Profil von ${fullName(lead)} öffnen`}
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
                data-testid="qualify-profile-link"
              >
                LinkedIn <ExternalLink className="h-3 w-3" />
              </a>
            )}
            <QualifyButton lead={lead} onQualify={qualify} />
          </div>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="details"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
          >
            <LeadDetails lead={lead} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function withProtocol(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/** Alles, was zu einem Lead geliefert wurde – zum Prüfen der echten Daten. */
function LeadDetails({ lead }: { lead: PipelineLead }) {
  const { hit, profile, qualification } = lead;
  const category = categoryLabel(lead);
  const rows: Array<[string, ReactNode]> = [
    [
      'KI-Einschätzung',
      category ? (
        <span className="inline-flex items-center gap-2">
          <Pill size="sm" tone={categoryIsQualifying(lead) ? 'good' : 'neutral'}>
            {category}
          </Pill>
          <span className="tabular-nums text-ink-3">{percent(qualification!.confidence)}</span>
        </span>
      ) : null,
    ],
    ['Headline', profile?.headline || hit.headline || null],
    ['Aktuelle Position', profile?.position ? `${profile.position}${profile.companyName ? ` · ${profile.companyName}` : ''}` : null],
    ['Branche', profile?.companyIndustry ?? null],
    ['Standort', profile?.location ?? hit.location],
    ['Kontaktgrad', hit.networkDistance ? `${hit.networkDistance}. Grad` : null],
    [
      'Website',
      profile?.companyWebsite ? (
        <a href={safeHref(withProtocol(profile.companyWebsite))} target="_blank" rel="noreferrer" className="text-accent hover:underline">
          {profile.companyWebsite.replace(/^https?:\/\/(www\.)?/, '')}
        </a>
      ) : null,
    ],
    [
      'LinkedIn',
      hit.profileUrl ? (
        <a
          href={safeHref(hit.profileUrl)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-accent hover:underline"
          data-testid="profile-link"
        >
          Profil öffnen <ExternalLink className="h-3 w-3" />
        </a>
      ) : null,
    ],
    ['Firmenbeschreibung', profile?.companyDescription ?? null],
    ['Warum aussortiert', rejectionText(lead)],
    ['KI-Zusammenfassung', qualification?.summary ?? null],
    ['Meta-Ads', lead.metaAds ? <MetaAdsDetails check={lead.metaAds} /> : null],
    ['Hinweis', lead.metaAds?.state === 'unchecked' || lead.status === 'ads_active' || lead.status === 'rejected' ? null : lead.note],
  ];
  const visible = rows.filter(([, value]) => value !== null && value !== undefined && value !== '');
  return (
    <dl
      className="mb-2 ml-2 mr-2 grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-2.5 border-l border-line py-2 pl-4 text-[13px] sm:grid-cols-[150px_minmax(0,1fr)]"
      data-testid="lead-details"
    >
      {visible.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-3">{label}</dt>
          <dd className="whitespace-pre-line leading-[1.55] text-ink-2">{value}</dd>
        </div>
      ))}
      {!profile && <dd className="text-ink-3 sm:col-span-2">Profil wurde nicht abgerufen – nur Daten aus der Suche.</dd>}
    </dl>
  );
}

/** Stand in der Meta-Werbebibliothek – mit Link zum Selbst-Nachsehen. */
function MetaAdsDetails({ check }: { check: MetaAdsCheck }) {
  const facts: string[] = [];
  if (check.state === 'active' || check.state === 'stopped') {
    facts.push(`${check.ads} eigene ${check.ads === 1 ? 'Anzeige' : 'Anzeigen'}`);
    if (check.state === 'active') facts.push(`${check.activeAds} davon aktiv`);
    if (check.advertiser) facts.push(`Werbetreibender: ${check.advertiser}`);
  }
  if (check.state === 'none') facts.push('In der Werbebibliothek (EU, letzte 12 Monate) keine eigenen Anzeigen');
  return (
    <span className="block" data-testid="meta-ads-details">
      <span className="flex items-center gap-1.5 text-ink">
        <Megaphone className="h-3.5 w-3.5 shrink-0 text-ink-3" />
        {check.state === 'stopped' && check.lastStop ? `Beendet am ${germanDate(check.lastStop)}` : metaAdsLabel(check)}
      </span>
      {facts.length > 0 && <span className="mt-0.5 block text-ink-3">{facts.join(' · ')}</span>}
      {check.note && <span className="mt-0.5 block text-ink-3">{check.note}</span>}
      {check.libraryUrl && (
        <a
          href={safeHref(libraryLink(check.libraryUrl))}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1 text-accent hover:underline"
          data-testid="ad-library-link"
        >
          In der Werbebibliothek ansehen <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </span>
  );
}

function StatusCell({ lead, showDetail = false }: { lead: PipelineLead; showDetail?: boolean }) {
  const view = statusView(lead);
  const detail = statusDetail(lead);
  const dot = { neutral: 'bg-ink-3', good: 'bg-good', warn: 'bg-warn', bad: 'bg-bad', active: 'bg-ink' }[view.tone];
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-[13.5px] font-medium text-ink">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
        {view.label}
      </p>
      {showDetail && detail && <p className="mt-0.5 text-[12px] leading-[1.45] text-ink-3">{detail}</p>}
    </div>
  );
}

/**
 * Erklärung fürs Aussortieren (Wunsch des Nutzers 07.10.): Die Prozentzahl der KI ist die Sicherheit ihrer Einordnung,
 * nicht wie gut der Lead passt – 90 % „Makler“ heißt: ziemlich sicher die falsche Branche.
 */
function rejectionText(lead: PipelineLead): string | null {
  const qualification = lead.qualification;
  if (lead.status !== 'rejected' || !qualification) return null;
  const sure = `${Math.round(qualification.confidence * 100)} %`;
  const why = qualification.reason ? ` Begründung der KI: ${qualification.reason}` : '';
  if (!isQualifyingCategory(qualification.category)) {
    return `Falsche Branche – gesucht sind nur ${TARGET_GROUPS_TEXT}. Die KI ordnet die Firma anders ein (${CATEGORY_LABELS[qualification.category]}) und ist sich dabei zu ${sure} sicher; die ${sure} beziehen sich auf diese Einordnung, nicht auf die Passung.${why}`;
  }
  return `Die Branche passt (${CATEGORY_LABELS[qualification.category]}), aber die KI ist sich nur zu ${sure} sicher oder hält die Firma trotzdem für ungeeignet (z. B. zu klein, Konzern, keine Geschäftsführung, Bauträger ohne eigenen Vertrieb) – Leads gelten erst ab der Mindestsicherheit (Einstellungen → Lead-Suche) als qualifiziert.${why}`;
}

/**
 * „Qualifizieren“: die eigene Einschätzung schlägt die der KI. Kurz bestätigen lassen, was danach passiert – vor der
 * Übergabe zählt der Lead mit, danach liegt er sofort im Tagesstapel.
 */
function QualifyButton({ lead, onQualify }: { lead: PipelineLead; onQualify: QualifyLead }) {
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const click = async () => {
    if (state === 'busy') return;
    setState('busy');
    setError(null);
    try {
      await onQualify(lead.id);
      // Die Zeile wechselt danach in „Qualifiziert“ – der Knopf verschwindet von selbst.
    } catch (caught) {
      setState('error');
      setError(caught instanceof Error && caught.message ? caught.message : 'Hat nicht geklappt.');
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {error && (
        <span role="alert" className="text-[12.5px] text-ink-2">
          {error}
        </span>
      )}
      <button
        type="button"
        onClick={() => void click()}
        disabled={state === 'busy'}
        aria-label={`${fullName(lead)} von Hand qualifizieren`}
        className="inline-flex h-8 items-center gap-1.5 rounded-full bg-surface-3 px-3 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-surface-4 hover:text-ink disabled:opacity-60"
        data-testid="qualify-manually"
      >
        <Check className="h-3.5 w-3.5" strokeWidth={2.6} />
        {state === 'busy' ? 'Wird qualifiziert …' : 'Qualifizieren'}
      </button>
    </span>
  );
}
