export interface OverlayRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface UiDebugOverlayConfig {
  regions: Record<string, OverlayRect>;
  lines: Record<string, OverlayRect>;
}

export type AutoSpeakMinSeverity = 'low' | 'medium' | 'high';

export interface UiSpeechAutoSpeakConfig {
  enabled: boolean;
  minSeverity: AutoSpeakMinSeverity;
  cooldownMs: number;
}

export interface UiSpeechConfig {
  enabled: boolean;
  path: string;
  defaultVoice: string;
  autoSpeak: UiSpeechAutoSpeakConfig;
}

export interface UiRuntimeConfig {
  eva: {
    wsUrl: string;
  };
  speech: UiSpeechConfig;
  debugOverlay?: UiDebugOverlayConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertWsUrl(value: unknown, sourcePath: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid UI runtime config in ${sourcePath}: eva.wsUrl must be a non-empty string`);
  }

  const wsUrl = value.trim();

  let parsed: URL;
  try {
    parsed = new URL(wsUrl);
  } catch {
    throw new Error(`Invalid UI runtime config in ${sourcePath}: eva.wsUrl must be a valid URL`);
  }

  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`Invalid UI runtime config in ${sourcePath}: eva.wsUrl must use ws:// or wss://`);
  }

  return wsUrl;
}

function assertFiniteNumber(value: unknown, key: string, sourcePath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid UI runtime config in ${sourcePath}: ${key} must be a finite number`);
  }

  return value;
}

function assertBoolean(value: unknown, key: string, sourcePath: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid UI runtime config in ${sourcePath}: ${key} must be a boolean`);
  }

  return value;
}

function assertNonEmptyString(value: unknown, key: string, sourcePath: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid UI runtime config in ${sourcePath}: ${key} must be a non-empty string`);
  }

  return value.trim();
}

function assertNonNegativeInt(value: unknown, key: string, sourcePath: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid UI runtime config in ${sourcePath}: ${key} must be a non-negative integer`);
  }

  return value;
}

function parseOverlayRect(value: unknown, key: string, sourcePath: string): OverlayRect {
  if (!isRecord(value)) {
    throw new Error(`Invalid UI runtime config in ${sourcePath}: ${key} must be an object`);
  }

  return {
    x1: assertFiniteNumber(value.x1, `${key}.x1`, sourcePath),
    y1: assertFiniteNumber(value.y1, `${key}.y1`, sourcePath),
    x2: assertFiniteNumber(value.x2, `${key}.x2`, sourcePath),
    y2: assertFiniteNumber(value.y2, `${key}.y2`, sourcePath),
  };
}

function parseOverlayMap(value: unknown, key: string, sourcePath: string): Record<string, OverlayRect> {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isRecord(value)) {
    throw new Error(`Invalid UI runtime config in ${sourcePath}: ${key} must be an object`);
  }

  const parsed: Record<string, OverlayRect> = {};
  for (const [name, rawRect] of Object.entries(value)) {
    if (!name.trim()) {
      throw new Error(`Invalid UI runtime config in ${sourcePath}: ${key} keys must be non-empty strings`);
    }

    parsed[name] = parseOverlayRect(rawRect, `${key}.${name}`, sourcePath);
  }

  return parsed;
}

function parseDebugOverlay(value: unknown, sourcePath: string): UiDebugOverlayConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`Invalid UI runtime config in ${sourcePath}: debugOverlay must be an object`);
  }

  return {
    regions: parseOverlayMap(value.regions, 'debugOverlay.regions', sourcePath),
    lines: parseOverlayMap(value.lines, 'debugOverlay.lines', sourcePath),
  };
}

function parseAutoSpeakMinSeverity(value: unknown, sourcePath: string): AutoSpeakMinSeverity {
  if (value === undefined) {
    return 'medium';
  }

  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }

  throw new Error(
    `Invalid UI runtime config in ${sourcePath}: speech.autoSpeak.minSeverity must be "low", "medium", or "high"`,
  );
}

function parseSpeechConfig(value: unknown, sourcePath: string): UiSpeechConfig {
  if (value !== undefined && value !== null && !isRecord(value)) {
    throw new Error(`Invalid UI runtime config in ${sourcePath}: speech must be an object`);
  }

  const speech = isRecord(value) ? value : {};

  const enabled =
    speech.enabled === undefined ? false : assertBoolean(speech.enabled, 'speech.enabled', sourcePath);

  const path =
    speech.path === undefined ? '/speech' : assertNonEmptyString(speech.path, 'speech.path', sourcePath);
  if (!path.startsWith('/')) {
    throw new Error(`Invalid UI runtime config in ${sourcePath}: speech.path must start with "/"`);
  }

  const defaultVoice =
    speech.defaultVoice === undefined
      ? 'en-US-JennyNeural'
      : assertNonEmptyString(speech.defaultVoice, 'speech.defaultVoice', sourcePath);

  const autoSpeakRaw = speech.autoSpeak;
  if (autoSpeakRaw !== undefined && autoSpeakRaw !== null && !isRecord(autoSpeakRaw)) {
    throw new Error(`Invalid UI runtime config in ${sourcePath}: speech.autoSpeak must be an object`);
  }

  const autoSpeak = isRecord(autoSpeakRaw) ? autoSpeakRaw : {};

  const autoSpeakEnabled =
    autoSpeak.enabled === undefined
      ? true
      : assertBoolean(autoSpeak.enabled, 'speech.autoSpeak.enabled', sourcePath);

  const autoSpeakCooldownMs =
    autoSpeak.cooldownMs === undefined
      ? 2_000
      : assertNonNegativeInt(autoSpeak.cooldownMs, 'speech.autoSpeak.cooldownMs', sourcePath);

  return {
    enabled,
    path,
    defaultVoice,
    autoSpeak: {
      enabled: autoSpeakEnabled,
      minSeverity: parseAutoSpeakMinSeverity(autoSpeak.minSeverity, sourcePath),
      cooldownMs: autoSpeakCooldownMs,
    },
  };
}

function parseRuntimeConfig(raw: unknown, sourcePath: string): UiRuntimeConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid UI runtime config in ${sourcePath}: expected a JSON object`);
  }

  const eva = raw.eva;
  if (!isRecord(eva)) {
    throw new Error(`Invalid UI runtime config in ${sourcePath}: missing eva section`);
  }

  return {
    eva: {
      wsUrl: assertWsUrl(eva.wsUrl, sourcePath),
    },
    speech: parseSpeechConfig(raw.speech, sourcePath),
    debugOverlay: parseDebugOverlay(raw.debugOverlay, sourcePath),
  };
}

async function fetchConfig(path: string, optional: boolean): Promise<UiRuntimeConfig | null> {
  const response = await fetch(path, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
    },
  });

  if (response.status === 404) {
    if (optional) {
      return null;
    }

    throw new Error(`Missing required runtime config: ${path}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to load ${path}: HTTP ${response.status}`);
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const raw = await response.text();
  const trimmed = raw.trimStart();

  if (contentType.includes('text/html') || trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    if (optional) {
      return null;
    }

    throw new Error(`Invalid runtime config in ${path}: server returned HTML instead of JSON`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Invalid JSON in runtime config: ${path}`);
  }

  return parseRuntimeConfig(payload, path);
}

export async function loadUiRuntimeConfig(): Promise<UiRuntimeConfig> {
  const localConfig = await fetchConfig('/config.local.json', true);
  if (localConfig) {
    return localConfig;
  }

  const defaultConfig = await fetchConfig('/config.json', false);
  if (!defaultConfig) {
    throw new Error('Missing required /config.json runtime config');
  }

  return defaultConfig;
}
