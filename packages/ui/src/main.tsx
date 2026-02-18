import React from 'react';
import ReactDOM from 'react-dom/client';

import { captureJpegFrame, isCameraSupported, startCamera, stopCamera } from './camera';
import { loadUiRuntimeConfig, type UiDebugOverlayConfig, type UiRuntimeConfig } from './config';
import { encodeBinaryFrameEnvelope } from './frameBinary';
import { clearOverlay, drawDetectionsOverlay } from './overlay';
import {
  createSpeechClient,
  deriveEvaHttpBaseUrl,
  isAudioLockedError,
  type SpeechClient,
} from './speech';
import type { DetectionsMessage, EventEntry, FrameBinaryMeta, InsightMessage, InsightSeverity } from './types';
import { createEvaWsClient, type EvaWsClient, type WsConnectionStatus } from './ws';

type LogDirection = 'system' | 'outgoing' | 'incoming';
type CameraStatus = 'idle' | 'starting' | 'running' | 'error';

interface AppProps {
  runtimeConfig: UiRuntimeConfig;
}

interface LogEntry {
  id: number;
  ts: string;
  direction: LogDirection;
  text: string;
}

interface EventFeedEntry {
  id: number;
  ts: string;
  name: string;
  severity: InsightSeverity;
  trackId: number | null;
  summary: string;
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

const SEVERITY_COLOR: Record<InsightSeverity, string> = {
  low: '#166534',
  medium: '#92400e',
  high: '#b91c1c',
};

const FRAME_TIMEOUT_MS = 500;
const FRAME_LOOP_INTERVAL_MS = 100;
const EVENT_FEED_LIMIT = 60;
const INSIGHT_SPEECH_FALLBACK_MAX_CHARS = 180;

const SEVERITY_RANK: Record<InsightSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

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

function isInsightMessage(message: unknown): message is InsightMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  return (
    candidate.type === 'insight' &&
    candidate.v === 1 &&
    typeof candidate.clip_id === 'string' &&
    typeof candidate.trigger_frame_id === 'string' &&
    typeof candidate.summary === 'object' &&
    candidate.summary !== null &&
    typeof candidate.usage === 'object' &&
    candidate.usage !== null
  );
}

function formatTime(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString();
}

function formatEventValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 48 ? `${value.slice(0, 45)}…` : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }

  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') {
      return String(value);
    }

    return json.length > 48 ? `${json.slice(0, 45)}…` : json;
  } catch {
    return String(value);
  }
}

function summarizeEventData(data: Record<string, unknown>): string {
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return 'no data';
  }

  return entries
    .slice(0, 3)
    .map(([key, value]) => `${key}=${formatEventValue(value)}`)
    .join(', ');
}

function hasDebugOverlayGeometry(config: UiDebugOverlayConfig | undefined): boolean {
  if (!config) {
    return false;
  }

  return Object.keys(config.regions).length > 0 || Object.keys(config.lines).length > 0;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === 'AbortError';
}

function shouldSpeakSeverity(
  severity: InsightSeverity,
  minSeverity: InsightSeverity,
): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minSeverity];
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeSpeechText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildInsightFallbackSpeechText(insight: InsightMessage): string {
  const oneLiner = normalizeSpeechText(insight.summary.one_liner);
  if (oneLiner) {
    return oneLiner;
  }

  for (const item of insight.summary.what_changed) {
    const normalized = normalizeSpeechText(item);
    if (normalized) {
      return truncateText(normalized, INSIGHT_SPEECH_FALLBACK_MAX_CHARS);
    }
  }

  if (insight.summary.tags.length > 0) {
    const tagsSummary = normalizeSpeechText(insight.summary.tags.join(', '));
    if (tagsSummary) {
      return `Insight tags: ${tagsSummary}`;
    }
  }

  return '';
}

function replaceToken(template: string, token: string, value: string): string {
  return template.split(token).join(value);
}

function renderInsightSpeechText(insight: InsightMessage, template: string): string {
  const fallback = buildInsightFallbackSpeechText(insight);
  const normalizedTemplate = normalizeSpeechText(template);

  if (!normalizedTemplate) {
    return fallback;
  }

  let renderedTemplate = normalizedTemplate;
  renderedTemplate = replaceToken(renderedTemplate, '{{one_liner}}', insight.summary.one_liner);
  renderedTemplate = replaceToken(renderedTemplate, '{{severity}}', insight.summary.severity);
  renderedTemplate = replaceToken(renderedTemplate, '{{tags}}', insight.summary.tags.join(', '));
  renderedTemplate = replaceToken(renderedTemplate, '{{what_changed}}', insight.summary.what_changed.join('; '));
  renderedTemplate = replaceToken(renderedTemplate, '{{clip_id}}', insight.clip_id);
  renderedTemplate = replaceToken(renderedTemplate, '{{trigger_frame_id}}', insight.trigger_frame_id);

  const rendered = normalizeSpeechText(renderedTemplate);

  if (!rendered || rendered === 'Insight:' || rendered === 'Insight') {
    return fallback;
  }

  return rendered;
}

function getInsightSpeechId(insight: InsightMessage): string {
  return `${insight.clip_id}:${insight.trigger_frame_id}`;
}

function App({ runtimeConfig }: AppProps): JSX.Element {
  const evaWsUrl = runtimeConfig.eva.wsUrl;
  const debugOverlayConfig = runtimeConfig.debugOverlay;
  const speechConfig = runtimeConfig.speech;

  const evaHttpBaseUrl = React.useMemo(() => deriveEvaHttpBaseUrl(evaWsUrl), [evaWsUrl]);
  const speechEndpointUrl = React.useMemo(
    () => new URL(speechConfig.path, `${evaHttpBaseUrl}/`).toString(),
    [evaHttpBaseUrl, speechConfig.path],
  );

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
  const [recentEvents, setRecentEvents] = React.useState<EventFeedEntry[]>([]);
  const [latestInsight, setLatestInsight] = React.useState<InsightMessage | null>(null);
  const [debugOverlayEnabled, setDebugOverlayEnabled] = React.useState(false);

  const [autoSpeakEnabled, setAutoSpeakEnabled] = React.useState(() => speechConfig.autoSpeak.enabled);
  const [audioLocked, setAudioLocked] = React.useState(() => speechConfig.enabled);
  const [speechVoice, setSpeechVoice] = React.useState(() => speechConfig.defaultVoice);
  const [speechBusy, setSpeechBusy] = React.useState(false);

  const cameraSupported = React.useMemo(() => isCameraSupported(), []);
  const debugOverlayConfigured = React.useMemo(() => hasDebugOverlayGeometry(debugOverlayConfig), [debugOverlayConfig]);

  const clientRef = React.useRef<EvaWsClient | null>(null);
  const speechClientRef = React.useRef<SpeechClient | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const captureCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const nextLogIdRef = React.useRef(1);
  const nextEventIdRef = React.useRef(1);
  const inFlightRef = React.useRef<InFlightFrame | null>(null);
  const captureInProgressRef = React.useRef(false);
  const latestDetectionsRef = React.useRef<DetectionsMessage | null>(null);

  const frameLoopTimerRef = React.useRef<number | null>(null);
  const framesSentRef = React.useRef(0);
  const framesAckedRef = React.useRef(0);
  const framesTimedOutRef = React.useRef(0);
  const activeSpeechAbortControllerRef = React.useRef<AbortController | null>(null);
  const autoSpeakLastStartedAtMsRef = React.useRef<number | null>(null);
  const lastSpokenInsightIdRef = React.useRef<string | null>(null);

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

  const appendEvents = React.useCallback((events: EventEntry[]) => {
    if (events.length === 0) {
      return;
    }

    const mapped: EventFeedEntry[] = [];

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      mapped.push({
        id: nextEventIdRef.current,
        ts: formatTime(event.ts_ms),
        name: event.name,
        severity: event.severity,
        trackId: event.track_id ?? null,
        summary: summarizeEventData(event.data),
      });
      nextEventIdRef.current += 1;
    }

    setRecentEvents((prev) => [...mapped, ...prev].slice(0, EVENT_FEED_LIMIT));
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

      drawDetectionsOverlay(videoElement, overlayCanvas, message, {
        debugOverlayEnabled,
        debugOverlay: debugOverlayConfig,
      });
      latestDetectionsRef.current = message;
      setLastDetectionsCount(message.detections.length);
      setLastDetectionsModel(message.model);
    },
    [debugOverlayConfig, debugOverlayEnabled],
  );

  React.useEffect(() => {
    const lastDetections = latestDetectionsRef.current;
    if (!lastDetections) {
      return;
    }

    renderDetections(lastDetections);
  }, [debugOverlayEnabled, renderDetections]);

  React.useEffect(() => {
    const speechClient = createSpeechClient({
      speechEndpointUrl,
      defaultVoice: speechConfig.defaultVoice,
      onAudioLockedChange: setAudioLocked,
    });

    speechClientRef.current = speechClient;
    setSpeechVoice(speechConfig.defaultVoice);
    setAudioLocked(speechConfig.enabled);

    return () => {
      const controller = activeSpeechAbortControllerRef.current;
      if (controller) {
        controller.abort();
        activeSpeechAbortControllerRef.current = null;
      }

      speechClient.dispose();
      speechClientRef.current = null;
    };
  }, [speechConfig.defaultVoice, speechConfig.enabled, speechEndpointUrl]);

  React.useEffect(() => {
    setAutoSpeakEnabled(speechConfig.autoSpeak.enabled);
  }, [speechConfig.autoSpeak.enabled]);

  const runSpeechRequest = React.useCallback(
    async ({ text, voice, source }: { text: string; voice: string; source: 'auto' | 'manual' }): Promise<boolean> => {
      const speechClient = speechClientRef.current;
      if (!speechClient) {
        appendLog('system', 'Speech client is not ready yet.');
        return false;
      }

      const normalizedText = normalizeSpeechText(text);
      if (!normalizedText) {
        return false;
      }

      const previousController = activeSpeechAbortControllerRef.current;
      if (previousController) {
        previousController.abort();
      }

      speechClient.stop();

      const controller = new AbortController();
      activeSpeechAbortControllerRef.current = controller;
      setSpeechBusy(true);

      try {
        await speechClient.speakText({
          text: normalizedText,
          voice,
          signal: controller.signal,
        });

        if (source === 'manual') {
          appendLog('system', `Test speech played using voice ${voice}.`);
        } else {
          appendLog('system', 'Auto-speak played latest insight.');
        }

        return true;
      } catch (error) {
        if (isAbortError(error)) {
          return false;
        }

        const message = toErrorMessage(error);
        if (isAudioLockedError(error)) {
          setAudioLocked(true);
        }

        appendLog('system', `${source === 'auto' ? 'Auto-speak' : 'Test speech'} failed: ${message}`);
        return false;
      } finally {
        if (activeSpeechAbortControllerRef.current === controller) {
          activeSpeechAbortControllerRef.current = null;
          setSpeechBusy(false);
        }
      }
    },
    [appendLog],
  );

  const maybeAutoSpeakInsight = React.useCallback(
    (insight: InsightMessage): void => {
      if (!speechConfig.enabled || !autoSpeakEnabled) {
        return;
      }

      if (!shouldSpeakSeverity(insight.summary.severity, speechConfig.autoSpeak.minSeverity)) {
        return;
      }

      const insightId = getInsightSpeechId(insight);
      if (lastSpokenInsightIdRef.current === insightId) {
        return;
      }

      const speechText = renderInsightSpeechText(insight, speechConfig.autoSpeak.textTemplate);
      if (!speechText) {
        return;
      }

      const nowMs = Date.now();
      if (speechConfig.autoSpeak.cooldownMs > 0 && autoSpeakLastStartedAtMsRef.current !== null) {
        const elapsedMs = nowMs - autoSpeakLastStartedAtMsRef.current;
        if (elapsedMs < speechConfig.autoSpeak.cooldownMs) {
          return;
        }
      }

      autoSpeakLastStartedAtMsRef.current = nowMs;
      lastSpokenInsightIdRef.current = insightId;

      const voice = speechVoice.trim() || speechConfig.defaultVoice;
      void runSpeechRequest({
        text: speechText,
        voice,
        source: 'auto',
      });
    },
    [autoSpeakEnabled, runSpeechRequest, speechConfig, speechVoice],
  );

  React.useEffect(() => {
    const client = createEvaWsClient(evaWsUrl, {
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
        const inFlight = inFlightRef.current;
        const detectionsMessage = isDetectionsMessage(message) ? message : null;
        const insightMessage = isInsightMessage(message) ? message : null;

        if (detectionsMessage) {
          renderDetections(detectionsMessage);

          if (detectionsMessage.events && detectionsMessage.events.length > 0) {
            appendEvents(detectionsMessage.events);
          }
        }

        if (insightMessage) {
          setLatestInsight(insightMessage);
          maybeAutoSpeakInsight(insightMessage);
        }

        if (detectionsMessage && inFlight && detectionsMessage.frame_id === inFlight.frameId) {
          window.clearTimeout(inFlight.timeoutId);
          inFlightRef.current = null;
          setInFlightFrameId(null);

          const latencyMs = Date.now() - inFlight.sentAt;
          framesAckedRef.current += 1;
          setFramesAcked(framesAckedRef.current);
          setLastAckLatencyMs(latencyMs);

          const shouldLogAck =
            shouldSampleFrameLog(framesAckedRef.current) || (detectionsMessage.events?.length ?? 0) > 0;

          if (shouldLogAck) {
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
    appendLog('system', `Connecting to ${evaWsUrl} ...`);
    client.connect();

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [appendEvents, appendLog, connectionAttempt, dropInFlight, evaWsUrl, maybeAutoSpeakInsight, renderDetections]);

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

  const handleTriggerInsightTest = React.useCallback(() => {
    const payload = {
      type: 'command',
      v: 1,
      name: 'insight_test',
    };

    const sent = clientRef.current?.sendJson(payload) ?? false;
    if (sent) {
      appendLog('outgoing', summarizeMessage(payload));
      return;
    }

    appendLog('system', 'Cannot send insight_test command while disconnected.');
  }, [appendLog]);

  const handleReconnect = React.useCallback(() => {
    appendLog('system', 'Reconnect requested.');
    setConnectionAttempt((prev) => prev + 1);
  }, [appendLog]);

  const handleClearLogs = React.useCallback(() => {
    setLogs([]);
  }, []);

  const handleToggleDebugOverlay = React.useCallback(() => {
    if (!debugOverlayConfigured) {
      appendLog('system', 'Debug overlay is not configured (set debugOverlay.regions/lines in UI runtime config).');
      return;
    }

    setDebugOverlayEnabled((prev) => {
      const next = !prev;
      appendLog('system', `Debug ROI/line overlay ${next ? 'enabled' : 'disabled'}.`);
      return next;
    });
  }, [appendLog, debugOverlayConfigured]);

  const handleToggleAutoSpeak = React.useCallback(() => {
    setAutoSpeakEnabled((prev) => {
      const next = !prev;
      appendLog('system', `Auto Speak ${next ? 'enabled' : 'disabled'}.`);
      return next;
    });
  }, [appendLog]);

  const handleEnableAudio = React.useCallback(async () => {
    if (!speechConfig.enabled) {
      appendLog('system', 'Speech is disabled in UI runtime config.');
      return;
    }

    const speechClient = speechClientRef.current;
    if (!speechClient) {
      appendLog('system', 'Speech client is not ready yet.');
      return;
    }

    try {
      await speechClient.enableAudio();
      setAudioLocked(false);
      appendLog('system', 'Audio unlocked. Auto-play is now permitted in this tab.');
    } catch (error) {
      const message = toErrorMessage(error);
      if (isAudioLockedError(error)) {
        setAudioLocked(true);
      }

      appendLog('system', `Enable Audio failed: ${message}`);
    }
  }, [appendLog, speechConfig.enabled]);

  const handleTestSpeak = React.useCallback(async () => {
    if (!speechConfig.enabled) {
      appendLog('system', 'Speech is disabled in UI runtime config.');
      return;
    }

    const voice = speechVoice.trim() || speechConfig.defaultVoice;

    await runSpeechRequest({
      text: 'Eva test speech. Insight auto-speak is ready.',
      voice,
      source: 'manual',
    });
  }, [appendLog, runSpeechRequest, speechConfig.defaultVoice, speechConfig.enabled, speechVoice]);

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
      latestDetectionsRef.current = null;
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
    latestDetectionsRef.current = null;
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
      <h1>Eva UI (Iteration 33)</h1>

      <p>
        WebSocket target: <code>{evaWsUrl}</code>
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
        · Streaming: <strong>{streamingEnabled ? 'on' : 'off'}</strong> · Debug overlay:{' '}
        <strong>
          {debugOverlayEnabled ? 'on' : debugOverlayConfigured ? 'off' : 'not configured'}
        </strong>
      </p>

      <p>
        Eva HTTP base: <code>{evaHttpBaseUrl}</code> · Speech endpoint: <code>{speechEndpointUrl}</code> · Speech:{' '}
        <strong>{speechConfig.enabled ? 'enabled' : 'disabled'}</strong> · Auto Speak:{' '}
        <strong>{autoSpeakEnabled ? 'on' : 'off'}</strong> · Audio unlock:{' '}
        <strong style={{ color: audioLocked ? '#b91c1c' : '#166534' }}>{audioLocked ? 'required' : 'ready'}</strong>
      </p>

      {cameraError ? (
        <p style={{ color: '#b91c1c' }}>
          <strong>Camera error:</strong> {cameraError}
        </p>
      ) : null}

      {speechConfig.enabled && audioLocked ? (
        <p style={{ color: '#92400e', marginTop: 0 }}>
          <strong>Audio is locked by browser autoplay policy.</strong> Click <strong>Enable Audio</strong> once, then use
          <strong> Test Speak</strong> or wait for auto-speak triggers.
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button type="button" onClick={handleSendTestMessage} disabled={status !== 'connected'}>
          Send test message
        </button>
        <button type="button" onClick={handleTriggerInsightTest} disabled={status !== 'connected'}>
          Trigger insight test
        </button>
        <button type="button" onClick={handleToggleAutoSpeak} disabled={!speechConfig.enabled}>
          Auto Speak: {autoSpeakEnabled ? 'on' : 'off'}
        </button>
        <button type="button" onClick={() => void handleEnableAudio()} disabled={!speechConfig.enabled || speechBusy}>
          Enable Audio
        </button>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Voice
          <input
            type="text"
            value={speechVoice}
            onChange={(event) => setSpeechVoice(event.target.value)}
            disabled={!speechConfig.enabled || speechBusy}
            style={{ minWidth: 220 }}
          />
        </label>
        <button type="button" onClick={() => void handleTestSpeak()} disabled={!speechConfig.enabled || speechBusy}>
          {speechBusy ? 'Speaking…' : 'Test Speak'}
        </button>
        <button type="button" onClick={handleToggleDebugOverlay} disabled={!debugOverlayConfigured}>
          {debugOverlayEnabled ? 'Hide ROI/line overlay' : 'Show ROI/line overlay'}
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
          <strong>{lastDetectionsCount}</strong> · events in feed: <strong>{recentEvents.length}</strong>
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

      <section style={{ marginBottom: 16 }}>
        <h2 style={{ marginBottom: 8 }}>Latest insight</h2>
        <div
          style={{
            border: '1px solid #ddd',
            borderRadius: 6,
            backgroundColor: '#fafafa',
            padding: 12,
          }}
        >
          {!latestInsight ? (
            <p style={{ margin: 0 }}>No insight received yet.</p>
          ) : (
            <>
              <p style={{ marginTop: 0, marginBottom: 8 }}>
                <strong style={{ color: SEVERITY_COLOR[latestInsight.summary.severity] }}>
                  {latestInsight.summary.severity.toUpperCase()}
                </strong>{' '}
                · {latestInsight.summary.one_liner}
              </p>
              <p style={{ marginTop: 0, marginBottom: 8 }}>
                Tags:{' '}
                {latestInsight.summary.tags.length > 0 ? (
                  latestInsight.summary.tags.map((tag) => <code key={tag} style={{ marginRight: 6 }}>{tag}</code>)
                ) : (
                  <em>none</em>
                )}
              </p>
              {latestInsight.summary.what_changed.length > 0 ? (
                <ul style={{ marginTop: 0, marginBottom: 8, paddingLeft: 20 }}>
                  {latestInsight.summary.what_changed.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : null}
              <p style={{ marginTop: 0, marginBottom: 0 }}>
                <small>
                  clip_id=<code>{latestInsight.clip_id}</code> · trigger=<code>{latestInsight.trigger_frame_id}</code> ·
                  tokens in/out={latestInsight.usage.input_tokens}/{latestInsight.usage.output_tokens} · cost=$
                  {latestInsight.usage.cost_usd.toFixed(4)}
                </small>
              </p>
            </>
          )}
        </div>
      </section>

      <section style={{ marginBottom: 16 }}>
        <h2 style={{ marginBottom: 8 }}>Recent events</h2>
        <div
          style={{
            border: '1px solid #ddd',
            borderRadius: 6,
            backgroundColor: '#fafafa',
            padding: 12,
            minHeight: 120,
            maxHeight: 260,
            overflow: 'auto',
          }}
        >
          {recentEvents.length === 0 ? (
            <p style={{ margin: 0 }}>No detector events yet.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {recentEvents.map((event) => (
                <li key={event.id}>
                  <code>{event.ts}</code> <strong>{event.name}</strong>{' '}
                  <strong style={{ color: SEVERITY_COLOR[event.severity] }}>[{event.severity}]</strong>{' '}
                  {event.trackId !== null ? (
                    <>
                      track_id=<code>{event.trackId}</code> ·{' '}
                    </>
                  ) : null}
                  {event.summary}
                </li>
              ))}
            </ul>
          )}
        </div>
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

async function bootstrap() {
  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Missing root element.');
  }

  const root = ReactDOM.createRoot(rootElement);

  try {
    const runtimeConfig = await loadUiRuntimeConfig();
    root.render(<App runtimeConfig={runtimeConfig} />);
  } catch (error) {
    root.render(
      <main style={{ fontFamily: 'sans-serif', padding: 16, lineHeight: 1.4 }}>
        <h1>Eva UI startup error</h1>
        <p style={{ color: '#b91c1c' }}>{toErrorMessage(error)}</p>
      </main>,
    );
  }
}

void bootstrap();
