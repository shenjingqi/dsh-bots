export const MAX_STICKER_BYTES = 512 * 1024;

export function staticSticker(message) {
  const s = message.sticker;
  const id = message.from?.id;
  return message.chat?.type === 'private' && Number.isSafeInteger(id) && id > 0 && message.chat.id === id &&
    !message.photo && s?.is_animated === false && s.is_video === false && typeof s.file_id === 'string' &&
    /^[\w-]{1,512}$/.test(s.file_id) && !(s.file_size > MAX_STICKER_BYTES) ? s.file_id : null;
}

export async function fetchStaticSticker(fileId, { getFile, fetchFile, signal }) {
  const invalid = () => new Error('Telegram sticker unavailable or not a bounded static WebP');
  signal?.throwIfAborted();
  const file = await getFile(fileId, signal);
  signal?.throwIfAborted();
  const path = file?.file_path;
  if (typeof path !== 'string' || path.length > 256 || !/^(?:[\w-]+\/)*[\w-]+\.webp$/i.test(path) || file.file_size > MAX_STICKER_BYTES) throw invalid();
  const res = await fetchFile(path, signal).catch((error) => {
    if (signal?.aborted) throw error;
    throw Object.assign(invalid(), { retrySticker: true });
  });
  if (!res.ok || Number(res.headers.get('content-length')) > MAX_STICKER_BYTES || !res.body) {
    void res.body?.cancel().catch(() => {});
    if (res.status >= 500) throw Object.assign(invalid(), { retrySticker: true });
    throw invalid();
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_STICKER_BYTES) throw invalid();
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  if (size < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.readUInt32LE(4) + 8 !== size || bytes.toString('ascii', 8, 12) !== 'WEBP') throw invalid();
  let frame = false;
  for (let pos = 12; pos < size;) {
    if (size - pos < 8) throw invalid();
    const kind = bytes.toString('ascii', pos, pos + 4);
    const len = bytes.readUInt32LE(pos + 4);
    const next = pos + 8 + len + (len & 1);
    if (next > size || kind === 'ANIM' || kind === 'ANMF' || (kind === 'VP8X' && (len !== 10 || (bytes[pos + 8] & 2)))) throw invalid();
    if (kind === 'VP8 ' || kind === 'VP8L') {
      if (frame || !len) throw invalid();
      frame = true;
    }
    pos = next;
  }
  if (!frame) throw invalid();
  return { mediaType: 'image/webp', data: bytes.toString('base64'), name: 'sticker.webp' };
}
