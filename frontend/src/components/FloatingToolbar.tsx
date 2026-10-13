// Electron window controls inside the top bar (the drag region is .top-bar;
// this group is no-drag). Rendered only when window.electronAPI exists.
interface Props {
  onOpenSettings: () => void;
}

export default function FloatingToolbar({ onOpenSettings }: Props) {
  const api = window.electronAPI;
  if (!api) return null;

  return (
    <div className="ft-btns">
      <button className="ft-btn" onClick={onOpenSettings} title="DeepSeek settings" aria-label="Open DeepSeek settings">⚙</button>
      <button className="ft-btn" onClick={() => api.minimize()} title="Minimize">─</button>
      <button className="ft-btn" onClick={() => api.hide()} title="Hide (Cmd+Shift+Space to show again)">👁</button>
      <button className="ft-btn danger" onClick={() => api.close()} title="Quit">✕</button>
    </div>
  );
}
