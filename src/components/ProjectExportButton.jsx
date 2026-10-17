import { FileArchive, LoaderCircle } from 'lucide-react';

export default function ProjectExportButton({ mapData, exportState, disabled = false, onExport }) {
  const packing = exportState?.status === 'packing';
  const selecting = exportState?.status === 'selecting';
  const busy = packing || selecting;
  const progress = Math.round(Math.max(0, Math.min(1, exportState?.progress || 0)) * 100);
  return (
    <button
      type="button"
      className="action-button project-export-action"
      aria-label="导出工程"
      aria-busy={busy}
      data-project-export-state={exportState?.status || 'idle'}
      data-project-export-phase={exportState?.phase || ''}
      disabled={disabled || !mapData?.geometry || busy}
      onClick={onExport}
      title={busy
        ? `${exportState.phase || '正在打包工程'}${exportState.detail ? ` · ${exportState.detail}` : ''}`
        : mapData?.geometry
          ? '选择保存位置和工程名称，导出包含地图、机器人、示教与视觉资源的完整 ZIP'
          : '请先加载完整地图或物体模型'}
    >
      {busy ? <LoaderCircle className="is-spinning" size={15} /> : <FileArchive size={15} />}
      <span>{selecting ? '选择保存位置…' : packing ? `导出中 ${progress}%` : '导出工程'}</span>
    </button>
  );
}
