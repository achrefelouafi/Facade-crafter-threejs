import React from 'react';
import { Layers, Moon, Sparkles, Sun, Sunrise, SlidersHorizontal } from 'lucide-react';
import { LightingKey, ProjectConfig, StyleKey } from '../core/types';

interface RightControlsProps {
  config: ProjectConfig;
  style: StyleKey;
  lighting: LightingKey;
  postFX: boolean;
  toggleA: boolean;
  toggleB: boolean;
  onStyleChange: (style: StyleKey) => void;
  onLightingChange: (lighting: LightingKey) => void;
  onTogglePostFX: () => void;
  onToggleA: () => void;
  onToggleB: () => void;
}

export const RightControls: React.FC<RightControlsProps> = ({
  config,
  style,
  lighting,
  postFX,
  toggleA,
  toggleB,
  onStyleChange,
  onLightingChange,
  onTogglePostFX,
  onToggleA,
  onToggleB,
}) => {
  const renderIcon = (kind: 'sun' | 'sunrise' | 'moon') => {
    if (kind === 'sun') return <Sun size={13} />;
    if (kind === 'sunrise') return <Sunrise size={13} />;
    return <Moon size={13} />;
  };

  return (
    <div className="bottom-dock" role="toolbar" aria-label="PBR Studio Controls">
      {config.styles.map((s) => (
        <button
          key={s.id}
          className={`dock-btn ${style === s.id ? 'active' : ''}`}
          onClick={() => onStyleChange(s.id)}
        >
          <span>{s.label}</span>
        </button>
      ))}

      <div className="dock-sep" />

      {config.lightingOptions.map((l) => (
        <button
          key={l.id}
          className={`dock-btn ${lighting === l.id ? l.activeClass : ''}`}
          onClick={() => onLightingChange(l.id)}
          title={l.title}
        >
          {renderIcon(l.icon)}
          <span>{l.label}</span>
        </button>
      ))}

      <div className="dock-sep" />

      <button
        className={`dock-btn ${postFX ? 'active' : ''}`}
        onClick={onTogglePostFX}
        title="Toggle WebGPU GTAO + Film Grade"
      >
        <Sparkles size={13} />
        <span>GTAO</span>
      </button>

      <button
        className={`dock-btn ${toggleA ? 'active' : ''}`}
        onClick={onToggleA}
        title={config.toggleA.title}
      >
        <Layers size={13} />
        <span>{config.toggleA.label}</span>
      </button>

      <button
        className={`dock-btn ${toggleB ? 'active' : ''}`}
        onClick={onToggleB}
        title={config.toggleB.title}
      >
        <SlidersHorizontal size={13} />
        <span>{config.toggleB.label}</span>
      </button>
    </div>
  );
};
