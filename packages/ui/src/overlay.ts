import type { UiDebugOverlayConfig } from './config';
import type { DetectionsMessage } from './types';

export interface DrawOverlayOptions {
  debugOverlayEnabled?: boolean;
  debugOverlay?: UiDebugOverlayConfig;
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

export function drawDetectionsOverlay(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  message: DetectionsMessage,
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

  const scaleX = video.clientWidth / message.width;
  const scaleY = video.clientHeight / message.height;

  if (options.debugOverlayEnabled && options.debugOverlay) {
    drawDebugOverlay(ctx, scaleX, scaleY, options.debugOverlay);
  }

  if (!message.detections.length) {
    return;
  }

  ctx.lineWidth = 2;
  ctx.strokeStyle = '#22c55e';
  ctx.font = '14px sans-serif';
  ctx.textBaseline = 'top';

  for (const detection of message.detections) {
    const [x1, y1, x2, y2] = detection.box;
    const drawX = x1 * scaleX;
    const drawY = y1 * scaleY;
    const drawWidth = (x2 - x1) * scaleX;
    const drawHeight = (y2 - y1) * scaleY;

    ctx.strokeRect(drawX, drawY, drawWidth, drawHeight);

    const label = `${detection.name} ${(detection.conf * 100).toFixed(0)}%`;
    drawLabel(ctx, drawX, drawY, label, 'rgba(34, 197, 94, 0.85)', '#052e16');
  }
}
