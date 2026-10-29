export async function writeClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Local HTTP deployments and browser permissions may require the legacy path.
    }
  }
  const activeElement = document.activeElement;
  const selection = window.getSelection();
  const ranges = Array.from({ length: selection?.rangeCount || 0 }, (_, index) => (
    selection.getRangeAt(index).cloneRange()
  ));
  const input = document.createElement('textarea');
  input.value = text;
  input.readOnly = true;
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
  document.body.appendChild(input);
  try {
    input.select();
    if (!document.execCommand?.('copy')) {
      throw new Error('浏览器未允许写入剪贴板，请允许剪贴板访问后重试');
    }
  } finally {
    input.remove();
    activeElement?.focus({ preventScroll: true });
    selection?.removeAllRanges();
    ranges.forEach((range) => selection?.addRange(range));
  }
}
