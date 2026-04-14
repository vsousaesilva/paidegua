import type { CSSProperties } from 'react';

// Paleta institucional do pAIdegua (Gov.br)
export const COLORS = {
  primary: '#1351B4',
  primaryDark: '#0C326F',
  primaryLight: '#5992ED',
  yellow: '#FFCD07',
  bg: '#F6F8FC',
  bgDark: '#0A1628',
  fg: '#16243A',
  white: '#FFFFFF',
  muted: '#8BA0BE',
};

export const fullScreen: CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  alignItems: 'center',
  fontFamily: '"Inter", "Segoe UI", system-ui, sans-serif',
};

export const gradientBg: CSSProperties = {
  ...fullScreen,
  background: `linear-gradient(135deg, ${COLORS.primaryDark} 0%, ${COLORS.primary} 50%, ${COLORS.primaryLight} 100%)`,
  color: COLORS.white,
};

export const lightBg: CSSProperties = {
  ...fullScreen,
  background: COLORS.bg,
  color: COLORS.fg,
};

export const darkBg: CSSProperties = {
  ...fullScreen,
  background: `radial-gradient(ellipse at 30% 20%, rgba(89,146,237,0.15), transparent 60%),
               radial-gradient(ellipse at 70% 80%, rgba(255,205,7,0.08), transparent 60%),
               ${COLORS.bgDark}`,
  color: COLORS.white,
};