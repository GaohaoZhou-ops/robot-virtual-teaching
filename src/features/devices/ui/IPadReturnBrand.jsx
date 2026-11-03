import { ChevronLeft, Route } from 'lucide-react';
import { isIPadWorkbench, returnToIPadApp } from '../model/ipadWorkbenchLibrary.js';
import './IPadReturnBrand.css';

// Only the native iPad workbench installs this bridge. Ordinary browsers keep
// the same non-interactive brand, including Safari on iPad and iPhone.
export default function IPadReturnBrand({ className, markClassName, iconSize = 20, strokeWidth = 1.8, children }) {
  const canReturn = isIPadWorkbench();
  const Brand = canReturn ? 'button' : 'div';
  const Mark = markClassName ? 'div' : 'span';
  const Icon = canReturn ? ChevronLeft : Route;
  return (
    <Brand
      className={`${className}${canReturn ? ' ipad-return-brand' : ''}`}
      type={canReturn ? 'button' : undefined}
      aria-label={canReturn ? '虚拟示教平台，返回应用' : undefined}
      title={canReturn ? '保存并返回 Atlas 示教' : undefined}
      onClick={canReturn ? returnToIPadApp : undefined}
    >
      <Mark className={markClassName}><Icon size={iconSize} strokeWidth={strokeWidth} /></Mark>
      <div>{children}</div>
    </Brand>
  );
}
