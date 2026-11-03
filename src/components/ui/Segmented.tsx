import { motion } from 'motion/react';
import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { SPRING } from '../../lib/motion';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
  shortcut?: string;
  highlight?: boolean;
}

interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  className?: string;
  ariaLabel: string;
}

/** Apple-artige Segmentsteuerung mit gleitender Auswahl. */
export function Segmented<T extends string>({ options, value, onChange, size = 'md', className, ariaLabel }: SegmentedProps<T>) {
  const layoutId = useId();
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-[10px] bg-surface-3 p-[3px]', className)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative flex shrink-0 items-center gap-1.5 rounded-[8px] font-semibold transition-[color,transform] duration-100 active:scale-[0.97]',
              size === 'md' ? 'h-8 px-3.5 text-[13px]' : 'h-7 px-3 text-[12.5px]',
              active ? 'text-ink' : 'text-ink-3 hover:text-ink',
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-[8px] bg-surface-4 shadow-[0_1px_2px_rgb(0_0_0/0.4)]"
                transition={SPRING}
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {option.label}
              {option.count !== undefined && (
                <span
                  className={cn(
                    'min-w-[18px] rounded-full px-1 text-center text-[11px] tabular-nums',
                    active ? 'bg-white/10 text-ink' : 'bg-surface-3 text-ink-3',
                  )}
                >
                  {option.count}
                </span>
              )}
              {option.highlight && !active && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
              {option.shortcut && (
                <span className={cn('hidden text-[11px] md:inline', active ? 'text-ink-2' : 'text-ink-4')}>{option.shortcut}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
