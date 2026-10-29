// Single-finger input stays with the existing rotate/pick tools. Two fingers
// take over camera navigation until all fingers lift, without changing any
// mouse, wheel, keyboard or trackpad handlers.
export function createViewportTouchNavigation({ controls, navigation, onStart = () => {}, onCancel = () => {}, onChange = () => {}, onEnd = () => {} }) {
  const canvas = controls.domElement, pointers = new Map();
  let active = false, previous = null, frame = 0, releasing = false, suppressClickUntil = 0;
  canvas.dataset.touchNavigation = 'pinch-zoom-two-finger-pan';
  const consume = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const measure = () => {
    if (pointers.size !== 2) return null;
    const [a, b] = pointers.values();
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const flush = () => {
    cancelAnimationFrame(frame); frame = 0;
    const next = measure();
    if (!active || !previous || !next) return;
    const zoomed = previous.distance > 1 && next.distance > 1 && navigation.applyZoomFactor(previous.distance / next.distance);
    const panned = navigation.panByPixels(next.x - previous.x, next.y - previous.y);
    previous = next;
    if (zoomed || panned) {
      canvas.dataset.lastPointerGesture = 'touch-zoom-pan';
      if (zoomed) canvas.dataset.lastZoomSource = 'touch-pinch';
      onChange();
    }
  };
  const capture = (id) => { try { canvas.setPointerCapture(id); } catch { /* The pointer may have just been cancelled. */ } };
  const release = (id) => {
    if (canvas.hasPointerCapture(id)) {
      releasing = true;
      try { canvas.releasePointerCapture(id); } catch { /* Browser cancellation can release it first. */ }
      finally { releasing = false; }
    }
  };
  const stopNativeDrag = () => {
    controls.state = -1; controls.keyState = -1;
    controls._movePrev.copy(controls._moveCurr);
    controls._pointers.length = 0; controls._pointerPositions = {};
    canvas.removeEventListener('pointermove', controls._onPointerMove);
    canvas.removeEventListener('pointerup', controls._onPointerUp);
  };
  const start = (event) => {
    if (event.pointerType !== 'touch') return;
    flush();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size < 2 && !active) return;
    if (!active) {
      // Cancel the first finger's native drag before retaining both pointers.
      // Internal capture releases must not look like browser cancellation.
      releasing = true;
      try { onStart(); } finally { releasing = false; }
      stopNativeDrag();
      active = true;
    }
    for (const id of pointers.keys()) capture(id);
    previous = measure();
    canvas.dataset.pointerGestureState = 'touch-navigation';
    consume(event);
  };
  const move = (event) => {
    if (event.pointerType !== 'touch' || !pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!active) return;
    consume(event);
    // A browser emits one pointermove per finger. Coalesce them so a symmetric
    // pinch does not introduce a spurious pan between those two events.
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const end = (event) => {
    if (!pointers.has(event.pointerId)) return;
    flush(); pointers.delete(event.pointerId);
    if (!active) return;
    consume(event); release(event.pointerId); previous = measure();
    suppressClickUntil = performance.now() + 500;
    if (!pointers.size) {
      active = false; canvas.dataset.pointerGestureState = 'ended'; onEnd();
    }
  };
  const lostCapture = (event) => {
    if (releasing) { if (pointers.has(event.pointerId)) consume(event); return; }
    end(event);
  };
  const click = (event) => {
    if (performance.now() < suppressClickUntil && (event.pointerType === 'touch' || event.sourceCapabilities?.firesTouchEvents || !event.pointerType)) consume(event);
  };
  const reset = () => {
    cancelAnimationFrame(frame); frame = 0;
    if (pointers.size) {
      releasing = true;
      try { onCancel(); stopNativeDrag(); } finally { releasing = false; }
    }
    for (const id of pointers.keys()) release(id);
    const wasActive = active; pointers.clear(); previous = null; active = false;
    if (wasActive) { canvas.dataset.pointerGestureState = 'cancelled'; onEnd(); }
  };
  const visibility = () => { if (document.hidden) reset(); };
  const listeners = [['pointerdown', start], ['pointermove', move], ['pointerup', end], ['pointercancel', end],
    ['lostpointercapture', lostCapture], ['click', click], ['dblclick', click]];
  for (const [name, listener] of listeners) canvas.addEventListener(name, listener, { capture: true, passive: false });
  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', visibility);
  return () => {
    reset();
    for (const [name, listener] of listeners) canvas.removeEventListener(name, listener, true);
    window.removeEventListener('blur', reset);
    document.removeEventListener('visibilitychange', visibility);
  };
}
