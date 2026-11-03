import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '../ui/Button';

interface Props {
  children: ReactNode;
  /** Ändert sich der Wert (z. B. die Ansicht), startet die Anzeige neu – ein Fehler hängt dann nicht mehr fest. */
  resetKey?: unknown;
  /** true = ganze Seite (Fallback für die App), sonst nur der Inhaltsbereich. */
  fullPage?: boolean;
}

interface State {
  error: Error | null;
  /** Wo in der Oberfläche der Fehler passierte (Komponenten-Stack von React). */
  where: string | null;
  copied: boolean;
}

/** Bericht zum Kopieren: Meldung, Stack (Datei:Zeile:Spalte im Build – lässt sich auf den Quelltext abbilden), Ort, Browser. */
function report(error: Error, where: string | null): string {
  const stack = (error.stack ?? '').split('\n').slice(0, 8).join('\n');
  const components = (where ?? '').trim().split('\n').slice(0, 8).map((line) => line.trim()).join('\n');
  return [`Fehler: ${error.message}`, `Seite: ${window.location.pathname}`, `Browser: ${navigator.userAgent}`, '', stack, '', components].join('\n');
}

/**
 * Fängt Fehler beim Anzeigen ab. Ohne das räumt React bei einem Fehler die ganze Seite ab – übrig bliebe ein
 * schwarzer Bildschirm, bis man neu lädt. Typische Ursache: Browser-Übersetzung oder Erweiterungen, die den
 * Seiteninhalt verändern.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, where: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, copied: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Anzeigefehler', error, info.componentStack);
    this.setState({ where: info.componentStack ?? null });
  }

  componentDidUpdate(previous: Props) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.reset();
  }

  private reset = () => this.setState({ error: null, where: null, copied: false });

  private copy = () => {
    const { error, where } = this.state;
    if (!error) return;
    void navigator.clipboard?.writeText(report(error, where)).then(
      () => this.setState({ copied: true }),
      () => undefined,
    );
  };

  render() {
    const { error, where, copied } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        data-testid="error-boundary"
        className={
          this.props.fullPage
            ? 'flex min-h-dvh flex-col items-center justify-center px-4 text-center'
            : 'mx-auto flex max-w-[520px] flex-col items-center px-4 py-24 text-center'
        }
      >
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Da ist etwas schiefgegangen.</h1>
        <p className="mt-3 text-[14.5px] leading-[1.6] text-ink-2">
          Die Ansicht konnte nicht angezeigt werden. Nutzt du die automatische Übersetzung von Chrome oder eine
          Erweiterung, die Seiten verändert? Dann schalte sie für diese Seite bitte aus.
        </p>
        <p className="mt-3 max-w-full break-words font-mono text-[12px] text-ink-3">{error.message}</p>
        <details className="mt-3 w-full max-w-[560px] text-left">
          <summary className="cursor-pointer text-center text-[12.5px] text-ink-3 hover:text-ink-2">Details für die Fehlersuche</summary>
          <pre className="scroll-thin mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-2 p-3 font-mono text-[11px] leading-[1.5] text-ink-3" data-testid="error-details">
            {report(error, where)}
          </pre>
        </details>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Button variant="ghost" size="lg" onClick={this.copy} data-testid="error-copy">
            {copied ? 'Kopiert' : 'Fehlerbericht kopieren'}
          </Button>
          <Button variant="outline" size="lg" onClick={this.reset}>
            Erneut versuchen
          </Button>
          <Button variant="primary" size="lg" onClick={() => window.location.reload()}>
            Seite neu laden
          </Button>
        </div>
      </div>
    );
  }
}
