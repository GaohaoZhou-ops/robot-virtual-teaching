import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Cable, LoaderCircle } from 'lucide-react';

export default function IPadScreenInvitation({ enabled, request, canAccept, onAccept }) {
  const [invitation, setInvitation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false), dialogRef = useRef(null), rejectRef = useRef(null);

  useEffect(() => {
    if (!enabled) { setInvitation(null); return; }
    let cancelled = false, timer, polling = false;
    const poll = async () => {
      if (cancelled || polling) return;
      clearTimeout(timer);
      polling = true;
      try {
        if (!document.hidden && !busyRef.current) {
          const result = await request('/invitations');
          if (!cancelled && !busyRef.current) {
            const next = result.invitations?.[0] || null;
            setInvitation((previous) => previous?.invitationId === next?.invitationId && previous?.deviceId === next?.deviceId ? previous : next);
          }
        }
      } catch { if (!cancelled && !busyRef.current) setInvitation(null); }
      finally { polling = false; if (!cancelled) timer = setTimeout(poll, 2000); }
    };
    const visible = () => { if (!document.hidden) void poll(); };
    void poll(); document.addEventListener('visibilitychange', visible);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [enabled, request]);

  useEffect(() => {
    if (!invitation) return;
    setError('');
    const previous = document.activeElement;
    dialogRef.current?.focus();
    const keydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); rejectRef.current?.(); }
      if (event.key !== 'Tab') return;
      const controls = [...(dialogRef.current?.querySelectorAll('button:not(:disabled)') || [])];
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus(); }
    };
    const dialog = dialogRef.current; dialog?.addEventListener('keydown', keydown);
    return () => { dialog?.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [invitation?.invitationId]);

  const respond = async (accept) => {
    if (!invitation || busyRef.current || (accept && !canAccept)) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      if (accept) {
        const result = await onAccept(invitation);
        if (!result?.success) throw new Error(result?.error || '邀请未能建立，请重新发起。');
      } else {
        await request('/invitations/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: invitation.deviceId, invitationId: invitation.invitationId }) });
      }
      setInvitation(null);
    } catch (failure) { setError(failure.message); }
    finally { busyRef.current = false; setBusy(false); }
  };
  rejectRef.current = () => respond(false);
  if (!enabled || !invitation) return null;
  return createPortal(<div className="ipad-screen-backdrop ipad-screen-invitation-backdrop">
    <section className="ipad-screen-dialog ipad-screen-invitation-dialog" role="dialog" aria-modal="true"
      aria-labelledby="ipad-screen-invitation-title" aria-describedby="ipad-screen-invitation-detail" ref={dialogRef} tabIndex={-1}>
      <header><span className="ipad-screen-mark"><Cable size={24}/></span><div><small>USB INVITATION</small>
        <h2 id="ipad-screen-invitation-title">接受 iPad 的协作邀请？</h2></div></header>
      <p className="ipad-screen-intro" id="ipad-screen-invitation-detail"><strong>{invitation.deviceName}</strong> 希望通过数据线协作本页工程。接受后将共享相机画面和 3D 视图，并允许设备协作调整虚拟机器人关节、记录姿态。</p>
      {!canAccept && <p className="ipad-screen-notice">当前工程尚未就绪。请先关闭邀请，打开示教工程并加载带双臂相机的机器人，再重新邀请。</p>}
      {error && <p className="ipad-screen-error" role="alert">{error}</p>}
      <footer><small>确认前不会共享画面或开放控制</small><div className="ipad-screen-actions">
        <button type="button" disabled={busy} onClick={() => respond(false)}>拒绝</button>
        <button type="button" className="ipad-screen-primary" disabled={busy || !canAccept} onClick={() => respond(true)}>
          {busy && <LoaderCircle size={15} className="is-spinning"/>}接受邀请</button>
      </div></footer>
    </section>
  </div>, document.body);
}
