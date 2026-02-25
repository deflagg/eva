import type { UiDebugOverlayConfig } from './config';
import type { FrameEventsMessage } from './types';

export interface DrawOverlayOptions {
  debugOverlayEnabled?: boolean;
  debugOverlay?: UiDebugOverlayConfig;
}

interface SceneChangeBlob {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  areaCells?: number;
  density?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function extractSceneChangeBlobs(message: FrameEventsMessage): SceneChangeBlob[] {
  const blobs: SceneChangeBlob[] = [];

  for (const event of message.events) {
    if (event.name !== 'scene_change' || !isRecord(event.data)) {
      continue;
    }

    const eventBlobs = event.data.blobs;
    if (!Array.isArray(eventBlobs)) {
      continue;
    }

    for (const candidate of eventBlobs) {
      if (!isRecord(candidate)) {
        continue;
      }

      const x1 = asFiniteNumber(candidate.x1);
      const y1 = asFiniteNumber(candidate.y1);
      const x2 = asFiniteNumber(candidate.x2);
      const y2 = asFiniteNumber(candidate.y2);

      if (x1 === null || y1 === null || x2 === null || y2 === null) {
        continue;
      }

      const areaCells = asFiniteNumber(candidate.area_cells ?? candidate.areaCells) ?? undefined;
      const density = asFiniteNumber(candidate.density) ?? undefined;

      const normalizedX1 = clamp01(x1);
      const normalizedY1 = clamp01(y1);
      const normalizedX2 = clamp01(x2);
      const normalizedY2 = clamp01(y2);

      if (normalizedX2 <= normalizedX1 || normalizedY2 <= normalizedY1) {
        continue;
      }

      blobs.push({
        x1: normalizedX1,
        y1: normalizedY1,
        x2: normalizedX2,
        y2: normalizedY2,
        ...(areaCells !== undefined ? { areaCells } : {}),
        ...(density !== undefined ? { density } : {}),
      });
    }
  }

  return blobs;
}

function getOverlayContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return canvas.getContext('2d');
}

export function clearOverlay(canvas: HTMLCanvasElement): void {
  const ctx = getOverlayContext(canvas);
  if (!ctx) {
    return;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function ensureOverlaySize(video: HTMLVideoElement, canvas: HTMLCanvasElement): boolean {
  const displayWidth = Math.max(0, Math.round(video.clientWidth));
  const displayHeight = Math.max(0, Math.round(video.clientHeight));

  if (displayWidth <= 0 || displayHeight <= 0) {
    return false;
  }

  if (canvas.width !== displayWidth) {
    canvas.width = displayWidth;
  }

  if (canvas.height !== displayHeight) {
    canvas.height = displayHeight;
  }

  return true;
}

function drawLabel(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, backgroundColor: string, textColor: string) {
  const labelPaddingX = 6;
  const labelPaddingY = 3;
  const textMetrics = ctx.measureText(label);
  const labelWidth = textMetrics.width + labelPaddingX * 2;
  const labelHeight = 14 + labelPaddingY * 2;
  const drawX = Math.max(0, x);
  const drawY = Math.max(0, y - labelHeight - 2);

  ctx.fillStyle = backgroundColor;
  ctx.fillRect(drawX, drawY, labelWidth, labelHeight);

  ctx.fillStyle = textColor;
  ctx.fillText(label, drawX + labelPaddingX, drawY + labelPaddingY);
}

function drawDebugOverlay(
  ctx: CanvasRenderingContext2D,
  scaleX: number,
  scaleY: number,
  debugOverlay: UiDebugOverlayConfig,
): void {
  ctx.save();
  ctx.font = '12px sans-serif';
  ctx.textBaseline = 'top';

  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.9)';

  for (const [name, region] of Object.entries(debugOverlay.regions)) {
    const x = region.x1 * scaleX;
    const y = region.y1 * scaleY;
    const width = (region.x2 - region.x1) * scaleX;
    const height = (region.y2 - region.y1) * scaleY;

    ctx.strokeRect(x, y, width, height);
    drawLabel(ctx, x, y, `ROI: ${name}`, 'rgba(250, 204, 21, 0.85)', '#422006');
  }

  ctx.setLineDash([10, 4]);
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';

  for (const [name, line] of Object.entries(debugOverlay.lines)) {
    const x1 = line.x1 * scaleX;
    const y1 = line.y1 * scaleY;
    const x2 = line.x2 * scaleX;
    const y2 = line.y2 * scaleY;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    const labelX = (x1 + x2) / 2;
    const labelY = (y1 + y2) / 2;
    drawLabel(ctx, labelX, labelY, `Line: ${name}`, 'rgba(56, 189, 248, 0.9)', '#082f49');
  }

  ctx.restore();
}

export function drawSceneChangeOverlay(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  message: FrameEventsMessage,
  options: DrawOverlayOptions = {},
): void {
  if (!ensureOverlaySize(video, canvas)) {
    return;
  }

  const ctx = getOverlayContext(canvas);
  if (!ctx) {
    return;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const sourceWidth = Math.max(1, message.width);
  const sourceHeight = Math.max(1, message.height);
  const scaleX = video.clientWidth / sourceWidth;
  const scaleY = video.clientHeight / sourceHeight;

  if (options.debugOverlayEnabled && options.debugOverlay) {
    drawDebugOverlay(ctx, scaleX, scaleY, options.debugOverlay);
  }

  const blobs = extractSceneChangeBlobs(message);
  if (blobs.length === 0) {
    return;
  }

  ctx.lineWidth = 2;
  ctx.strokeStyle = '#f97316';
  ctx.fillStyle = 'rgba(249, 115, 22, 0.14)';
  ctx.font = '12px sans-serif';
  ctx.textBaseline = 'top';

  for (const blob of blobs) {
    const sourceX1 = blob.x1 * sourceWidth;
    const sourceY1 = blob.y1 * sourceHeight;
    const sourceX2 = blob.x2 * sourceWidth;
    const sourceY2 = blob.y2 * sourceHeight;

    const drawX = sourceX1 * scaleX;
    const drawY = sourceY1 * scaleY;
    const drawWidth = Math.max(1, (sourceX2 - sourceX1) * scaleX);
    const drawHeight = Math.max(1, (sourceY2 - sourceY1) * scaleY);

    ctx.fillRect(drawX, drawY, drawWidth, drawHeight);
    ctx.strokeRect(drawX, drawY, drawWidth, drawHeight);

    const details: string[] = [];
    if (blob.areaCells !== undefined) {
      details.push(`cells=${Math.round(blob.areaCells)}`);
    }
    if (blob.density !== undefined) {
      details.push(`density=${blob.density.toFixed(2)}`);
    }

    const label = details.length > 0 ? `change (${details.join(', ')})` : 'change';
    drawLabel(ctx, drawX, drawY, label, 'rgba(249, 115, 22, 0.9)', '#431407');
  }
}
