export interface SpeakTextInput {
  text: string;
  voice?: string;
  rate?: number;
  signal?: AbortSignal;
}

export interface SpeechClientOptions {
  speechEndpointUrl: string;
  defaultVoice: string;
  onAudioLockedChange?: (locked: boolean) => void;
}

export interface SpeechClient {
  speakText: (input: SpeakTextInput) => Promise<void>;
  enableAudio: () => Promise<void>;
  stop: () => void;
  dispose: () => void;
  isAudioLocked: () => boolean;
}

export class AudioLockedError extends Error {
  readonly causeValue: unknown;

  constructor(message: string, causeValue?: unknown) {
    super(message);
    this.name = 'AudioLockedError';
    this.causeValue = causeValue;
  }
}

const SILENT_WAV_DATA_URI = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAutoplayBlockedError(error: unknown): boolean {
  if (!(error instanceof DOMException)) {
    return false;
  }

  return error.name === 'NotAllowedError';
}

function parseSpeechErrorMessage(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const errorValue = parsed.error;
    if (!isRecord(errorValue)) {
      return null;
    }

    const message = errorValue.message;
    return typeof message === 'string' && message.trim() !== '' ? message.trim() : null;
  } catch {
    return null;
  }
}

function toPlaybackErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function isAudioLockedError(error: unknown): error is AudioLockedError {
  return error instanceof AudioLockedError;
}

export function deriveEvaHttpBaseUrl(evaWsUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(evaWsUrl);
  } catch {
    throw new Error(`Invalid Eva WebSocket URL: ${evaWsUrl}`);
  }

  if (parsed.protocol === 'ws:') {
    parsed.protocol = 'http:';
  } else if (parsed.protocol === 'wss:') {
    parsed.protocol = 'https:';
  } else {
    throw new Error(`Eva WebSocket URL must use ws:// or wss:// (received ${parsed.protocol})`);
  }

  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';

  return parsed.origin;
}

export function createSpeechClient(options: SpeechClientOptions): SpeechClient {
  const { speechEndpointUrl, defaultVoice, onAudioLockedChange } = options;

  const audio = new Audio();
  audio.preload = 'auto';

  let activeObjectUrl: string | null = null;
  let audioLocked = false;

  const setAudioLocked = (next: boolean): void => {
    if (audioLocked === next) {
      return;
    }

    audioLocked = next;
    onAudioLockedChange?.(next);
  };

  const revokeActiveObjectUrl = (): void => {
    if (!activeObjectUrl) {
      return;
    }

    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
  };

  const playLoadedAudio = async (): Promise<void> => {
    try {
      await audio.play();
      setAudioLocked(false);
    } catch (error) {
      if (isAutoplayBlockedError(error)) {
        setAudioLocked(true);
        throw new AudioLockedError(
          'Browser blocked audio playback. Click "Enable Audio" once, then try again.',
          error,
        );
      }

      throw new Error(`Audio playback failed: ${toPlaybackErrorMessage(error)}`);
    }
  };

  return {
    async speakText(input: SpeakTextInput): Promise<void> {
      const text = input.text.trim();
      if (!text) {
        throw new Error('Speech text must be non-empty.');
      }

      const selectedVoice = (input.voice ?? defaultVoice).trim();
      if (!selectedVoice) {
        throw new Error('Speech voice must be non-empty.');
      }

      const requestBody: Record<string, unknown> = {
        text,
        voice: selectedVoice,
      };

      if (input.rate !== undefined) {
        requestBody.rate = input.rate;
      }

      const response = await fetch(speechEndpointUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: input.signal,
      });

      if (!response.ok) {
        const responseText = await response.text();
        const serverMessage = parseSpeechErrorMessage(responseText);
        const message = serverMessage ?? `Speech request failed with HTTP ${response.status}.`;
        throw new Error(message);
      }

      const audioBlob = await response.blob();

      audio.pause();
      audio.currentTime = 0;
      revokeActiveObjectUrl();

      activeObjectUrl = URL.createObjectURL(audioBlob);
      audio.src = activeObjectUrl;
      audio.currentTime = 0;

      await playLoadedAudio();
    },

    async enableAudio(): Promise<void> {
      const probeAudio = new Audio(SILENT_WAV_DATA_URI);

      try {
        await probeAudio.play();
        probeAudio.pause();
        probeAudio.currentTime = 0;
        setAudioLocked(false);
      } catch (error) {
        if (isAutoplayBlockedError(error)) {
          setAudioLocked(true);
          throw new AudioLockedError(
            'Browser still blocks autoplay. Interact with the page and try "Enable Audio" again.',
            error,
          );
        }

        throw new Error(`Failed to enable audio: ${toPlaybackErrorMessage(error)}`);
      }
    },

    stop(): void {
      audio.pause();
      audio.currentTime = 0;
      revokeActiveObjectUrl();
      audio.removeAttribute('src');
      audio.load();
    },

    dispose(): void {
      audio.pause();
      audio.currentTime = 0;
      revokeActiveObjectUrl();
      audio.removeAttribute('src');
      audio.load();
    },

    isAudioLocked(): boolean {
      return audioLocked;
    },
  };
}
