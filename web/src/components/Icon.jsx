const PATHS = {
  play: <path d="M7 5v14l11-7z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  download: <path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12 5 5 9-10" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
};
export default function Icon({ name, size }) {
  const style = size ? { width: size, height: size } : undefined;
  return (
    <svg className="i" viewBox="0 0 24 24" style={style} aria-hidden="true">
      {PATHS[name] ?? null}
    </svg>
  );
}
