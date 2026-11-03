import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { AccountsPage } from './components/accounts/AccountsPage';
import { DashboardView } from './components/dashboard/DashboardView';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { TopNav } from './components/layout/TopNav';
import { LeadPanel } from './components/lead/LeadPanel';
import { LeadSearchProvider } from './components/leadSearch/LeadSearchProvider';
import { LinkedInProvider } from './state/linkedin';
import { TemplatesProvider } from './state/templates';
import { LeadSearchView } from './components/leadSearch/LeadSearchView';
import { LeadsView } from './components/leads/LeadsView';
import { ChatsView } from './components/chats/ChatsView';
import { SettingsPage } from './components/settings/SettingsPage';
import { AssistantView } from './components/assistant/AssistantView';
import { ActivityProvider } from './components/stack/ActivityToasts';
import { FocusView } from './components/stack/FocusView';
import { HomeView } from './components/stack/HomeView';
import { INVITE_PATH, REGISTER_PATH, authRole } from '../shared/auth';
import { Invite, readInviteToken } from './pages/Invite';
import { Connecting, Login } from './pages/Login';
import { SetupWizard } from './components/onboarding/SetupWizard';
import { WaitingForApproval } from './components/onboarding/WaitingForApproval';
import { WorkIntro } from './components/onboarding/WorkIntro';
import { sessionFounderOf, useAuth } from './state/auth';
import { readStackScope, useDemo } from './state/demo';
import { EASE_OUT } from './lib/motion';
import { McpConsent } from './components/mcp/McpConsent';
import { MCP_CONSENT_PARAM, MCP_LEAD_PARAM } from '../shared/mcp';

/** Wert eines Query-Parameters aus der Adresse (Freigabe für die Claude-App, Lead-Links). */
function queryParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name) || null;
}

/** Query-Parameter aus der Adresse nehmen, ohne neu zu laden. */
function dropQueryParam(name: string) {
  const url = new URL(window.location.href);
  url.searchParams.delete(name);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

export function App() {
  const { state, dispatch } = useDemo();
  const { auth, adminFounder } = useAuth();
  // Admin-Konten haben keinen eigenen Gründer – sie sehen die Aufgaben des gewählten Gründers. Mitarbeiter mit
  // mehreren Gründern ebenso (nur ihre). Noch nicht freigegebene Konten: keinen.
  const sessionFounder = auth.status === 'authenticated' ? sessionFounderOf(auth.user, adminFounder) : null;
  // Vor dem Cockpit: Warten auf Freigabe, Einrichtung (erstes Konto) oder Einarbeitung (neue Konten).
  const gate =
    auth.status !== 'authenticated'
      ? null
      : auth.user.awaitingApproval
        ? 'waiting'
        : auth.user.onboarding === 'setup'
          ? 'setup'
          : auth.user.onboarding === 'intro'
            ? 'intro'
            : null;
  // Einladungslink (/einladung#token): eigene Seite, bis das Passwort steht oder man zur Anmeldung geht.
  const [inviteToken, setInviteToken] = useState(readInviteToken);
  // Zählt jeden neu geöffneten Link – als Key, damit die Einladungsseite neu prüft.
  const [inviteRun, setInviteRun] = useState(0);
  // Freigabe für die Claude-App (`/?mcp_consent=<id>`): bleibt in der Adresse, bis entschieden ist – auch über die Anmeldung.
  const [mcpConsent, setMcpConsent] = useState(() => queryParam(MCP_CONSENT_PARAM));
  const leaveConsent = useCallback(() => {
    dropQueryParam(MCP_CONSENT_PARAM);
    setMcpConsent(null);
  }, []);
  // Token sofort aus der Adresse nehmen (Verlauf, Screenshots) – es bleibt nur im Speicher.
  useEffect(() => {
    if (inviteToken) window.history.replaceState(null, '', `${INVITE_PATH}${window.location.search}`);
  }, [inviteToken]);
  // Neuer Link im selben Tab: Nur das Fragment ändert sich, die Seite lädt nicht neu.
  useEffect(() => {
    const onHashChange = () => {
      const token = readInviteToken();
      if (!token) return;
      window.history.replaceState(null, '', `${INVITE_PATH}${window.location.search}`);
      setInviteToken(token);
      setInviteRun((run) => run + 1);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const leaveInvite = useCallback(() => {
    // Adresse zurück auf die Startseite – so bleibt das Token nicht im Verlauf des Browsers stehen.
    window.history.replaceState(null, '', `/${window.location.search}`);
    setInviteToken(null);
  }, []);

  // Nach dem Registrieren nicht auf /registrieren stehen bleiben (Neuladen zeigt sonst wieder das Formular).
  useEffect(() => {
    if (auth.status === 'authenticated' && window.location.pathname === REGISTER_PATH) {
      window.history.replaceState(null, '', `/${window.location.search}`);
    }
  }, [auth.status]);

  // Mit echtem Login bestimmt die Sitzung den Gründer – auch nach abgelaufener Sitzung.
  useEffect(() => {
    if (sessionFounder && state.founder !== sessionFounder) {
      // „Alle“ gibt es nur für Gründer-Konten (Admin und Mitarbeiter wechseln den Gründer oben im Menü).
      const ownFounder = auth.status === 'authenticated' && authRole(auth.user) === 'founder';
      dispatch({ type: 'LOGIN', founder: sessionFounder, scope: ownFounder ? readStackScope(sessionFounder) : 'mine' });
    }
    else if (auth.status === 'anonymous' && state.founder) dispatch({ type: 'LOGOUT' });
  }, [auth.status, sessionFounder, state.founder, dispatch]);

  const showShell = auth.status === 'disabled' ? !!state.founder : !!sessionFounder && state.founder === sessionFounder;
  const screen =
    inviteToken !== null ? 'invite' : auth.status === 'checking' ? 'checking' : gate ? gate : showShell ? (mcpConsent ? 'consent' : 'app') : 'login';
  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence mode="wait">
        <motion.div
          key={screen === 'app' ? `app-${state.generation}-${state.founder}` : screen === 'invite' ? `invite-${inviteRun}` : `${screen}-${state.generation}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
        >
          {/* Während der Sitzungsprüfung erst nichts (kein Aufblitzen der Anmeldung), nach kurzer Zeit „Verbinde …“. */}
          {screen === 'invite' ? (
            <Invite key={inviteRun} token={inviteToken ?? ''} onDone={leaveInvite} />
          ) : screen === 'waiting' && auth.status === 'authenticated' ? (
            <WaitingForApproval name={auth.user.name} />
          ) : screen === 'setup' && auth.status === 'authenticated' ? (
            <SetupWizard user={auth.user} />
          ) : screen === 'intro' && auth.status === 'authenticated' ? (
            <WorkIntro user={auth.user} />
          ) : screen === 'consent' && mcpConsent ? (
            <McpConsent id={mcpConsent} onDone={leaveConsent} />
          ) : screen === 'app' ? (
            <Shell />
          ) : screen === 'login' ? (
            <Login />
          ) : (
            <Connecting />
          )}
        </motion.div>
      </AnimatePresence>
    </MotionConfig>
  );
}

function Shell() {
  const { state, dispatch } = useDemo();
  const founder = state.founder;

  // Lead-Link aus der Claude-App (`/?lead=<id>`): Lead öffnen und den Parameter aus der Adresse nehmen.
  useEffect(() => {
    const leadId = queryParam(MCP_LEAD_PARAM);
    if (!leadId) return;
    dropQueryParam(MCP_LEAD_PARAM);
    dispatch({ type: 'OPEN_PANEL', leadId });
  }, [dispatch]);

  // Neue Ansicht beginnt oben (wie ein Tab-Wechsel in einer App) – nicht auf der Scrollhöhe der vorigen.
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [state.view]);

  // Nach Abmelden/Reset blendet die Hülle noch kurz aus – dann gibt es keinen Gründer mehr.
  if (!founder) return null;

  return (
    <LeadSearchProvider>
      <LinkedInProvider>
      <TemplatesProvider>
      <ActivityProvider>
        <AnimatePresence mode="wait" initial={false}>
          {state.view === 'focus' ? (
            <motion.div
              key="focus"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              // Ausblenden fast sofort: Bis es fertig ist, wartet die neue Ansicht (mode="wait") – Eingaben
              // sollen nicht spürbar ins Leere gehen. Überlappen geht nicht, sonst hörten beide Ansichten auf Kürzel.
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              transition={{ duration: 0.28, ease: EASE_OUT }}
            >
              <ErrorBoundary>
                <FocusView />
              </ErrorBoundary>
            </motion.div>
          ) : (
            <motion.div
              key="app"
              className="min-h-dvh"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              transition={{ duration: 0.22 }}
            >
              <TopNav />
              {/* Ansichtswechsel nur einblenden, ohne auf das Ausblenden der alten zu warten: Bei schnellem Hin- und
                  Herklicken konnte das Warten hängen bleiben und die Seite blieb leer. */}
              {/* Unten Platz für die Tab-Leiste (nur Handy, sonst 0). */}
              <motion.main
                key={state.view}
                className="pb-[var(--nav-bottom)]"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: EASE_OUT }}
              >
                <ErrorBoundary resetKey={state.view}>
                  {state.view === 'home' ? (
                    <HomeView />
                  ) : state.view === 'search' ? (
                    <LeadSearchView />
                  ) : state.view === 'leads' ? (
                    <LeadsView />
                  ) : state.view === 'chats' ? (
                    <ChatsView />
                  ) : state.view === 'assistant' ? (
                    <AssistantView />
                  ) : state.view === 'settings' ? (
                    <SettingsPage />
                  ) : state.view === 'accounts' ? (
                    <AccountsPage />
                  ) : (
                    <DashboardView />
                  )}
                </ErrorBoundary>
              </motion.main>
            </motion.div>
          )}
        </AnimatePresence>
        <LeadPanel />
      </ActivityProvider>
      </TemplatesProvider>
      </LinkedInProvider>
    </LeadSearchProvider>
  );
}

