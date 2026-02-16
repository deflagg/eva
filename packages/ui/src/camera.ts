export interface CapturedJpegFrame {
  mime: 'image/jpeg';
  width: number;
  height: number;
  image_bytes: Uint8Array;
}

export function isCameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

export async function startCamera(videoElement: HTMLVideoElement): Promise<MediaStream> {
  if (!isCameraSupported()) {
    throw new Error('Camera API is not available in this browser.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: 'user',
    },
  });

  videoElement.srcObject = stream;
  await videoElement.play();

  return stream;
}

export function stopCamera(stream: MediaStream | null): void {
  if (!stream) {
    return;
  }

  for (const track of stream.getTracks()) {
    track.stop();
  }
}

export async function captureJpegFrame(
  videoElement: HTMLVideoElement,
  captureCanvas: HTMLCanvasElement,
  quality = 0.8,
): Promise<CapturedJpegFrame | null> {
  const width = videoElement.videoWidth;
  const height = videoElement.videoHeight;

  if (width <= 0 || height <= 0) {
    return null;
  }

  if (captureCanvas.width !== width) {
    captureCanvas.width = width;
  }

  if (captureCanvas.height !== height) {
    captureCanvas.height = height;
  }

  const ctx = captureCanvas.getContext('2d');
  if (!ctx) {
    return null;
  }

  ctx.drawImage(videoElement, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => {
    captureCanvas.toBlob(resolve, 'image/jpeg', quality);
  });

  if (!blob) {
    return null;
  }

  const image_bytes = new Uint8Array(await blob.arrayBuffer());

  return {
    mime: 'image/jpeg',
    width,
    height,
    image_bytes,
  };
}
