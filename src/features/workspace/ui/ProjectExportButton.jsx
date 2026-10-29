import { FileArchive, LoaderCircle, Save } from 'lucide-react';

export default function ProjectExportButton({ mapData, exportState, disabled = false, onExport,
  overwrite = false, saveTarget = null, label = overwrite ? '保存工程' : '导出工程' }) {
  const packing = exportState?.status === 'packing';
  const selecting = exportState?.status === 'selecting';
  const busy = packing || selecting;
  const active = busy && (exportState?.operation === 'save') === overwrite;
  const Icon = overwrite ? Save : FileArchive;
  const progress = Math.round(Math.max(0, Math.min(1, exportState?.progress || 0)) * 100);
  return (
    <button
      type="button"
      className="action-button project-export-action"
      aria-label={label}
      aria-busy={active}
      data-project-export-state={exportState?.status || 'idle'}
      data-project-export-phase={exportState?.phase || ''}
      disabled={disabled || !mapData?.geometry || busy || (overwrite && !saveTarget)}
      onClick={onExport}
      title={busy
        ? `${exportState.phase || '正在打包工程'}${exportState.detail ? ` · ${exportState.detail}` : ''}`
        : !mapData?.geometry ? '请先加载完整地图或物体模型'
          : overwrite ? saveTarget
            ? `覆盖保存到 ${saveTarget.name}`
            : '请先通过“另存为工程”选择可写入的工程文件'
          : '选择保存位置和工程名称，保存包含地图、机器人、示教与视觉资源的完整 ZIP'}
    >
      {active ? <LoaderCircle className="is-spinning" size={15} /> : <Icon size={15} />}
      <span>{active ? selecting ? '等待文件授权…' : `保存中 ${progress}%` : label}</span>
    </button>
  );
}
