import React from 'react';
import ReactDOM from 'react-dom/client';

import { captureJpegFrame, isCameraSupported, startCamera, stopCamera } from './camera';
import { loadUiRuntimeConfig, type UiDebugOverlayConfig, type UiRuntimeConfig } from './config';
import { encodeBinaryFrameEnvelope } from './frameBinary';
import { clearOverlay, drawSceneChangeOverlay } from './overlay';
import {
  createSpeechClient,
  deriveEvaHttpBaseUrl,
  isAudioLockedError,
  type SpeechClient,
} from './speech';
import type {
  EventEntry,
  FrameBinaryMeta,
  FrameEventsMessage,
  FrameReceivedMessage,
  InsightMessage,
  InsightSeverity,
  SpeechOutputMessage,
  TextOutputMessage,
} from './types';
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
  summary: string;
}

interface LatestCaption {
  text: string;
  ts: string;
}

type ChatMessageRole = 'user' | 'assistant';

interface ChatMessage {
  id: number;
  ts: string;
  role: ChatMessageRole;
  text: string;
  requestId?: string;
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
const SCENE_CHANGE_OVERLAY_TTL_MS = 1_500;

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
    if (message && typeof message === 'object') {
      const candidate = message as Record<string, unknown>;
      if (candidate.type === 'speech_output' && typeof candidate.audio_b64 === 'string') {
        return JSON.stringify({
          ...candidate,
          audio_b64: `<base64:${candidate.audio_b64.length} chars>`,
        });
      }
    }

    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

function parseTextEndpointErrorMessage(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const errorValue = (parsed as Record<string, unknown>).error;
    if (!errorValue || typeof errorValue !== 'object') {
      return null;
    }

    const message = (errorValue as Record<string, unknown>).message;
    return typeof message === 'string' && message.trim() ? message.trim() : null;
  } catch {
    return null;
  }
}

function isFrameEventsMessage(message: unknown): message is FrameEventsMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  return (
    candidate.type === 'frame_events' &&
    candidate.v === 2 &&
    typeof candidate.frame_id === 'string' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    Array.isArray(candidate.events)
  );
}

function isFrameReceivedMessage(message: unknown): message is FrameReceivedMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  return (
    candidate.type === 'frame_received' &&
    candidate.v === 2 &&
    typeof candidate.frame_id === 'string' &&
    typeof candidate.ts_ms === 'number' &&
    typeof candidate.accepted === 'boolean' &&
    typeof candidate.queue_depth === 'number' &&
    typeof candidate.dropped === 'number'
  );
}

function isInsightMessage(message: unknown): message is InsightMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  const summary = candidate.summary;
  const usage = candidate.usage;

  if (!summary || typeof summary !== 'object' || !usage || typeof usage !== 'object') {
    return false;
  }

  const summaryRecord = summary as Record<string, unknown>;

  return (
    candidate.type === 'insight' &&
    candidate.v === 2 &&
    typeof candidate.clip_id === 'string' &&
    typeof candidate.trigger_frame_id === 'string' &&
    typeof summaryRecord.one_liner === 'string' &&
    typeof summaryRecord.tts_response === 'string'
  );
}

function isTextOutputMessage(message: unknown): message is TextOutputMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  if (candidate.type !== 'text_output' || candidate.v !== 2) {
    return false;
  }

  if (typeof candidate.request_id !== 'string' || typeof candidate.ts_ms !== 'number' || typeof candidate.text !== 'string') {
    return false;
  }

  const meta = candidate.meta;
  if (!meta || typeof meta !== 'object') {
    return false;
  }

  const metaRecord = meta as Record<string, unknown>;
  return (
    typeof metaRecord.tone === 'string' &&
    Array.isArray(metaRecord.concepts) &&
    typeof metaRecord.surprise === 'number' &&
    typeof metaRecord.note === 'string'
  );
}

function isSpeechOutputMessage(message: unknown): message is SpeechOutputMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  if (candidate.type !== 'speech_output' || candidate.v !== 2) {
    return false;
  }

  if (
    typeof candidate.request_id !== 'string' ||
    typeof candidate.session_id !== 'string' ||
    typeof candidate.ts_ms !== 'number' ||
    candidate.mime !== 'audio/mpeg' ||
    typeof candidate.voice !== 'string' ||
    typeof candidate.rate !== 'number' ||
    typeof candidate.text !== 'string' ||
    typeof candidate.audio_b64 !== 'string'
  ) {
    return false;
  }

  const meta = candidate.meta;
  if (!meta || typeof meta !== 'object') {
    return false;
  }

  const metaRecord = meta as Record<string, unknown>;
  return (
    (metaRecord.trigger_kind === 'insight' || metaRecord.trigger_kind === 'wm_event') &&
    typeof metaRecord.trigger_id === 'string' &&
    metaRecord.severity === 'high'
  );
}

function getTextOutputTriggerKind(textOutput: TextOutputMessage): string | null {
  const triggerKind = (textOutput.meta as Record<string, unknown>).trigger_kind;
  return typeof triggerKind === 'string' ? triggerKind : null;
}

function isUserChatReplyTextOutput(textOutput: TextOutputMessage): boolean {
  if (getTextOutputTriggerKind(textOutput) !== null) {
    return false;
  }

  const sessionId = textOutput.session_id?.trim();
  if (!sessionId) {
    return true;
  }

  return !sessionId.startsWith('system-');
}

function shouldAutoSpeakTextOutput(textOutput: TextOutputMessage): boolean {
  const triggerKind = getTextOutputTriggerKind(textOutput);
  if (triggerKind === 'insight') {
    return true;
  }

  return isUserChatReplyTextOutput(textOutput);
}

function decodeBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return arrayBuffer;
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

function getSceneCaptionText(event: EventEntry): string | null {
  if (event.name !== 'scene_caption') {
    return null;
  }

  const textValue = event.data.text;
  if (typeof textValue !== 'string') {
    return null;
  }

  const normalizedText = textValue.trim();
  return normalizedText.length > 0 ? normalizedText : null;
}

function getSceneChangeBlobCount(message: FrameEventsMessage): number {
  let count = 0;

  for (const event of message.events) {
    if (event.name !== 'scene_change') {
      continue;
    }

    const blobs = event.data.blobs;
    if (!Array.isArray(blobs)) {
      continue;
    }

    count += blobs.length;
  }

  return count;
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

function isAutoplayBlockedError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotAllowedError';
}

function normalizeSpeechText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function App({ runtimeConfig }: AppProps): JSX.Element {
  const evaWsUrl = runtimeConfig.eva.wsUrl;
  const debugOverlayConfig = runtimeConfig.debugOverlay;
  const speechConfig = runtimeConfig.speech;

  const evaHttpBaseUrl = React.useMemo(() => deriveEvaHttpBaseUrl(evaWsUrl), [evaWsUrl]);
  const textEndpointUrl = React.useMemo(() => new URL('/text', `${evaHttpBaseUrl}/`).toString(), [evaHttpBaseUrl]);
  const speechEndpointUrl = React.useMemo(
    () => new URL(speechConfig.path, `${evaHttpBaseUrl}/`).toString(),
    [evaHttpBaseUrl, speechConfig.path],
  );

  const [status, setStatus] = React.useState<WsConnectionStatus>('connecting');
  const [logs, setLogs] = React.useState<LogEntry[]>([]);
  const [connectionAttempt, setConnectionAttempt] = React.useState(0);

  const [chatMessages, setChatMessages] = React.useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = React.useState('');
  const [chatPending, setChatPending] = React.useState(false);

  const [cameraStatus, setCameraStatus] = React.useState<CameraStatus>('idle');
  const [cameraError, setCameraError] = React.useState<string | null>(null);
  const [streamingEnabled, setStreamingEnabled] = React.useState(false);

  const [framesSent, setFramesSent] = React.useState(0);
  const [framesAcked, setFramesAcked] = React.useState(0);
  const [framesDroppedByBroker, setFramesDroppedByBroker] = React.useState(0);
  const [framesTimedOut, setFramesTimedOut] = React.useState(0);
  const [lastAckLatencyMs, setLastAckLatencyMs] = React.useState<number | null>(null);
  const [inFlightFrameId, setInFlightFrameId] = React.useState<string | null>(null);
  const [recentEvents, setRecentEvents] = React.useState<EventFeedEntry[]>([]);
  const [latestCaption, setLatestCaption] = React.useState<LatestCaption | null>(null);
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
  const alertAudioRef = React.useRef<HTMLAudioElement>(new Audio());
  const alertAudioObjectUrlRef = React.useRef<string | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const captureCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const nextLogIdRef = React.useRef(1);
  const nextEventIdRef = React.useRef(1);
  const nextChatIdRef = React.useRef(1);
  const seenTextOutputRequestIdsRef = React.useRef<string[]>([]);
  const inFlightRef = React.useRef<InFlightFrame | null>(null);
  const captureInProgressRef = React.useRef(false);
  const sceneOverlayClearTimerRef = React.useRef<number | null>(null);

  const frameLoopTimerRef = React.useRef<number | null>(null);
  const framesSentRef = React.useRef(0);
  const framesAckedRef = React.useRef(0);
  const framesDroppedByBrokerRef = React.useRef(0);
  const framesTimedOutRef = React.useRef(0);
  const activeSpeechAbortControllerRef = React.useRef<AbortController | null>(null);
  const lastSpokenTextOutputRequestIdRef = React.useRef<string | null>(null);
  const chatAutoSpeakLastStartedAtMsRef = React.useRef<number | null>(null);

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
      const sceneCaptionText = getSceneCaptionText(event);

      mapped.push({
        id: nextEventIdRef.current,
        ts: formatTime(event.ts_ms),
        name: event.name,
        severity: event.severity,
        summary: sceneCaptionText ?? summarizeEventData(event.data),
      });
      nextEventIdRef.current += 1;
    }

    setRecentEvents((prev) => [...mapped, ...prev].slice(0, EVENT_FEED_LIMIT));
  }, []);

  const appendChatMessage = React.useCallback((role: ChatMessageRole, text: string, requestId?: string) => {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return;
    }

    const entry: ChatMessage = {
      id: nextChatIdRef.current,
      ts: new Date().toLocaleTimeString(),
      role,
      text: trimmedText,
      ...(requestId ? { requestId } : {}),
    };

    nextChatIdRef.current += 1;
    setChatMessages((prev) => [...prev.slice(-99), entry]);
  }, []);

  const appendTextOutputMessage = React.useCallback(
    (textOutput: TextOutputMessage, source: 'ws' | 'http') => {
      if (seenTextOutputRequestIdsRef.current.includes(textOutput.request_id)) {
        return;
      }

      seenTextOutputRequestIdsRef.current.push(textOutput.request_id);
      if (seenTextOutputRequestIdsRef.current.length > 500) {
        seenTextOutputRequestIdsRef.current = seenTextOutputRequestIdsRef.current.slice(-500);
      }

      appendChatMessage('assistant', textOutput.text, textOutput.request_id);

      if (source === 'ws') {
        appendLog('system', `Chat reply received via WS (${textOutput.request_id}).`);
      } else {
        appendLog('system', `Chat reply received via HTTP fallback (${textOutput.request_id}).`);
      }
    },
    [appendChatMessage, appendLog],
  );

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

  const clearSceneOverlayTimer = React.useCallback(() => {
    if (sceneOverlayClearTimerRef.current === null) {
      return;
    }

    window.clearTimeout(sceneOverlayClearTimerRef.current);
    sceneOverlayClearTimerRef.current = null;
  }, []);

  const renderSceneOverlay = React.useCallback(
    (message: FrameEventsMessage) => {
      const videoElement = videoRef.current;
      const overlayCanvas = overlayCanvasRef.current;
      if (!videoElement || !overlayCanvas) {
        return;
      }

      drawSceneChangeOverlay(videoElement, overlayCanvas, message, {
        debugOverlayEnabled,
        debugOverlay: debugOverlayConfig,
      });

      clearSceneOverlayTimer();
      sceneOverlayClearTimerRef.current = window.setTimeout(() => {
        sceneOverlayClearTimerRef.current = null;
        clearOverlayCanvas();
      }, SCENE_CHANGE_OVERLAY_TTL_MS);
    },
    [clearOverlayCanvas, clearSceneOverlayTimer, debugOverlayConfig, debugOverlayEnabled],
  );

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

  const revokeAlertAudioObjectUrl = React.useCallback(() => {
    const objectUrl = alertAudioObjectUrlRef.current;
    if (!objectUrl) {
      return;
    }

    URL.revokeObjectURL(objectUrl);
    alertAudioObjectUrlRef.current = null;
  }, []);

  const playSpeechOutputAlert = React.useCallback(
    async (message: SpeechOutputMessage): Promise<void> => {
      let audioBuffer: ArrayBuffer;
      try {
        audioBuffer = decodeBase64ToArrayBuffer(message.audio_b64);
      } catch {
        appendLog('system', `Push alert audio decode failed (${message.request_id}).`);
        return;
      }

      const audio = alertAudioRef.current;
      audio.pause();
      audio.currentTime = 0;
      revokeAlertAudioObjectUrl();

      const objectUrl = URL.createObjectURL(new Blob([audioBuffer], { type: message.mime }));
      alertAudioObjectUrlRef.current = objectUrl;
      audio.src = objectUrl;
      audio.currentTime = 0;

      try {
        await audio.play();
        setAudioLocked(false);
        appendLog('system', `Push alert audio played (${message.request_id}).`);
      } catch (error) {
        if (isAutoplayBlockedError(error)) {
          setAudioLocked(true);
          appendLog(
            'system',
            'Push alert audio blocked by browser autoplay policy. Click Enable Audio once to allow alert playback.',
          );
          return;
        }

        appendLog('system', `Push alert audio failed: ${toErrorMessage(error)}`);
      }
    },
    [appendLog, revokeAlertAudioObjectUrl],
  );

  React.useEffect(() => {
    return () => {
      const audio = alertAudioRef.current;
      audio.pause();
      audio.currentTime = 0;
      revokeAlertAudioObjectUrl();
      audio.removeAttribute('src');
      audio.load();
    };
  }, [revokeAlertAudioObjectUrl]);

  const runSpeechRequest = React.useCallback(
    async ({
      text,
      voice,
      source,
    }: {
      text: string;
      voice: string;
      source: 'auto-chat' | 'auto-insight' | 'manual';
    }): Promise<boolean> => {
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
        } else if (source === 'auto-insight') {
          appendLog('system', 'Auto-speak played insight utterance.');
        } else {
          appendLog('system', 'Auto-speak played chat reply.');
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

        const sourceLabel =
          source === 'manual' ? 'Test speech' : source === 'auto-insight' ? 'Insight auto-speak' : 'Auto-speak';

        appendLog('system', `${sourceLabel} failed: ${message}`);
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

  const maybeAutoSpeakTextOutput = React.useCallback(
    (textOutput: TextOutputMessage): void => {
      if (!speechConfig.enabled || !autoSpeakEnabled) {
        return;
      }

      const triggerKind = getTextOutputTriggerKind(textOutput);
      const isInsightUtterance = triggerKind === 'insight';

      // Iteration 136 guardrail: auto-speak only user chat replies or insight-triggered utterances.
      if (!shouldAutoSpeakTextOutput(textOutput)) {
        return;
      }

      if (lastSpokenTextOutputRequestIdRef.current === textOutput.request_id) {
        return;
      }

      const speechText = normalizeSpeechText(textOutput.text);
      if (!speechText) {
        return;
      }

      const nowMs = Date.now();
      if (speechConfig.autoSpeak.cooldownMs > 0 && chatAutoSpeakLastStartedAtMsRef.current !== null) {
        const elapsedMs = nowMs - chatAutoSpeakLastStartedAtMsRef.current;
        if (elapsedMs < speechConfig.autoSpeak.cooldownMs) {
          return;
        }
      }

      chatAutoSpeakLastStartedAtMsRef.current = nowMs;
      lastSpokenTextOutputRequestIdRef.current = textOutput.request_id;

      const voice = speechVoice.trim() || speechConfig.defaultVoice;
      void runSpeechRequest({
        text: speechText,
        voice,
        source: isInsightUtterance ? 'auto-insight' : 'auto-chat',
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
        clearSceneOverlayTimer();
        clearOverlayCanvas();
        appendLog('system', 'Disconnected from Eva WebSocket endpoint.');
      },
      onMessage: (message) => {
        const inFlight = inFlightRef.current;
        const frameReceivedMessage = isFrameReceivedMessage(message) ? message : null;
        const frameEventsMessage = isFrameEventsMessage(message) ? message : null;
        const insightMessage = isInsightMessage(message) ? message : null;
        const textOutputMessage = isTextOutputMessage(message) ? message : null;
        const speechOutputMessage = isSpeechOutputMessage(message) ? message : null;

        if (frameEventsMessage && frameEventsMessage.events.length > 0) {
          for (const event of frameEventsMessage.events) {
            const sceneCaptionText = getSceneCaptionText(event);
            if (!sceneCaptionText) {
              continue;
            }

            setLatestCaption({
              text: sceneCaptionText,
              ts: formatTime(event.ts_ms),
            });
          }

          appendEvents(frameEventsMessage.events);

          const sceneChangeBlobCount = getSceneChangeBlobCount(frameEventsMessage);
          if (sceneChangeBlobCount > 0) {
            renderSceneOverlay(frameEventsMessage);
          }
        }

        if (insightMessage) {
          setLatestInsight(insightMessage);
        }

        if (textOutputMessage) {
          appendTextOutputMessage(textOutputMessage, 'ws');
          maybeAutoSpeakTextOutput(textOutputMessage);
        }

        if (speechOutputMessage) {
          void playSpeechOutputAlert(speechOutputMessage);
        }

        if (frameReceivedMessage && inFlight && frameReceivedMessage.frame_id === inFlight.frameId) {
          window.clearTimeout(inFlight.timeoutId);
          inFlightRef.current = null;
          setInFlightFrameId(null);

          const receiptLatencyMs = Date.now() - inFlight.sentAt;
          setLastAckLatencyMs(receiptLatencyMs);

          if (!frameReceivedMessage.accepted) {
            framesDroppedByBrokerRef.current += 1;
            setFramesDroppedByBroker(framesDroppedByBrokerRef.current);

            appendLog('incoming', summarizeMessage(message));
            appendLog(
              'system',
              `Frame dropped by broker (queue_depth=${frameReceivedMessage.queue_depth}, dropped=${frameReceivedMessage.dropped}) in ${receiptLatencyMs}ms.`,
            );
            return;
          }

          framesAckedRef.current += 1;
          setFramesAcked(framesAckedRef.current);

          const shouldLogReceipt = shouldSampleFrameLog(framesAckedRef.current);
          if (shouldLogReceipt) {
            appendLog('incoming', summarizeMessage(message));
            appendLog('system', `Frame receipt acknowledged in ${receiptLatencyMs}ms.`);
          }

          return;
        }

        if (frameEventsMessage) {
          if (frameEventsMessage.events.length > 0) {
            appendLog('incoming', summarizeMessage(message));
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
  }, [
    appendEvents,
    appendLog,
    appendTextOutputMessage,
    clearOverlayCanvas,
    clearSceneOverlayTimer,
    connectionAttempt,
    dropInFlight,
    evaWsUrl,
    maybeAutoSpeakTextOutput,
    playSpeechOutputAlert,
    renderSceneOverlay,
  ]);

  const handleSendTestMessage = React.useCallback(() => {
    const payload = {
      type: 'ui_test',
      v: 2,
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
      v: 2,
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

  const handleChatSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const text = chatInput.trim();
      if (!text || chatPending) {
        return;
      }

      setChatInput('');
      appendChatMessage('user', text);
      appendLog('outgoing', `POST /text text=${JSON.stringify(text)}`);
      setChatPending(true);

      try {
        const response = await fetch(textEndpointUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            text,
            source: 'ui',
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          const detail = parseTextEndpointErrorMessage(errorBody) ?? `HTTP ${response.status}`;
          appendLog('system', `POST /text failed: ${detail}`);
          appendChatMessage('assistant', `Error: ${detail}`);
          return;
        }

        let payload: unknown;
        try {
          payload = (await response.json()) as unknown;
        } catch {
          appendLog('system', 'POST /text failed: expected JSON response from Eva.');
          appendChatMessage('assistant', 'Error: invalid response from Eva /text.');
          return;
        }

        if (!isTextOutputMessage(payload)) {
          appendLog('system', 'POST /text failed: response did not match text_output shape.');
          appendChatMessage('assistant', 'Error: invalid text_output response shape.');
          return;
        }

        const wsConnected = clientRef.current?.getStatus() === 'connected';
        if (!wsConnected) {
          appendTextOutputMessage(payload, 'http');
          maybeAutoSpeakTextOutput(payload);
        }
      } catch (error) {
        const message = toErrorMessage(error);
        appendLog('system', `POST /text request failed: ${message}`);
        appendChatMessage('assistant', `Error: ${message}`);
      } finally {
        setChatPending(false);
      }
    },
    [appendChatMessage, appendLog, appendTextOutputMessage, chatInput, chatPending, maybeAutoSpeakTextOutput, textEndpointUrl],
  );

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
      appendLog('system', `Auto-speak ${next ? 'enabled' : 'disabled'}.`);
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

      clearSceneOverlayTimer();
      clearOverlayCanvas();

      setCameraStatus('running');
      appendLog('system', 'Camera started successfully.');
    } catch (error) {
      const message = toErrorMessage(error);
      setCameraStatus('error');
      setCameraError(message);
      appendLog('system', `Failed to start camera: ${message}`);
    }
  }, [appendLog, cameraStatus, cameraSupported, clearOverlayCanvas, clearSceneOverlayTimer]);

  const handleStopCamera = React.useCallback(() => {
    setStreamingEnabled(false);
    dropInFlight('Dropped in-flight frame: camera stopped');

    stopCamera(streamRef.current);
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    clearSceneOverlayTimer();
    clearOverlayCanvas();

    setCameraStatus('idle');
    setCameraError(null);
    appendLog('system', 'Camera stopped.');
  }, [appendLog, clearOverlayCanvas, clearSceneOverlayTimer, dropInFlight]);

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
    clearSceneOverlayTimer();
    clearOverlayCanvas();
    appendLog('system', 'Frame streaming paused.');
  }, [appendLog, cameraStatus, clearOverlayCanvas, clearSceneOverlayTimer, dropInFlight, streamingEnabled]);

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
        v: 2,
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
      clearSceneOverlayTimer();
      clearOverlayCanvas();
    };
  }, [clearOverlayCanvas, clearSceneOverlayTimer]);

  // Insights are rendered silently (no spoken line).

  return (
    <main style={{ fontFamily: 'sans-serif', padding: 16, lineHeight: 1.4 }}>
      <h1>Eva UI (Iteration 79)</h1>

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
        Eva HTTP base: <code>{evaHttpBaseUrl}</code> · Text endpoint: <code>{textEndpointUrl}</code> · Speech endpoint:{' '}
        <code>{speechEndpointUrl}</code> · Speech: <strong>{speechConfig.enabled ? 'enabled' : 'disabled'}</strong> ·
        Auto Speak: <strong>{autoSpeakEnabled ? 'on' : 'off'}</strong> · Audio unlock:{' '}
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
          <strong> Test Speak</strong> or wait for chat auto-speak on replies.
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
        <h2 style={{ marginBottom: 8 }}>Chat (text via Eva /text)</h2>
        <form onSubmit={handleChatSubmit} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input
            type="text"
            value={chatInput}
            onChange={(event) => setChatInput(event.target.value)}
            placeholder="Type a message..."
            disabled={chatPending}
            style={{ flex: 1, minWidth: 240 }}
          />
          <button type="submit" disabled={chatPending || chatInput.trim().length === 0}>
            {chatPending ? 'Sending…' : 'Send text'}
          </button>
        </form>
        <div
          style={{
            border: '1px solid #ddd',
            borderRadius: 6,
            backgroundColor: '#fafafa',
            padding: 12,
            minHeight: 120,
            maxHeight: 220,
            overflow: 'auto',
          }}
        >
          {chatMessages.length === 0 ? (
            <p style={{ margin: 0 }}>No chat messages yet.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {chatMessages.map((message) => (
                <li key={message.id}>
                  <code>{message.ts}</code> <strong>[{message.role}]</strong> {message.text}{' '}
                  {message.requestId ? (
                    <small>
                      req=<code>{message.requestId}</code>
                    </small>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

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
          Frames sent: <strong>{framesSent}</strong> · receipts: <strong>{framesAcked}</strong> · dropped by broker:{' '}
          <strong>{framesDroppedByBroker}</strong> · timed out: <strong>{framesTimedOut}</strong> · in-flight:{' '}
          <strong>{inFlightFrameId ? 'yes' : 'no'}</strong> · events in feed: <strong>{recentEvents.length}</strong>
          {lastAckLatencyMs !== null ? (
            <>
              {' '}
              · last receipt latency: <strong>{lastAckLatencyMs}ms</strong>
            </>
          ) : null}
        </p>
        <p style={{ marginTop: 4, marginBottom: 0 }}>
          <strong>Latest caption:</strong>{' '}
          {latestCaption ? (
            <>
              {latestCaption.text} <small>(at {latestCaption.ts})</small>
            </>
          ) : (
            <em>none yet</em>
          )}
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
              <p style={{ marginTop: 0, marginBottom: 8, color: '#374151' }}>
                <strong>Spoken line:</strong> {latestInsight.summary.tts_response}
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
            <p style={{ margin: 0 }}>No scene-change events yet.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {recentEvents.map((event) => (
                <li key={event.id}>
                  <code>{event.ts}</code> <strong>{event.name}</strong>{' '}
                  <strong style={{ color: SEVERITY_COLOR[event.severity] }}>[{event.severity}]</strong>{' '}
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
