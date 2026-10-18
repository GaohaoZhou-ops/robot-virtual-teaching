import { Move3D, Rotate3D } from 'lucide-react';

export default function ViewportInteractionModeButton({ mode, shiftPanArmed, onClick, className = '' }) {
  const persistentPan = mode === 'pan', temporaryPan = shiftPanArmed && !persistentPan;
  return <button
    type="button"
    className={`viewer-interaction-mode is-active ${temporaryPan ? 'is-temporary' : ''} ${persistentPan ? 'is-pan-mode' : ''} ${className}`}
    aria-label={temporaryPan ? 'Shift 临时平移' : persistentPan ? '平移' : '旋转'}
    aria-pressed="true"
    aria-keyshortcuts="Shift"
    data-base-mode={mode}
    data-mode={shiftPanArmed ? 'shift-pan' : mode}
    data-switchable="true"
    onClick={onClick}
    title={temporaryPan
      ? 'Shift 已按下：左键拖拽临时平移，松开后恢复旋转'
      : persistentPan
        ? '平移模式：左键拖拽平移；点击切换为旋转'
        : '旋转模式：左键拖拽旋转；点击切换为平移；按住 Shift 临时平移'}
  >
    {persistentPan || shiftPanArmed ? <Move3D size={13} /> : <Rotate3D size={13} />}
    {temporaryPan ? 'Shift 平移' : persistentPan ? '平移' : '旋转'}
  </button>;
}
