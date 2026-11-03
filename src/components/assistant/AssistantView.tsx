import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, Check, ChevronDown, ChevronLeft, History, Plug, Plus, Sparkles, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ASSISTANT_SUGGESTIONS,
  type AssistantChatDetail,
  type AssistantChatSummary,
  type AssistantMessage,
  type AssistantModel,
  type AssistantToolUse,
} from '../../../shared/assistant';
import { cn } from '../../lib/cn';
import { useMediaQuery } from '../../lib/gesture';
import { ApiError, assistantApi } from '../../lib/leadSearchApi';
import { SPRING_MENU } from '../../lib/motion';
import { formatRelative } from '../../lib/time';
import { useDemo } from '../../state/demo';
import { Spinner } from '../leadSearch/Funnel';
import { Button } from '../ui/Button';
import { McpConnections } from '../mcp/McpConnections';
import { Markdown } from './Markdown';

/**
 * KI-Assistent (Wunsch des Nutzers 22.10., Vertrag `shared/assistant.ts`): Chat wie ChatGPT mit Lesezugriff auf alle
 * Outreach-Daten. Links die Chats des Kontos, oben die Modellwahl (Claude-Modelle laut Anthropic), unten die Eingabe
 * (↵ senden, ⇧↵ neue Zeile). Die Antwort kommt als Stream; was der Assistent dafür liest, steht darüber („Liest …“).
 * Wechselt man während einer Antwort die Ansicht, läuft sie im Backend weiter und steht beim Zurückkommen da.
 */

const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Eine Frage ohne Antwort, jünger als das: die Antwort läuft wohl noch im Backend – nachsehen. */
const RUNNING_GRACE_MS = 15 * 60 * 1000;
const POLL_MS = 3000;

interface Live {
  question: string;
  text: string;
  tools: AssistantToolUse[];
}

export function AssistantView() {
  const { dispatch } = useDemo();
  const stacked = useMediaQuery('(max-width: 767px)');
  const [models, setModels] = useState<AssistantModel[]>([]);
  // Dialog „Claude-App verbinden“ (MCP-Server, `shared/mcp.ts`)
  const [mcpOpen, setMcpOpen] = useState(false);
  const [defaultModel, setDefaultModel] = useState('claude-opus-5-5');
  const [chats, setChats] = useState<AssistantChatSummary[] | null>(null);
  const [chat, setChat] = useState<AssistantChatDetail | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  const loadChats = useCallback(async () => {
    try {
      const response = await assistantApi.list();
      if (mounted.current) setChats(response.chats);
    } catch {
      if (mounted.current) setChats((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void loadChats();
    assistantApi
      .models()
      .then((response) => {
        if (!mounted.current) return;
        setModels(response.models);
        setDefaultModel(response.defaultModel);
      })
      .catch(() => {});
  }, [loadChats]);

  const openChat = useCallback(async (id: string) => {
    setError(null);
    setHistoryOpen(false);
    try {
      const detail = await assistantApi.get(id);
      if (!mounted.current) return;
      setChat(detail);
      setModel(detail.model);
    } catch (caught) {
      if (mounted.current) setError(caught instanceof ApiError ? caught.message : 'Der Chat konnte nicht geladen werden.');
    }
  }, []);

  const newChat = () => {
    setChat(null);
    setLive(null);
    setError(null);
    setHistoryOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // Antwort läuft noch im Backend (Ansicht gewechselt, Seite neu geladen): nachsehen, bis sie da ist.
  const last = chat?.messages.at(-1);
  const pendingInBackend = !live && !!chat && last?.role === 'user' && Date.now() - last.at < RUNNING_GRACE_MS;
  useEffect(() => {
    if (!pendingInBackend || !chat) return;
    const timer = window.setInterval(() => void openChat(chat.id), POLL_MS);
    return () => window.clearInterval(timer);
  }, [pendingInBackend, chat, openChat]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [chat?.messages.length, live?.text, live?.tools.length]);

  const activeModel = model ?? chat?.model ?? defaultModel;

  const send = async (text = input) => {
    const question = text.trim();
    if (!question || live) return;
    setError(null);
    setInput('');
    setLive({ question, text: '', tools: [] });
    try {
      const target = chat ?? (await assistantApi.create(activeModel));
      if (!chat && mounted.current) setChat(target);
      await assistantApi.ask(target.id, { text: question, model: activeModel }, (event) => {
        if (!mounted.current) return;
        if (event.type === 'tool') setLive((current) => current && { ...current, tools: [...current.tools, event.tool] });
        else if (event.type === 'text') setLive((current) => current && { ...current, text: current.text + event.text });
        else if (event.type === 'error') setError(event.message);
      });
      if (mounted.current) {
        await openChat(target.id);
        await loadChats();
      }
    } catch (caught) {
      if (!mounted.current) return;
      setError(caught instanceof ApiError ? caught.message : 'Die Frage konnte nicht gesendet werden.');
      setInput(question);
    } finally {
      if (mounted.current) setLive(null);
    }
  };

  const stop = () => {
    if (chat) void assistantApi.stop(chat.id).catch(() => {});
  };

  const remove = async (id: string) => {
    if (!window.confirm('Diesen Chat löschen?')) return;
    try {
      await assistantApi.remove(id);
      if (chat?.id === id) newChat();
      await loadChats();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Der Chat konnte nicht gelöscht werden.');
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const openLead = (leadId: string) => dispatch({ type: 'OPEN_PANEL', leadId });
  const messages = chat?.messages ?? [];
  const showList = !stacked || historyOpen;
  const showChat = !stacked || !historyOpen;

  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 pb-6 pt-6 sm:px-10 sm:pt-10" data-testid="assistant-view">
      <McpConnections open={mcpOpen} onClose={() => setMcpOpen(false)} />
      <div className="grid h-[calc(var(--app-h)-48px)] min-h-[480px] grid-cols-1 grid-rows-[minmax(0,1fr)] gap-8 sm:h-[calc(100dvh-72px-80px)] md:grid-cols-[260px_minmax(0,1fr)]">
        {showList && (
          <aside className="flex min-h-0 flex-col" aria-label="KI-Chats">
            {/* Die KI steht seit 25.10. im Dashboard (Reiter „KI fragen“) statt als eigener Tab – hier geht es zurück. */}
            <button
              type="button"
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'dashboard' })}
              className="-ml-1 mb-1 inline-flex min-h-9 items-center gap-0.5 self-start text-[13.5px] font-medium text-ink-2 transition-colors hover:text-ink"
              data-testid="assistant-back"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              Dashboard
            </button>
            <div className="mb-4 flex items-center justify-between gap-2">
              <h1 className="display text-[30px] font-bold leading-[1.1] tracking-[-0.025em]">KI fragen</h1>
              <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={newChat} data-testid="assistant-new">
                Neuer Chat
              </Button>
            </div>
            <ul className="scroll-thin -mx-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto" data-testid="assistant-chats">
              {chats === null ? (
                <li className="px-2 py-2 text-[13px] text-ink-3">Wird geladen …</li>
              ) : chats.length === 0 ? (
                <li className="px-2 py-2 text-[13px] text-ink-3">Noch keine Chats.</li>
              ) : (
                chats.map((entry) => (
                  <li key={entry.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => void openChat(entry.id)}
                      aria-current={chat?.id === entry.id ? 'page' : undefined}
                      className={cn(
                        'w-full rounded-[10px] px-2 py-2 pr-8 text-left transition-colors hover:bg-surface-3',
                        chat?.id === entry.id && 'bg-surface-3',
                      )}
                      data-testid="assistant-chat-item"
                    >
                      <span className="block truncate text-[13.5px] text-ink">{entry.title}</span>
                      <span className="block text-[11.5px] text-ink-3">
                        {formatRelative(entry.updatedAt)}
                        {entry.costEur > 0 ? ` · ${euro.format(entry.costEur)}` : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(entry.id)}
                      aria-label={`Chat „${entry.title}“ löschen`}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-3 opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover:opacity-100 max-md:opacity-100"
                      data-testid="assistant-chat-delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))
              )}
            </ul>
            <button
              type="button"
              onClick={() => setMcpOpen(true)}
              className="mt-3 flex items-center gap-2 rounded-[10px] px-2 py-2 text-left text-[13px] text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
              data-testid="mcp-open"
            >
              <Plug className="h-3.5 w-3.5" aria-hidden />
              Claude-App verbinden
            </button>
          </aside>
        )}

        {showChat && (
          <section className="flex min-h-0 flex-col" aria-label="Chat mit der KI">
            <header className="flex items-center gap-2 pb-3">
              {stacked && (
                <Button variant="ghost" size="sm" icon={<History className="h-4 w-4" />} onClick={() => setHistoryOpen(true)} aria-label="Frühere Chats" className="px-2" />
              )}
              <ModelPicker models={models} value={activeModel} onChange={setModel} disabled={!!live} />
              {chat && <p className="min-w-0 flex-1 truncate text-right text-[13px] text-ink-3 max-sm:hidden">{chat.title}</p>}
            </header>

            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pr-1" data-testid="assistant-thread">
              {messages.length === 0 && !live ? (
                <EmptyState onPick={(text) => void send(text)} />
              ) : (
                <div className="mx-auto max-w-[760px] space-y-8 pb-6">
                  {messages.map((message) =>
                    message.role === 'user' ? (
                      <Question key={message.id} text={message.text} />
                    ) : (
                      <Answer key={message.id} message={message} modelLabel={models.find((entry) => entry.id === message.model)?.label} onLead={openLead} />
                    ),
                  )}
                  {live && (
                    <>
                      <Question text={live.question} />
                      <LiveAnswer live={live} onLead={openLead} />
                    </>
                  )}
                  {pendingInBackend && (
                    <p className="flex items-center gap-2 text-[13.5px] text-ink-2" data-testid="assistant-pending">
                      <Spinner className="h-3 w-3" /> Die Antwort läuft noch – sie erscheint hier, sobald sie fertig ist.
                    </p>
                  )}
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            <div className="mx-auto w-full max-w-[760px] pt-3">
              {error && (
                <p role="alert" className="mb-2 text-[13px] text-bad" data-testid="assistant-error">
                  {error}
                </p>
              )}
              <div className="flex items-end gap-2 rounded-[18px] bg-surface-3 p-2 pl-4 focus-within:ring-1 focus-within:ring-white/15">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={onKeyDown}
                  rows={1}
                  placeholder="Frag etwas über euren Outreach …"
                  aria-label="Frage an die KI"
                  className="max-h-[200px] min-h-[40px] flex-1 resize-none bg-transparent py-2 text-[16px] text-ink outline-none placeholder:text-ink-4 sm:text-[15px] [field-sizing:content]"
                  data-testid="assistant-input"
                />
                {live ? (
                  <button
                    type="button"
                    onClick={stop}
                    aria-label="Antwort stoppen"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-black transition-colors hover:bg-white"
                    data-testid="assistant-stop"
                  >
                    <Square className="h-3.5 w-3.5 fill-current" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={!input.trim()}
                    aria-label="Senden"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-black transition-colors hover:bg-white disabled:opacity-30"
                    data-testid="assistant-send"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                )}
              </div>
              <p className="mt-2 text-center text-[11.5px] text-ink-3">Liest alle Leads und Nachrichten, ändert nichts · ↵ senden, ⇧↵ neue Zeile</p>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function ModelPicker({ models, value, onChange, disabled }: { models: AssistantModel[]; value: string; onChange: (model: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);
  const label = models.find((model) => model.id === value)?.label ?? value;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-9 items-center gap-1.5 rounded-[10px] px-3 text-[14px] font-semibold text-ink transition-colors hover:bg-surface-3 disabled:opacity-50"
        data-testid="assistant-model"
      >
        <Sparkles className="h-4 w-4 text-ink-2" aria-hidden />
        {label}
        <ChevronDown className="h-3.5 w-3.5 text-ink-3" aria-hidden />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -4, transition: { duration: 0.12 } }}
            transition={SPRING_MENU}
            style={{ transformOrigin: 'top left' }}
            className="scroll-thin absolute left-0 top-11 z-40 max-h-[60vh] w-[260px] overflow-y-auto rounded-[14px] border border-line bg-surface-2 p-1.5 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.85)]"
            data-testid="assistant-model-menu"
          >
            {models.length === 0 && <p className="px-3 py-2 text-[13px] text-ink-3">Modelle werden geladen …</p>}
            {models.map((model) => (
              <button
                key={model.id}
                type="button"
                role="menuitemradio"
                aria-checked={model.id === value}
                onClick={() => {
                  onChange(model.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13.5px] text-ink transition-colors hover:bg-surface-3"
              >
                <span className="flex w-4 justify-center">{model.id === value && <Check className="h-4 w-4" strokeWidth={2.5} />}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{model.label}</span>
                  <span className="block truncate text-[11px] text-ink-3">{model.id}</span>
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="mx-auto flex h-full max-w-[640px] flex-col justify-center py-10" data-testid="assistant-empty">
      <p className="display text-center text-[26px] font-bold tracking-[-0.02em]">Was willst du über euren Outreach wissen?</p>
      <p className="mt-2 text-center text-[14px] text-ink-2">
        Die KI liest alle Gespräche – jede Nachricht in beiden Richtungen – und sagt dir, was wirkt, was nicht und warum. Oder sie findet einen Kunden, wenn
        du nur noch weißt, worüber ihr geschrieben habt.
      </p>
      <div className="mt-6 grid gap-2 sm:grid-cols-2">
        {ASSISTANT_SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onPick(suggestion)}
            className="rounded-[14px] bg-surface-2 px-4 py-3 text-left text-[13.5px] leading-snug text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
            data-testid="assistant-suggestion"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function Question({ text }: { text: string }) {
  return (
    <div className="flex justify-end" data-testid="assistant-question">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-[18px] bg-surface-3 px-4 py-2.5 text-[15px] text-ink">{text}</p>
    </div>
  );
}

function ToolLine({ tools, running }: { tools: AssistantToolUse[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  if (!tools.length && !running) return null;
  const latest = tools.at(-1);
  return (
    <div className="mb-3 text-[12.5px] text-ink-3" data-testid="assistant-tools">
      <button type="button" onClick={() => setOpen((current) => !current)} className="flex items-center gap-1.5 hover:text-ink-2" aria-expanded={open}>
        {running && <Spinner className="h-2.5 w-2.5" />}
        {running ? (latest ? `${latest.label} …` : 'Denkt nach …') : `${tools.length} ${tools.length === 1 ? 'Leseschritt' : 'Leseschritte'}`}
        {tools.length > 0 && <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} aria-hidden />}
      </button>
      {open && (
        <ul className="mt-1.5 space-y-0.5 border-l border-line pl-3">
          {tools.map((tool, index) => (
            <li key={index}>{tool.label}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Answer({ message, modelLabel, onLead }: { message: AssistantMessage; modelLabel?: string; onLead: (leadId: string) => void }) {
  return (
    <div data-testid="assistant-answer">
      <ToolLine tools={message.tools ?? []} running={false} />
      <div className={cn(message.failed && 'text-ink-2')}>
        <Markdown text={message.text} onLead={onLead} />
      </div>
      <p className="mt-2 text-[11.5px] text-ink-3">
        {modelLabel ?? message.model}
        {message.costEur ? ` · ${euro.format(message.costEur)}` : ''}
      </p>
    </div>
  );
}

function LiveAnswer({ live, onLead }: { live: Live; onLead: (leadId: string) => void }) {
  return (
    <div data-testid="assistant-live" aria-live="polite">
      <ToolLine tools={live.tools} running />
      {live.text && <Markdown text={live.text} onLead={onLead} />}
    </div>
  );
}
