import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  getExplainer,
  CATEGORY_COLORS,
} from '../../config/therapist-categories';
import { UI } from '../../config/constants';

export interface CategoryBadgeProps {
  type: string;
  categoryType: 'approach' | 'style' | 'areasOfFocus';
}

export function CategoryBadge({ type, categoryType }: CategoryBadgeProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number } | null>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const explainer = getExplainer(categoryType, type);
  const colorClass = CATEGORY_COLORS[categoryType];

  useEffect(() => {
    if (showTooltip && badgeRef.current) {
      const rect = badgeRef.current.getBoundingClientRect();
      setTooltipPosition({
        top: rect.top - 8,
        left: rect.left + rect.width / 2,
      });
    } else if (!showTooltip) {
      setTooltipPosition(null);
    }
  }, [showTooltip]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setShowTooltip((prev) => !prev);
    }
  };

  return (
    <div className="relative inline-block">
      <span
        ref={badgeRef}
        className={`inline-block px-2.5 py-[3px] text-xs font-medium rounded-full border cursor-help ${colorClass}`}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        onFocus={() => setShowTooltip(true)}
        onBlur={() => setShowTooltip(false)}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="button"
        aria-describedby={explainer ? `tooltip-${type.replace(/\s/g, '-')}` : undefined}
      >
        {type}
      </span>
      {showTooltip && explainer && createPortal(
        <div
          id={`tooltip-${type.replace(/\s/g, '-')}`}
          role="tooltip"
          className="fixed px-3 py-2 text-xs text-white bg-spill-grey-600 rounded-lg shadow-lg max-w-xs whitespace-normal pointer-events-none"
          style={{
            zIndex: UI.Z_INDEX.TOOLTIP,
            top: tooltipPosition?.top ?? 0,
            left: tooltipPosition?.left ?? 0,
            transform: 'translate(-50%, -100%)',
            visibility: tooltipPosition ? 'visible' : 'hidden',
          }}
        >
          {explainer}
          <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1">
            <div className="border-4 border-transparent border-t-spill-grey-600"></div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
