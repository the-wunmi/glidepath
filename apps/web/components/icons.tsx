import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

/** Decorative line icons; each control that uses one carries its own label. */
function Icon({ children, ...props }: P) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const CheckIcon = (p: P) => (
  <Icon {...p}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Icon>
);
export const CrossIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);
export const DashIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 8h8" />
  </Icon>
);
export const CopyIcon = (p: P) => (
  <Icon {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 3.5v-.5a1 1 0 00-1-1H3.5a1 1 0 00-1 1v6a1 1 0 001 1h.5" />
  </Icon>
);
export const SunIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
  </Icon>
);
export const MoonIcon = (p: P) => (
  <Icon {...p}>
    <path d="M13.5 9.5A5.5 5.5 0 116.5 2.5a4.5 4.5 0 007 7z" />
  </Icon>
);
export const SlidersIcon = (p: P) => (
  <Icon {...p}>
    <path d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7" />
    <circle cx="11" cy="4.5" r="1.5" />
    <circle cx="5" cy="11.5" r="1.5" />
  </Icon>
);
export const MenuIcon = (p: P) => (
  <Icon {...p}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Icon>
);
export const LockIcon = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="7" width="10" height="7" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
  </Icon>
);
export const ExternalIcon = (p: P) => (
  <Icon {...p}>
    <path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M11.5 9.5v3a1 1 0 01-1 1h-7a1 1 0 01-1-1v-7a1 1 0 011-1h3" />
  </Icon>
);
export const DownloadIcon = (p: P) => (
  <Icon {...p}>
    <path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M2.5 13.5h11" />
  </Icon>
);

/** The mark: a seal ring around a closed bar, drawn rather than a stock lock icon. */
export const SealMark = (p: P) => (
  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true" {...p}>
    <circle cx="11" cy="11" r="9.5" stroke="currentColor" strokeWidth="1.5" />
    <circle
      cx="11"
      cy="11"
      r="6.5"
      stroke="currentColor"
      strokeWidth="1"
      strokeDasharray="1.6 1.6"
    />
    <rect x="7.5" y="9.75" width="7" height="2.5" rx="0.6" fill="currentColor" />
  </svg>
);
