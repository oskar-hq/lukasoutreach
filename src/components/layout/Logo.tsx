/** Zeichen der App – gleich wie das Favicon (`public/favicon.svg`): weiße Kachel, Sprechblase, grüner Punkt für „Antwort da“. */
export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="16" fill="#f2f2f3" />
      <path d="M19 18h24a7 7 0 0 1 7 7v12a7 7 0 0 1-7 7H29l-8.5 6.5a1 1 0 0 1-1.6-.8V44A7 7 0 0 1 12 37V25a7 7 0 0 1 7-7z" fill="#0b0b0c" />
      <rect x="20" y="27" width="16" height="3.6" rx="1.8" fill="#f2f2f3" />
      <rect x="20" y="33" width="10" height="3.6" rx="1.8" fill="#f2f2f3" opacity=".55" />
      <circle cx="48" cy="18" r="7.5" fill="#30d158" stroke="#f2f2f3" strokeWidth="3.5" />
    </svg>
  );
}

export function Logo() {
  return (
    <div className="flex items-center gap-2 text-ink">
      <LogoMark />
      <span className="whitespace-nowrap text-[15px] font-semibold tracking-[-0.02em]">
        Outreach Cockpit
      </span>
    </div>
  );
}
