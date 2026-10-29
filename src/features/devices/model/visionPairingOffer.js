import { ipadRequest } from "./ipadTeaching.js";

function publisherID() {
  // getRandomValues is also available when the desktop page uses LAN HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Closing the dialog withdraws this window's offer. A lost browser connection
// also expires naturally, without keeping plaintext pairing codes on disk.
export function publishVisionPairingOffer(ticket, onStatus) {
  let publisherId = publisherID();
  const route = `/sessions/${ticket.id}/vision-pairing`;
  let active = true, pending = false;
  const publish = async () => {
    if (!active || pending) return;
    pending = true;
    try {
      await ipadRequest(route, { method: 'POST', token: ticket.ownerToken,
        body: { publisherId, code: ticket.pairingCode }, signal: AbortSignal.timeout(5000) });
      if (active) onStatus('选择这台电脑后，配对码会自动填入 Vision Pro。');
    } catch {
      if (active) onStatus('自动填码暂不可用，正在重试；也可在 Vision Pro 手动输入下方配对码。');
    } finally { pending = false; }
  };
  const withdraw = () => {
    if (!active) return;
    active = false; clearInterval(timer);
    ipadRequest(route, { method: 'DELETE', token: ticket.ownerToken, body: { publisherId },
      keepalive: true, signal: AbortSignal.timeout(5000) }).catch(() => {});
  };
  let timer = setInterval(publish, 10_000);
  const restore = event => {
    if (!event.persisted || active) return;
    publisherId = publisherID(); active = true;
    timer = setInterval(publish, 10_000); publish();
  };
  publish();
  window.addEventListener('pagehide', withdraw);
  window.addEventListener('pageshow', restore);
  return () => {
    window.removeEventListener('pagehide', withdraw); window.removeEventListener('pageshow', restore); withdraw();
  };
}
