import React from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Box,
  Layers,
  Magnet,
  Minus,
  Plus,
  Redo2,
  Scissors,
  SquareDashed,
  Undo2,
} from 'lucide-react';
import { MassingFace, MassingScaleConfig, SplitAxis, ToolMode } from '../core/types';
import { dirLabel } from '../core/math2d';

interface MassingToolbarProps {
  scale: MassingScaleConfig;
  toolMode: ToolMode;
  splitAxis: SplitAxis;
  floorSnap: boolean;
  canUndo: boolean;
  canRedo: boolean;
  selectedFace: MassingFace | null;
  onToolChange: (tool: ToolMode) => void;
  onSplitAxisChange: (axis: SplitAxis) => void;
  onToggleFloorSnap: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onResetBox: () => void;
  onQuickExtrude: (distance: number, insetMargin?: number) => void;
  onQuickSplit: () => void;
  onQuickInset: () => void;
}

export const MassingToolbar: React.FC<MassingToolbarProps> = ({
  scale,
  toolMode,
  splitAxis,
  floorSnap,
  canUndo,
  canRedo,
  selectedFace,
  onToolChange,
  onSplitAxisChange,
  onToggleFloorSnap,
  onUndo,
  onRedo,
  onResetBox,
  onQuickExtrude,
  onQuickSplit,
  onQuickInset,
}) => {
  const isVerticalFace =
    selectedFace !== null && (selectedFace.dir === '+y' || selectedFace.dir === '-y');
  const stepDist = isVerticalFace ? scale.verticalSnap : scale.sideStepOut;
  const stepLabel = isVerticalFace ? scale.verticalStepLabel : scale.sideStepLabel;

  return (
    <>
      {selectedFace && (
        <div className="face-inspector">
          <div className="face-inspector-top">
            <span className="face-inspector-title">
              <Box size={13} strokeWidth={1.8} />
              {dirLabel(selectedFace.dir)}
            </span>
            <span className="face-inspector-dims">
              {selectedFace.width.toFixed(2)}m × {selectedFace.height.toFixed(2)}m
            </span>
          </div>

          <div className="face-quick-actions">
            {selectedFace.dir === '-y' && selectedFace.plane > 0.05 && (
              <button
                className="quick-btn primary"
                onClick={() => onQuickExtrude(selectedFace.plane, 0)}
                title="Pull overhang cleanly down to ground (0.0m)"
              >
                <ArrowDownToLine size={12} />
                <span>Drop to Ground</span>
              </button>
            )}
            <button
              className="quick-btn primary"
              onClick={() => onQuickExtrude(stepDist, 0)}
              title="Extrude selected face outward"
            >
              <Plus size={12} />
              <span>{stepLabel}</span>
            </button>
            <button
              className="quick-btn violet"
              onClick={() => onQuickExtrude(stepDist, scale.defaultInset)}
              title="Inset and extrude in one step"
            >
              <Layers size={12} />
              <span>Setback +</span>
            </button>
            <button className="quick-btn" onClick={onQuickSplit} title="Split face into 2">
              <Scissors size={12} />
              <span>Split 1/2</span>
            </button>
            <button className="quick-btn" onClick={onQuickInset} title="Inset face border">
              <SquareDashed size={12} />
              <span>Inset</span>
            </button>
            <button
              className="quick-btn danger"
              onClick={() => onQuickExtrude(-stepDist * 0.75, 0)}
              title="Carve inward"
            >
              <Minus size={12} />
              <span>Carve</span>
            </button>
          </div>

          <div className="face-hint">
            Drag 3D arrow to extrude · Shift+Drag setback · Alt fine {scale.fineSnap}m snap
          </div>
        </div>
      )}

      {toolMode === 'split' && (
        <div className="split-subbar">
          {(['auto', 'u', 'v', 'grid'] as SplitAxis[]).map((axis) => (
            <button
              key={axis}
              className={`sub-chip ${splitAxis === axis ? 'active' : ''}`}
              onClick={() => onSplitAxisChange(axis)}
            >
              {axis === 'auto' ? 'Auto Cut' : axis === 'u' ? 'Cut U' : axis === 'v' ? 'Cut V' : '2×2 Grid'}
            </button>
          ))}
        </div>
      )}

      <div className="bottom-dock" role="toolbar" aria-label="Massing CAD Tools">
        <button className={`dock-btn ${toolMode === 'extrude' ? 'active' : ''}`} onClick={() => onToolChange('extrude')}>
          <ArrowUpFromLine size={13} />
          <span>Extrude</span>
          <span className="kbd-hint">E</span>
        </button>
        <button className={`dock-btn ${toolMode === 'setback' ? 'active-violet' : ''}`} onClick={() => onToolChange('setback')}>
          <Layers size={13} />
          <span>Setback</span>
          <span className="kbd-hint">S</span>
        </button>
        <button className={`dock-btn ${toolMode === 'split' ? 'active-amber' : ''}`} onClick={() => onToolChange('split')}>
          <Scissors size={13} />
          <span>Split</span>
          <span className="kbd-hint">K</span>
        </button>
        <button className={`dock-btn ${toolMode === 'inset' ? 'active' : ''}`} onClick={() => onToolChange('inset')}>
          <SquareDashed size={13} />
          <span>Inset</span>
          <span className="kbd-hint">I</span>
        </button>

        <div className="dock-sep" />

        <button className={`dock-btn ${floorSnap ? 'active' : ''}`} onClick={onToggleFloorSnap}>
          <Magnet size={13} />
          <span>{floorSnap ? scale.snapLabel : `Free ${scale.fineSnap}m`}</span>
        </button>

        <div className="dock-sep" />

        <button className="dock-btn" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">
          <Undo2 size={13} />
        </button>
        <button className="dock-btn" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)">
          <Redo2 size={13} />
        </button>
        <button className="dock-btn" onClick={onResetBox} title="Reset to default">
          <Box size={13} />
          <span>Reset</span>
        </button>
      </div>
    </>
  );
};
