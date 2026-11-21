import type { SVGProps } from 'react'

const base = (props: SVGProps<SVGSVGElement>) => ({
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...props,
})

export const FeedIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="5" y="2" width="14" height="20" rx="3" /><path d="M10 9l5 3-5 3z" /></svg>
)
export const TracksIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4 10v4M8 6v12M12 3v18M16 8v8M20 11v2" /></svg>
)
export const MatchesIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z" /></svg>
)
export const MeIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></svg>
)
export const BackIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M15 5l-7 7 7 7" /></svg>
)
export const GearIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
)
export const OfflineIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4.2-2.5M19 13a10 10 0 0 0-2.4-1.7M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 10.7 5M12 20h.01" /></svg>
)
export const ShareIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M12 3v13M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></svg>
)

// Иллюстрация для пустых экранов: кассета с музыкальной нотой (тёплые тона, без внешних картинок).
export const CassetteArt = (p: SVGProps<SVGSVGElement>) => (
  <svg width={150} height={110} viewBox="0 0 150 110" aria-hidden {...p}>
    <defs>
      <linearGradient id="cas-body" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#e9a25c" />
        <stop offset="1" stopColor="#b8642c" />
      </linearGradient>
      <filter id="cas-glow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="6" />
      </filter>
    </defs>
    <g transform="rotate(-10 75 55)">
      <rect x="18" y="24" width="114" height="68" rx="10" fill="#ff7a3d" opacity="0.35" filter="url(#cas-glow)" />
      <rect x="18" y="24" width="114" height="68" rx="10" fill="url(#cas-body)" />
      <rect x="28" y="32" width="94" height="34" rx="6" fill="#f6dcb8" />
      <rect x="36" y="40" width="78" height="18" rx="9" fill="#3b2418" />
      <circle cx="51" cy="49" r="6" fill="#f6dcb8" />
      <circle cx="99" cy="49" r="6" fill="#f6dcb8" />
      <circle cx="51" cy="49" r="2.2" fill="#3b2418" />
      <circle cx="99" cy="49" r="2.2" fill="#3b2418" />
      <path d="M44 92 L52 76 H98 L106 92" fill="#8e4a20" />
      <circle cx="62" cy="85" r="2.5" fill="#3b2418" />
      <circle cx="88" cy="85" r="2.5" fill="#3b2418" />
    </g>
    <g fill="#ffb27a">
      <circle cx="124" cy="28" r="5" />
      <circle cx="141" cy="24" r="5" />
      <path d="M127.5 28V10l17-4v18" stroke="#ffb27a" strokeWidth="3" fill="none" />
    </g>
  </svg>
)
