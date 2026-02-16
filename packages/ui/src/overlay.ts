import type { DetectionsMessage } from './types';

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

export function drawDetectionsOverlay(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  message: DetectionsMessage,
): void {
  if (!ensureOverlaySize(video, canvas)) {
    return;
  }

  const ctx = getOverlayContext(canvas);
  if (!ctx) {
    return;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!message.detections.length) {
    return;
  }

  const scaleX = video.clientWidth / message.width;
  const scaleY = video.clientHeight / message.height;

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
    const labelPaddingX = 6;
    const labelPaddingY = 4;
    const textMetrics = ctx.measureText(label);
    const labelWidth = textMetrics.width + labelPaddingX * 2;
    const labelHeight = 16 + labelPaddingY * 2;
    const labelX = Math.max(0, drawX);
    const labelY = Math.max(0, drawY - labelHeight - 2);

    ctx.fillStyle = 'rgba(34, 197, 94, 0.85)';
    ctx.fillRect(labelX, labelY, labelWidth, labelHeight);

    ctx.fillStyle = '#052e16';
    ctx.fillText(label, labelX + labelPaddingX, labelY + labelPaddingY);
  }
}
