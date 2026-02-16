import React from 'react';
import ReactDOM from 'react-dom/client';

import { connectEvaWs, type EvaWsClient, type WsConnectionState } from './ws';

const EVA_WS_URL = import.meta.env.VITE_EVA_WS_URL ?? 'ws://localhost:8787/eye';

function statusColor(status: WsConnectionState): string {
  switch (status) {
    case 'connected':
      return '#147d14';
    case 'connecting':
      return '#8a6d00';
    case 'disconnected':
      return '#9d2525';
  }
}

function App(): JSX.Element {
  const [status, setStatus] = React.useState<WsConnectionState>('connecting');
  const [logs, setLogs] = React.useState<string[]>([]);
  const clientRef = React.useRef<EvaWsClient | null>(null);

  const appendLog = React.useCallback((line: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((current) => [`[${timestamp}] ${line}`, ...current].slice(0, 100));
  }, []);

  React.useEffect(() => {
    appendLog(`connecting to ${EVA_WS_URL}`);

    const client = connectEvaWs(EVA_WS_URL, {
      onStatus: (nextStatus) => {
        setStatus(nextStatus);
        appendLog(`status=${nextStatus}`);
      },
      onMessage: (raw) => {
        appendLog(`recv ${raw}`);
      },
      onError: (message) => {
        appendLog(`error ${message}`);
      }
    });

    clientRef.current = client;

    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [appendLog]);

  const sendTestMessage = React.useCallback(() => {
    const payload = {
      type: 'ui_test',
      v: 1,
      ts_ms: Date.now(),
      note: 'iteration-2 test message'
    };

    const sent = clientRef.current?.sendJson(payload) ?? false;
    appendLog(`${sent ? 'sent' : 'drop'} ${JSON.stringify(payload)}`);
  }, [appendLog]);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 900, margin: '0 auto' }}>
      <h1>Eva UI</h1>

      <section style={{ marginBottom: 16 }}>
        <div>
          <strong>WebSocket:</strong> <code>{EVA_WS_URL}</code>
        </div>
        <div>
          <strong>Status:</strong>{' '}
          <span style={{ color: statusColor(status), textTransform: 'uppercase', fontWeight: 700 }}>{status}</span>
        </div>
      </section>

      <section style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button type="button" onClick={sendTestMessage}>
          Send test message
        </button>
      </section>

      <section>
        <h2 style={{ marginBottom: 8 }}>Logs</h2>
        <pre
          style={{
            background: '#111',
            color: '#c7f4c7',
            borderRadius: 8,
            padding: 12,
            minHeight: 320,
            overflow: 'auto',
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {logs.length > 0 ? logs.join('\n') : 'No events yet.'}
        </pre>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
