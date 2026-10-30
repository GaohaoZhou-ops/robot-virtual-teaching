import { useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, FileArchive, FolderOpen, History, LoaderCircle, X } from 'lucide-react';
import { listRecentProjects, RECENT_PROJECT_LIMIT, RECENT_PROJECTS_CHANGED, removeRecentProject } from '../model/recentProjects.js';
import './RecentProjects.css';

const formatTime = (value) => value ? new Date(value).toLocaleString('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}) : '较早记录';

export default function RecentProjects({ disabled, openingId, onOpen }) {
  const [expanded, setExpanded] = useState(true);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [removingId, setRemovingId] = useState(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await listRecentProjects();
        if (active) { setRecords(next); setError(''); }
      } catch {
        if (active) setError('无法读取最近工程，请检查浏览器存储权限后重试。');
      } finally {
        if (active) setLoading(false);
      }
    };
    refresh();
    window.addEventListener(RECENT_PROJECTS_CHANGED, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.removeEventListener(RECENT_PROJECTS_CHANGED, refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const remove = async (id) => {
    setRemovingId(id);
    try { await removeRecentProject(id); }
    catch { setError('移除记录失败，请重试。'); }
    finally { setRemovingId(null); }
  };

  return (
    <section className="recent-projects" aria-label="最近工程">
      <button type="button" className="recent-projects__toggle" aria-expanded={expanded}
        aria-controls="recent-projects-list" onClick={() => setExpanded((value) => !value)}>
        <History size={16} />
        <strong>最近工程</strong>
        <span>{records.length} / {RECENT_PROJECT_LIMIT}</span>
        <ChevronDown size={15} className={expanded ? 'is-expanded' : ''} />
      </button>
      {expanded && <div id="recent-projects-list">
        <p className="recent-projects__hint">最近保存或打开的本地工程，按最近使用排序。</p>
        {error && <p className="recent-projects__error" role="alert">{error}</p>}
        {loading ? <p className="recent-projects__empty" role="status">正在读取最近工程…</p>
          : !records.length && !error ? <p className="recent-projects__empty">暂无历史工程。保存工程到本地后，会自动显示在这里。</p> : null}
        {records.length > 0 && <ol className="recent-projects__list">
          {records.map((record) => <li key={record.id} data-recent-project-id={record.id}>
            <button type="button" className="recent-projects__open" disabled={disabled || Boolean(removingId)}
              onClick={() => onOpen(record)} aria-label={`打开最近工程 ${record.name}`}>
              <span className="recent-projects__icon">{openingId === record.id ? <LoaderCircle size={18} />
                : record.kind === 'directory' ? <FolderOpen size={18} /> : <FileArchive size={18} />}</span>
              <span className="recent-projects__copy">
                <strong title={record.name}>{record.name}</strong>
                <span className="recent-projects__path" title={`${record.path}\n${record.kind === 'directory' ? '相对于所选目录的路径' : '浏览器仅提供文件名，无法获取磁盘绝对路径'}`}>{record.path}</span>
                <span className="recent-projects__meta">
                  <span>{record.teachingSpaceMode === 'independent' ? '独立示教' : '地图示教'}</span>
                  <span>{record.kind === 'directory' ? '工程目录' : record.source === 'download' ? '下载文件' : '工程文件'}</span>
                  {!record.handle && <em>需重新选择{record.kind === 'directory' ? '目录' : '文件'}</em>}
                  <time dateTime={record.updatedAt || undefined} title={record.updatedAt ? new Date(record.updatedAt).toLocaleString('zh-CN') : '历史工程未记录时间'}>{formatTime(record.updatedAt)}</time>
                </span>
              </span>
              <ArrowRight size={14} />
            </button>
            <button type="button" className="recent-projects__remove" disabled={disabled || Boolean(removingId)}
              onClick={() => remove(record.id)} aria-label={`移除最近工程记录 ${record.name}`} title="从历史中移除（保留本地文件）"><X size={14} /></button>
          </li>)}
        </ol>}
        {records.length > 0 && <p className="recent-projects__hint">路径显示浏览器可提供的文件名或目录相对路径。</p>}
      </div>}
    </section>
  );
}
