import { cn } from '../../lib/cn';
import { hashString } from '../../lib/leadInfo';

const GRADIENTS = [
  'from-[#3a3a3c] to-[#1c1c1e]',
  'from-[#48484a] to-[#232325]',
  'from-[#2c2c2e] to-[#111112]',
  'from-[#545456] to-[#2a2a2c]',
  'from-[#3f3f42] to-[#161618]',
];

interface AvatarProps {
  name: string;
  initials: string;
  size?: number;
  className?: string;
  ring?: boolean;
}

/** Profilbild-Platzhalter: Initialen auf dezentem Graustufen-Verlauf. */
export function Avatar({ name, initials, size = 40, className, ring }: AvatarProps) {
  const gradient = GRADIENTS[hashString(name) % GRADIENTS.length];
  return (
    <div
      role="img"
      aria-label={name}
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-semibold text-ink/90',
        'shadow-[inset_0_1px_0_rgb(255_255_255/0.12),inset_0_0_0_1px_rgb(255_255_255/0.06)]',
        ring && 'ring-2 ring-black',
        gradient,
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36), letterSpacing: '-0.01em' }}
    >
      {initials}
    </div>
  );
}
