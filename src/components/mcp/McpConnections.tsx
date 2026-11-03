import { Check, Copy } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { McpConnectionsResponse } from '../../../shared/mcp';
import { ApiError, mcpApi } from '../../lib/leadSearchApi';
import { formatRelative } from '../../lib/time';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

/**
 * Claude-App verbinden (`shared/mcp.ts`): Adresse für den eigenen Connector zum Kopieren, kurze Anleitung und die
 * eigenen Verbindungen mit „Trennen“.
 */
export function McpConnections({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<McpConnectionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await mcpApi.connections());
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Verbindungen lassen sich nicht laden.');
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Kopieren ging nicht – markiere die Adresse von Hand.');
    }
  };

  const disconnect = async (id: string) => {
    try {
      await mcpApi.disconnect(id);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Trennen hat nicht geklappt.');
    }
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="mcp-title" className="sm:max-w-[520px]">
      <div className="p-6" data-testid="mcp-connections">
        <h2 id="mcp-title" className="text-[20px] font-semibold tracking-[-0.01em]">
          Claude-App verbinden
        </h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          Dann kannst du Claude (Web, Desktop, Handy) fragen „Was liegt heute an?“ – und Claude arbeitet die Aufgaben mit dir ab. In der Claude-App: Einstellungen →
          Connectors → eigenen Connector hinzufügen, diese Adresse eintragen und danach hier im Cockpit zulassen.
        </p>
        <div className="mt-4 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-[10px] border border-line px-3 py-2 text-[13px]" data-testid="mcp-url">
            {data?.url ?? '…'}
          </code>
          <Button size="sm" variant="ghost" icon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} onClick={() => void copy()} disabled={!data}>
            {copied ? 'Kopiert' : 'Kopieren'}
          </Button>
        </div>
        <h3 className="mt-6 text-[13px] font-medium text-ink-3">Verbindungen</h3>
        {error && (
          <p className="mt-2 text-[13.5px] text-ink" role="alert">
            {error}
          </p>
        )}
        <ul className="mt-2 divide-y divide-line" data-testid="mcp-connection-list">
          {data && data.connections.length === 0 && <li className="py-2 text-[13.5px] text-ink-3">Noch keine Verbindung.</li>}
          {data?.connections.map((connection) => (
            <li key={connection.id} className="flex items-center justify-between gap-3 py-2" data-testid="mcp-connection">
              <span className="min-w-0">
                <span className="block truncate text-[14px]">{connection.clientName}</span>
                <span className="block text-[12px] text-ink-3">
                  verbunden {formatRelative(connection.createdAt)}
                  {connection.lastUsedAt ? ` · zuletzt genutzt ${formatRelative(connection.lastUsedAt)}` : ''}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => void disconnect(connection.id)}>
                Trennen
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex justify-end">
          <Button onClick={onClose}>Fertig</Button>
        </div>
      </div>
    </Modal>
  );
}
