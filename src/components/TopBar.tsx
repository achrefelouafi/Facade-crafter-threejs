import React from 'react';
import { Boxes, Link2, Unlink2, RotateCcw } from 'lucide-react';
import { MetricItem, ProjectConfig } from '../core/types';

interface TopBarProps {
  config: ProjectConfig;
  activePreset: string | null;
  metrics: MetricItem[];
  cameraSync: boolean;
  onSelectPreset: (presetId: string) => void;
  onToggleCameraSync: () => void;
  onResetCamera: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  config,
  activePreset,
  metrics,
  cameraSync,
  onSelectPreset,
  onToggleCameraSync,
  onResetCamera,
}) => {
  return (
    <header className="top-bar">
      <div className="brand">
        <div className="brand-mark">
          <Boxes size={16} />
        </div>
        <span className="brand-title">{config.name}</span>
        <span className="brand-sub">{config.subtitle}</span>
      </div>

      <div className="preset-group" role="group" aria-label="Massing Presets">
        {config.presets.map((p) => (
          <button
            key={p.id}
            className={`preset-btn ${activePreset === p.id ? 'active' : ''}`}
            onClick={() => onSelectPreset(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="stats-strip" aria-label="Live Metrics">
        {metrics.map((m, idx) => (
          <React.Fragment key={m.label}>
            {idx > 0 && <div className="stat-divider" />}
            <div className="stat-item">
              <span className="stat-label">{m.label}</span>
              <span className="stat-value">{m.value}</span>
            </div>
          </React.Fragment>
        ))}
      </div>

      <div className="header-actions">
        <button
          className={`icon-pill-btn ${cameraSync ? 'active' : ''}`}
          onClick={onToggleCameraSync}
          title="Synchronize camera orbit between CAD and PBR views"
        >
          {cameraSync ? <Link2 size={14} /> : <Unlink2 size={14} />}
          <span>Sync Views</span>
        </button>
        <button
          className="icon-pill-btn"
          onClick={onResetCamera}
          title="Reset camera angle on both viewports"
        >
          <RotateCcw size={13} />
          <span>Reset Cam</span>
        </button>
      </div>
    </header>
  );
};
