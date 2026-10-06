// Shared mic stream so the browser only prompts once per page.
let streamPromise: Promise<MediaStream> | null = null;

export function getMicStream(): Promise<MediaStream> {
  if (!streamPromise) {
    if (!navigator.mediaDevices?.getUserMedia) {
      streamPromise = Promise.reject(new Error('getUserMedia is not supported in this browser'));
    } else {
      streamPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
        video: false,
      });
    }
  }
  return streamPromise;
}

export async function releaseMic(): Promise<void> {
  if (!streamPromise) return;
  try {
    const stream = await streamPromise;
    stream.getTracks().forEach((t) => t.stop());
  } catch { /* ignore */ }
  streamPromise = null;
}
