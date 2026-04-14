import React from 'react';
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Easing,
} from 'remotion';
import { COLORS } from './styles';
import type { CSSProperties } from 'react';

// ─── Logo SVG do pAIdegua ────────────────────────────────────────

export const Logo: React.FC<{ size?: number }> = ({ size = 80 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect
      x="6.6"
      y="4.08"
      width="2.88"
      height="17.04"
      rx="1.2"
      fill="currentColor"
    />
    <circle
      cx="14.28"
      cy="10.32"
      r="4.62"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.52"
    />
    <circle cx="14.28" cy="10.32" r="2.04" fill={COLORS.yellow} />
  </svg>
);

// ─── Titulo com AI destacado ─────────────────────────────────────

export const BrandTitle: React.FC<{ fontSize?: number }> = ({
  fontSize = 72,
}) => (
  <h1
    style={{
      fontSize,
      fontWeight: 800,
      letterSpacing: -2,
      margin: 0,
      lineHeight: 1,
    }}
  >
    p<span style={{ color: COLORS.yellow }}>AI</span>degua
  </h1>
);

// ─── Fade In ─────────────────────────────────────────────────────

export const FadeIn: React.FC<{
  children: React.ReactNode;
  delay?: number;
  duration?: number;
}> = ({ children, delay = 0, duration = 20 }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame - delay, [0, duration], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const y = interpolate(frame - delay, [0, duration], [30, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  return (
    <div style={{ opacity, transform: `translateY(${y}px)` }}>{children}</div>
  );
};

// ─── Scale In (spring) ───────────────────────────────────────────

export const ScaleIn: React.FC<{
  children: React.ReactNode;
  delay?: number;
}> = ({ children, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({
    frame: frame - delay,
    fps,
    config: { damping: 12, stiffness: 80 },
  });
  return (
    <div
      style={{
        transform: `scale(${scale})`,
        transformOrigin: 'center',
      }}
    >
      {children}
    </div>
  );
};

// ─── Barra de progresso animada ──────────────────────────────────

export const ProgressBar: React.FC<{
  delay?: number;
  duration?: number;
  label?: string;
}> = ({ delay = 0, duration = 40, label = 'Extraindo documentos...' }) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame - delay, [0, duration], [0, 100], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });
  const opacity = interpolate(frame - delay, [0, 8], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div style={{ opacity, width: 600 }}>
      <p style={{ fontSize: 18, color: COLORS.muted, margin: '0 0 8px' }}>
        {label}
      </p>
      <div
        style={{
          width: '100%',
          height: 12,
          borderRadius: 6,
          background: 'rgba(255,255,255,0.1)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${progress}%`,
            height: '100%',
            borderRadius: 6,
            background: `linear-gradient(90deg, ${COLORS.primary}, ${COLORS.yellow})`,
          }}
        />
      </div>
    </div>
  );
};

// ─── Card de funcionalidade ──────────────────────────────────────

export const FeatureCard: React.FC<{
  icon: string;
  title: string;
  desc: string;
  delay?: number;
}> = ({ icon, title, desc, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({
    frame: frame - delay,
    fps,
    config: { damping: 14, stiffness: 100 },
  });
  const opacity = interpolate(frame - delay, [0, 15], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const cardStyle: CSSProperties = {
    opacity,
    transform: `scale(${scale})`,
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 16,
    padding: '28px 24px',
    width: 280,
    backdropFilter: 'blur(8px)',
    textAlign: 'center' as const,
  };

  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 42, marginBottom: 12 }}>{icon}</div>
      <h3
        style={{
          fontSize: 22,
          fontWeight: 700,
          margin: '0 0 8px',
          color: COLORS.white,
        }}
      >
        {title}
      </h3>
      <p style={{ fontSize: 15, color: COLORS.muted, margin: 0, lineHeight: 1.5 }}>
        {desc}
      </p>
    </div>
  );
};

// ─── Bullet point animado ────────────────────────────────────────

export const Bullet: React.FC<{
  text: string;
  delay?: number;
  color?: string;
}> = ({ text, delay = 0, color = COLORS.yellow }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame - delay, [0, 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const x = interpolate(frame - delay, [0, 12], [-40, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  return (
    <div
      style={{
        opacity,
        transform: `translateX(${x}px)`,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
        marginBottom: 14,
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
          marginTop: 8,
        }}
      />
      <span style={{ fontSize: 24, lineHeight: 1.5 }}>{text}</span>
    </div>
  );
};