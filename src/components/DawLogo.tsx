/** DAW logo badges — coloured initials with brand colours since we can't bundle proprietary logos. */
export function DawLogo({ daw, size = 28 }: { daw: string; size?: number }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    'FL Studio':    { bg: '#FF6B00', fg: '#fff', label: 'FL' },
    'Pro Tools':    { bg: '#5A9FD4', fg: '#fff', label: 'PT' },
    'Ableton Live': { bg: '#FF6600', fg: '#fff', label: 'AB' },
    'Logic Pro':    { bg: '#1C7FF6', fg: '#fff', label: 'LG' },
    'Reaper':       { bg: '#8B1A1A', fg: '#fff', label: 'RP' },
    'GarageBand':   { bg: '#FF9500', fg: '#fff', label: 'GB' },
    'Cubase':       { bg: '#C8102E', fg: '#fff', label: 'CB' },
    'Studio One':   { bg: '#004B87', fg: '#fff', label: 'S1' },
  };
  const entry = map[daw] ?? { bg: '#333', fg: '#aaa', label: (daw ?? '?').slice(0, 2).toUpperCase() };
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        background: entry.bg,
        color: entry.fg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.36,
        fontWeight: 700,
        letterSpacing: '-0.02em',
        flexShrink: 0,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {entry.label}
    </div>
  );
}
