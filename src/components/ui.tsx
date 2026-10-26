import type { CSSProperties, ReactNode } from "react";

export type IconName =
  | "home"
  | "compass"
  | "search"
  | "library"
  | "puzzle"
  | "settings"
  | "play"
  | "pause"
  | "plus"
  | "check"
  | "x"
  | "back"
  | "forward"
  | "volume"
  | "mute"
  | "subtitle"
  | "external"
  | "trash"
  | "refresh"
  | "sliders"
  | "film"
  | "tv"
  | "sparkles"
  | "clock"
  | "chevron"
  | "monitor"
  | "stop"
  | "key"
  | "info"
  | "download"
  | "expand"
  | "compress";

const STROKE: Partial<Record<IconName, ReactNode>> = {
  expand: (
    <>
      <path d="M4 9V4h5" />
      <path d="M20 15v5h-5" />
      <path d="M4 4l6 6" />
      <path d="M20 20l-6-6" />
    </>
  ),
  compress: (
    <>
      <path d="M10 4v6H4" />
      <path d="M14 20v-6h6" />
      <path d="M10 10L4 4" />
      <path d="M14 14l6 6" />
    </>
  ),
  home: (
    <>
      <path d="M3.5 10.5 12 3.5l8.5 7" />
      <path d="M5.5 9.5v10a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-10" />
      <path d="M9.5 20.5v-6h5v6" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m15.4 8.6-2 4.8-4.8 2 2-4.8 4.8-2Z" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m15.5 15.5 4 4" />
    </>
  ),
  library: (
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H8a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5.5A1.5 1.5 0 0 1 4 18.5v-13Z" />
      <path d="M11 5h3.5A1.5 1.5 0 0 1 16 6.5v11a1.5 1.5 0 0 1-1.5 1.5H11" />
      <path d="m18 6 2 .6a1 1 0 0 1 .7 1.2l-3 10.6" />
    </>
  ),
  puzzle: (
    <>
      <path d="M9 4.5h2.2a1.3 1.3 0 0 1 1.3 1.3v.9a1.6 1.6 0 0 0 3.2 0v-.9a1.3 1.3 0 0 1 1.3-1.3H19a1 1 0 0 1 1 1v3.2a1.3 1.3 0 0 1-1.3 1.3h-.9a1.6 1.6 0 0 0 0 3.2h.9A1.3 1.3 0 0 1 20 14.5V19a1 1 0 0 1-1 1h-4.4a1.3 1.3 0 0 1-1.3-1.3v-.9a1.6 1.6 0 0 0-3.2 0v.9A1.3 1.3 0 0 1 8.8 20H4.5a1 1 0 0 1-1-1v-4.4a1.3 1.3 0 0 1 1.3-1.3h.9a1.6 1.6 0 0 0 0-3.2h-.9A1.3 1.3 0 0 1 3.5 8.8V5.5a1 1 0 0 1 1-1H9Z" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l1.4-1.1-1.7-3-1.7.7a7.6 7.6 0 0 0-2.6-1.5L14.4 3h-3.4l-.4 2.6a7.6 7.6 0 0 0-2.6 1.5l-1.7-.7-1.7 3 1.4 1.1a7.8 7.8 0 0 0 0 3L4.6 14.6l1.7 3 1.7-.7a7.6 7.6 0 0 0 2.6 1.5l.4 2.6h3.4l.4-2.6a7.6 7.6 0 0 0 2.6-1.5l1.7.7 1.7-3-1.4-1.1Z" />
    </>
  ),
  play: <path d="M8.5 5.2v13.6l11-6.8-11-6.8Z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  back: <path d="M15.5 5 8 12l7.5 7" />,
  forward: <path d="M8.5 5 16 12l-7.5 7" />,
  volume: (
    <>
      <path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3v-5Z" />
      <path d="M15.5 9a4.5 4.5 0 0 1 0 6" />
      <path d="M18 6.5a8 8 0 0 1 0 11" />
    </>
  ),
  mute: (
    <>
      <path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3v-5Z" />
      <path d="m16 9.5 5 5M21 9.5l-5 5" />
    </>
  ),
  subtitle: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="M7 12h4M13 12h4M7 15.5h6M15 15.5h2" />
    </>
  ),
  external: (
    <>
      <path d="M13 5h6v6" />
      <path d="M19 5l-8 8" />
      <path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15M9 7V4.5h6V7" />
      <path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
      <path d="M10.5 11v5.5M13.5 11v5.5" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v5h-5" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="17" r="2" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M7.5 4.5v15M16.5 4.5v15M3 12h18M3 8.2h4.5M3 15.8h4.5M16.5 8.2H21M16.5 15.8H21" />
    </>
  ),
  tv: (
    <>
      <rect x="3" y="6.5" width="18" height="12" rx="2" />
      <path d="m8 3.5 4 3 4-3" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 4.5 13.4 9 18 10.4 13.4 11.8 12 16.3 10.6 11.8 6 10.4 10.6 9 12 4.5Z" />
      <path d="M18.5 15.5 19.2 17.8 21.5 18.5 19.2 19.2 18.5 21.5 17.8 19.2 15.5 18.5 17.8 17.8 18.5 15.5Z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  monitor: (
    <>
      <rect x="3" y="4.5" width="18" height="12.5" rx="2" />
      <path d="M9 20.5h6M12 17v3.5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="12" r="3.5" />
      <path d="M11.5 12H21M17 12v3M20 12v2.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.8v.4" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11M7.5 11l4.5 4.5L16.5 11" />
      <path d="M4.5 19.5h15" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {STROKE[name] ?? STROKE.info}
    </svg>
  );
}

export function Button({
  children,
  onClick,
  variant = "ghost",
  icon,
  disabled,
  title,
  type = "button",
  full,
}: {
  children?: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "soft" | "danger";
  icon?: IconName;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  full?: boolean;
}) {
  return (
    <button
      type={type}
      className={`btn btn-${variant}${full ? " btn-full" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon ? <Icon name={icon} size={17} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export function IconButton({
  icon,
  onClick,
  label,
  active,
  size = 18,
}: {
  icon: IconName;
  onClick?: () => void;
  label: string;
  active?: boolean;
  size?: number;
}) {
  return (
    <button
      type="button"
      className={`icon-btn${active ? " is-active" : ""}`}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle${checked ? " is-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "good" | "warn";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status" aria-live="polite">
      <span className="spinner" />
      {label ? <span className="spinner-label">{label}</span> : null}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
  icon = "sparkles",
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={icon} size={26} />
      </div>
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  );
}

export function SectionHeading({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      {detail ? <span>{detail}</span> : null}
    </div>
  );
}
