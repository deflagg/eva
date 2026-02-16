import React from 'react';
import ReactDOM from 'react-dom/client';

import { captureJpegFrame, isCameraSupported, startCamera, stopCamera } from './camera';
import { encodeBinaryFrameEnvelope } from './frameBinary';
import { clearOverlay, drawDetectionsOverlay } from './overlay';
import type { DetectionsMessage, FrameBinaryMeta } from './types';
import { createEvaWsClient, getEvaWsUrl, type EvaWsClient, type WsConnectionStatus } from './ws';

type LogDirection = 'system' | 'outgoing' | 'incoming';
type CameraStatus = 'idle' | 'starting' | 'running' | 'error';

interface LogEntry {
  id: number;
  ts: string;
  direction: LogDirection;
  text: string;
}

interface InFlightFrame {
  frameId: string;
  sentAt: number;
  timeoutId: number;
}

const STATUS_COLOR: Record<WsConnectionStatus, string> = {
  disconnected: '#b91c1c',
  connecting: '#92400e',
  connected: '#166534',
};

const CAMERA_STATUS_COLOR: Record<CameraStatus, string> = {
  idle: '#374151',
  starting: '#92400e',
  running: '#166534',
  error: '#b91c1c',
};

const FRAME_TIMEOUT_MS = 500;
const FRAME_LOOP_INTERVAL_MS = 100;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function shouldSampleFrameLog(count: number): boolean {
  return count <= 3 || count % 10 === 0;
}

function summarizeMessage(message: unknown): string {
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

function getFrameId(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const candidate = (message as Record<string, unknown>).frame_id;
  return typeof candidate === 'string' ? candidate : undefined;
}

function isDetectionsMessage(message: unknown): message is DetectionsMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  return (
    candidate.type === 'detections' &&
    candidate.v === 1 &&
    typeof candidate.frame_id === 'string' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    Array.isArray(candidate.detections)
  );
}

function App(): JSX.Element {
  const [status, setStatus] = React.useState<WsConnectionStatus>('connecting');
  const [logs, setLogs] = React.useState<LogEntry[]>([]);
  const [connectionAttempt, setConnectionAttempt] = React.useState(0);

  const [cameraStatus, setCameraStatus] = React.useState<CameraStatus>('idle');
  const [cameraError, setCameraError] = React.useState<string | null>(null);
  const [streamingEnabled, setStreamingEnabled] = React.useState(false);

  const [framesSent, setFramesSent] = React.useState(0);
  const [framesAcked, setFramesAcked] = React.useState(0);
  const [framesTimedOut, setFramesTimedOut] = React.useState(0);
  const [lastAckLatencyMs, setLastAckLatencyMs] = React.useState<number | null>(null);
  const [inFlightFrameId, setInFlightFrameId] = React.useState<string | null>(null);
  const [lastDetectionsCount, setLastDetectionsCount] = React.useState(0);
  const [lastDetectionsModel, setLastDetectionsModel] = React.useState<string | null>(null);

  const cameraSupported = React.useMemo(() => isCameraSupported(), []);

  const clientRef = React.useRef<EvaWsClient | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const captureCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const nextLogIdRef = React.useRef(1);
  const inFlightRef = React.useRef<InFlightFrame | null>(null);
  const captureInProgressRef = React.useRef(false);

  const frameLoopTimerRef = React.useRef<number | null>(null);
  const framesSentRef = React.useRef(0);
  const framesAckedRef = React.useRef(0);
  const framesTimedOutRef = React.useRef(0);

  const appendLog = React.useCallback((direction: LogDirection, text: string) => {
    const entry: LogEntry = {
      id: nextLogIdRef.current,
      ts: new Date().toLocaleTimeString(),
      direction,
      text,
    };

    nextLogIdRef.current += 1;
    setLogs((prev) => [...prev.slice(-199), entry]);
  }, []);

  const dropInFlight = React.useCallback(
    (reason: string) => {
      const inFlight = inFlightRef.current;
      if (!inFlight) {
        return;
      }

      window.clearTimeout(inFlight.timeoutId);
      inFlightRef.current = null;
      setInFlightFrameId(null);
      appendLog('system', `${reason} (${inFlight.frameId}).`);
    },
    [appendLog],
  );

  const clearOverlayCanvas = React.useCallback(() => {
    const overlayCanvas = overlayCanvasRef.current;
    if (!overlayCanvas) {
      return;
    }

    clearOverlay(overlayCanvas);
  }, []);

  const renderDetections = React.useCallback(
    (message: DetectionsMessage) => {
      const videoElement = videoRef.current;
      const overlayCanvas = overlayCanvasRef.current;
      if (!videoElement || !overlayCanvas) {
        return;
      }

      drawDetectionsOverlay(videoElement, overlayCanvas, message);
      setLastDetectionsCount(message.detections.length);
      setLastDetectionsModel(message.model);
    },
    [],
  );

  React.useEffect(() => {
    const client = createEvaWsClient({
      onOpen: () => {
        setStatus('connected');
        appendLog('system', 'Connected to Eva WebSocket endpoint.');
      },
      onClose: () => {
        setStatus('disconnected');
        dropInFlight('Dropped in-flight frame: socket disconnected');
        appendLog('system', 'Disconnected from Eva WebSocket endpoint.');
      },
      onMessage: (message) => {
        const frameId = getFrameId(message);
        const inFlight = inFlightRef.current;
        const detectionsMessage = isDetectionsMessage(message) ? message : null;

        if (detectionsMessage) {
          renderDetections(detectionsMessage);
        }

        if (frameId && inFlight && frameId === inFlight.frameId) {
          window.clearTimeout(inFlight.timeoutId);
          inFlightRef.current = null;
          setInFlightFrameId(null);

          const latencyMs = Date.now() - inFlight.sentAt;
          framesAckedRef.current += 1;
          setFramesAcked(framesAckedRef.current);
          setLastAckLatencyMs(latencyMs);

          if (shouldSampleFrameLog(framesAckedRef.current)) {
            appendLog('incoming', summarizeMessage(message));
            appendLog('system', `Frame acknowledged in ${latencyMs}ms.`);
          }

          return;
        }

        appendLog('incoming', summarizeMessage(message));
      },
      onParseError: (raw) => {
        appendLog('system', `Received non-JSON message: ${raw}`);
      },
      onError: () => {
        appendLog('system', 'WebSocket error occurred.');
      },
    });

    clientRef.current = client;
    setStatus('connecting');
    appendLog('system', `Connecting to ${getEvaWsUrl()} ...`);
    client.connect();

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [appendLog, connectionAttempt, dropInFlight, renderDetections]);

  const handleSendTestMessage = React.useCallback(() => {
    const payload = {
      type: 'ui_test',
      v: 1,
      ts_ms: Date.now(),
      payload: 'hello-from-ui',
    };

    const sent = clientRef.current?.sendJson(payload) ?? false;
    if (sent) {
      appendLog('outgoing', summarizeMessage(payload));
      return;
    }

    appendLog('system', 'Cannot send test message while disconnected.');
  }, [appendLog]);

  const handleReconnect = React.useCallback(() => {
    appendLog('system', 'Reconnect requested.');
    setConnectionAttempt((prev) => prev + 1);
  }, [appendLog]);

  const handleClearLogs = React.useCallback(() => {
    setLogs([]);
  }, []);

  const handleStartCamera = React.useCallback(async () => {
    if (!cameraSupported) {
      setCameraStatus('error');
      setCameraError('Camera API is unavailable in this browser.');
      appendLog('system', 'Camera API is unavailable in this browser.');
      return;
    }

    if (cameraStatus === 'starting' || cameraStatus === 'running') {
      return;
    }

    const videoElement = videoRef.current;
    if (!videoElement) {
      appendLog('system', 'Video element is not ready yet.');
      return;
    }

    setCameraStatus('starting');
    setCameraError(null);

    try {
      const stream = await startCamera(videoElement);
      streamRef.current = stream;

      clearOverlayCanvas();
      setLastDetectionsCount(0);
      setLastDetectionsModel(null);

      setCameraStatus('running');
      appendLog('system', 'Camera started successfully.');
    } catch (error) {
      const message = toErrorMessage(error);
      setCameraStatus('error');
      setCameraError(message);
      appendLog('system', `Failed to start camera: ${message}`);
    }
  }, [appendLog, cameraStatus, cameraSupported, clearOverlayCanvas]);

  const handleStopCamera = React.useCallback(() => {
    setStreamingEnabled(false);
    dropInFlight('Dropped in-flight frame: camera stopped');

    stopCamera(streamRef.current);
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    clearOverlayCanvas();
    setLastDetectionsCount(0);
    setLastDetectionsModel(null);

    setCameraStatus('idle');
    setCameraError(null);
    appendLog('system', 'Camera stopped.');
  }, [appendLog, clearOverlayCanvas, dropInFlight]);

  const handleToggleStreaming = React.useCallback(() => {
    if (!streamingEnabled) {
      if (cameraStatus !== 'running') {
        appendLog('system', 'Start camera before enabling streaming.');
        return;
      }

      setStreamingEnabled(true);
      appendLog('system', 'Frame streaming started (max 1 in-flight).');
      return;
    }

    setStreamingEnabled(false);
    dropInFlight('Dropped in-flight frame: streaming paused');
    appendLog('system', 'Frame streaming paused.');
  }, [appendLog, cameraStatus, dropInFlight, streamingEnabled]);

  const trySendFrame = React.useCallback(async () => {
    if (!streamingEnabled || cameraStatus !== 'running') {
      return;
    }

    if (captureInProgressRef.current || inFlightRef.current) {
      return;
    }

    const client = clientRef.current;
    if (!client || client.getStatus() !== 'connected') {
      return;
    }

    const videoElement = videoRef.current;
    const captureCanvas = captureCanvasRef.current;
    if (!videoElement || !captureCanvas) {
      return;
    }

    captureInProgressRef.current = true;

    try {
      const capturedFrame = await captureJpegFrame(videoElement, captureCanvas);
      if (!capturedFrame) {
        return;
      }

      const frameId = crypto.randomUUID();
      const frameMeta: FrameBinaryMeta = {
        type: 'frame_binary',
        v: 1,
        frame_id: frameId,
        ts_ms: Date.now(),
        mime: capturedFrame.mime,
        width: capturedFrame.width,
        height: capturedFrame.height,
        image_bytes: capturedFrame.image_bytes.byteLength,
      };

      const binaryEnvelope = encodeBinaryFrameEnvelope({
        meta: frameMeta,
        imageBytes: capturedFrame.image_bytes,
      });

      const sent = client.sendBinary(binaryEnvelope);
      if (!sent) {
        return;
      }

      const timeoutId = window.setTimeout(() => {
        const inFlight = inFlightRef.current;
        if (!inFlight || inFlight.frameId !== frameId) {
          return;
        }

        inFlightRef.current = null;
        setInFlightFrameId(null);

        framesTimedOutRef.current += 1;
        setFramesTimedOut(framesTimedOutRef.current);
        appendLog('system', `Frame timed out after ${FRAME_TIMEOUT_MS}ms (dropped): ${frameId}`);
      }, FRAME_TIMEOUT_MS);

      inFlightRef.current = {
        frameId,
        sentAt: Date.now(),
        timeoutId,
      };
      setInFlightFrameId(frameId);

      framesSentRef.current += 1;
      setFramesSent(framesSentRef.current);

      if (shouldSampleFrameLog(framesSentRef.current)) {
        appendLog(
          'outgoing',
          `frame_binary frame_id=${frameMeta.frame_id} ${frameMeta.width}x${frameMeta.height} bytes=${frameMeta.image_bytes}`,
        );
      }
    } catch (error) {
      appendLog('system', `Frame capture/send failed: ${toErrorMessage(error)}`);
    } finally {
      captureInProgressRef.current = false;
    }
  }, [appendLog, cameraStatus, streamingEnabled]);

  React.useEffect(() => {
    if (!streamingEnabled) {
      if (frameLoopTimerRef.current !== null) {
        window.clearInterval(frameLoopTimerRef.current);
        frameLoopTimerRef.current = null;
      }
      return;
    }

    frameLoopTimerRef.current = window.setInterval(() => {
      void trySendFrame();
    }, FRAME_LOOP_INTERVAL_MS);

    return () => {
      if (frameLoopTimerRef.current !== null) {
        window.clearInterval(frameLoopTimerRef.current);
        frameLoopTimerRef.current = null;
      }
    };
  }, [streamingEnabled, trySendFrame]);

  React.useEffect(() => {
    return () => {
      if (frameLoopTimerRef.current !== null) {
        window.clearInterval(frameLoopTimerRef.current);
      }

      const inFlight = inFlightRef.current;
      if (inFlight) {
        window.clearTimeout(inFlight.timeoutId);
      }

      stopCamera(streamRef.current);
      streamRef.current = null;
      clearOverlayCanvas();
    };
  }, [clearOverlayCanvas]);

  return (
    <main style={{ fontFamily: 'sans-serif', padding: 16, lineHeight: 1.4 }}>
      <h1>Eva UI (Iteration 9)</h1>

      <p>
        WebSocket target: <code>{getEvaWsUrl()}</code>
      </p>
      <p>
        Connection status:{' '}
        <strong style={{ color: STATUS_COLOR[status], textTransform: 'capitalize' }}>{status}</strong>
      </p>

      <p>
        Camera support: <strong>{cameraSupported ? 'yes' : 'no'}</strong> · Camera status:{' '}
        <strong style={{ color: CAMERA_STATUS_COLOR[cameraStatus], textTransform: 'capitalize' }}>
          {cameraStatus}
        </strong>{' '}
        · Streaming: <strong>{streamingEnabled ? 'on' : 'off'}</strong>
      </p>

      {cameraError ? (
        <p style={{ color: '#b91c1c' }}>
          <strong>Camera error:</strong> {cameraError}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button type="button" onClick={handleSendTestMessage} disabled={status !== 'connected'}>
          Send test message
        </button>
        <button type="button" onClick={handleReconnect}>
          Reconnect
        </button>
        <button type="button" onClick={handleStartCamera} disabled={!cameraSupported || cameraStatus === 'running'}>
          Start camera
        </button>
        <button type="button" onClick={handleStopCamera} disabled={cameraStatus !== 'running'}>
          Stop camera
        </button>
        <button type="button" onClick={handleToggleStreaming} disabled={cameraStatus !== 'running'}>
          {streamingEnabled ? 'Pause streaming' : 'Start streaming'}
        </button>
        <button type="button" onClick={handleClearLogs}>
          Clear logs
        </button>
      </div>

      <section style={{ marginBottom: 16 }}>
        <h2 style={{ marginBottom: 8 }}>Camera preview</h2>
        <div
          style={{
            position: 'relative',
            width: '100%',
            maxWidth: 640,
            borderRadius: 6,
            border: '1px solid #ddd',
            background: '#111',
            overflow: 'hidden',
          }}
        >
          <video ref={videoRef} autoPlay muted playsInline style={{ width: '100%', display: 'block' }} />
          <canvas
            ref={overlayCanvasRef}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'none',
            }}
          />
        </div>
        <canvas ref={captureCanvasRef} style={{ display: 'none' }} />
        <p style={{ marginTop: 8 }}>
          Frames sent: <strong>{framesSent}</strong> · acknowledged: <strong>{framesAcked}</strong> · timed out:{' '}
          <strong>{framesTimedOut}</strong> · in-flight: <strong>{inFlightFrameId ? 'yes' : 'no'}</strong> · detections:{' '}
          <strong>{lastDetectionsCount}</strong>
          {lastDetectionsModel ? (
            <>
              {' '}
              · model: <strong>{lastDetectionsModel}</strong>
            </>
          ) : null}
          {lastAckLatencyMs !== null ? (
            <>
              {' '}
              · last ack latency: <strong>{lastAckLatencyMs}ms</strong>
            </>
          ) : null}
        </p>
      </section>

      <section>
        <h2 style={{ marginBottom: 8 }}>Log panel</h2>
        <div
          style={{
            border: '1px solid #ddd',
            borderRadius: 6,
            backgroundColor: '#fafafa',
            padding: 12,
            minHeight: 240,
            maxHeight: 360,
            overflow: 'auto',
          }}
        >
          {logs.length === 0 ? (
            <p style={{ margin: 0 }}>No messages yet.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {logs.map((entry) => (
                <li key={entry.id}>
                  <code>{entry.ts}</code> <strong>[{entry.direction}]</strong> {entry.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
