import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Kbd } from './Kbd';

type Variant = 'primary' | 'secondary' | 'ghost' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'xl';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  /** Tastaturkürzel, das als kleiner Hinweis im Button erscheint. */
  shortcut?: string;
  shortcutPosition?: 'start' | 'end';
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-ink text-black hover:bg-white shadow-[0_1px_0_rgb(255_255_255/0.4)_inset]',
  secondary: 'bg-surface-3 text-ink hover:bg-surface-4',
  ghost: 'text-ink-2 hover:text-ink hover:bg-surface-3',
  outline: 'bg-surface-3 text-ink hover:bg-surface-4',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-[8px]',
  md: 'h-10 px-4 text-[14px] gap-2 rounded-[10px]',
  lg: 'h-12 px-5 text-[15px] gap-2.5 rounded-[12px]',
  xl: 'h-14 px-6 text-[16px] gap-2.5 rounded-[14px]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, shortcut, shortcutPosition = 'end', className, children, ...props },
  ref,
) {
  const kbd = shortcut ? <Kbd tone={variant === 'primary' ? 'dark' : 'light'}>{shortcut}</Kbd> : null;
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-semibold tracking-[-0.01em]',
        'transition-[background-color,color,transform,border-color,opacity] duration-100 ease-out',
        'active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {shortcutPosition === 'start' && kbd}
      {icon}
      {children}
      {shortcutPosition === 'end' && kbd}
    </button>
  );
});
