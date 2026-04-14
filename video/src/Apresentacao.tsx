import React from 'react';
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  interpolate,
  Easing,
} from 'remotion';
import { gradientBg, darkBg, lightBg, COLORS } from './styles';
import {
  Logo,
  BrandTitle,
  FadeIn,
  ScaleIn,
  FeatureCard,
  Bullet,
  ProgressBar,
} from './components';
import type { CSSProperties } from 'react';

const FPS = 30;
const sec = (s: number) => s * FPS;

// ═══════════════════════════════════════════════════════════════════
//  CENA 1 — Abertura (0s a 8s)
// ═══════════════════════════════════════════════════════════════════

const Abertura: React.FC = () => {
  const frame = useCurrentFrame();
  const logoScale = interpolate(frame, [0, 25], [0.3, 1], {
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.back(1.4)),
  });
  const glowOpacity = interpolate(frame, [20, 50], [0, 0.6], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={gradientBg}>
      {/* Glow behind logo */}
      <div
        style={{
          position: 'absolute',
          width: 300,
          height: 300,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${COLORS.yellow}44, transparent 70%)`,
          opacity: glowOpacity,
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -65%)',
        }}
      />

      <div style={{ transform: `scale(${logoScale})`, marginBottom: 20 }}>
        <Logo size={120} />
      </div>

      <FadeIn delay={15}>
        <BrandTitle fontSize={86} />
      </FadeIn>

      <FadeIn delay={35}>
        <p
          style={{
            fontSize: 28,
            color: 'rgba(255,255,255,0.8)',
            marginTop: 20,
            fontWeight: 400,
            letterSpacing: 0.5,
          }}
        >
          Assistente de IA integrado ao PJe
        </p>
      </FadeIn>

      <FadeIn delay={55}>
        <p
          style={{
            fontSize: 20,
            color: COLORS.yellow,
            marginTop: 12,
            fontWeight: 600,
          }}
        >
          Justica Federal no Ceara
        </p>
      </FadeIn>
    </AbsoluteFill>
  );
};

// ═══════════════════════════════════════════════════════════════════
//  CENA 2 — O Problema (8s a 18s)
// ═══════════════════════════════════════════════════════════════════

const Problema: React.FC = () => (
  <AbsoluteFill style={darkBg}>
    <div style={{ maxWidth: 1200, padding: '0 80px' }}>
      <FadeIn>
        <h2
          style={{
            fontSize: 48,
            fontWeight: 800,
            marginBottom: 40,
            color: COLORS.yellow,
          }}
        >
          O desafio
        </h2>
      </FadeIn>

      <Bullet delay={15} text="Processos com dezenas de documentos para analisar" />
      <Bullet delay={25} text="Minutas repetitivas que consomem horas de trabalho" />
      <Bullet delay={35} text="Documentos digitalizados sem texto pesquisavel" />
      <Bullet delay={45} text="Necessidade de padronizacao nas pecas judiciais" />

      <FadeIn delay={70}>
        <p
          style={{
            fontSize: 28,
            color: COLORS.primaryLight,
            marginTop: 40,
            fontWeight: 600,
          }}
        >
          E se a IA pudesse ajudar?
        </p>
      </FadeIn>
    </div>
  </AbsoluteFill>
);

// ═══════════════════════════════════════════════════════════════════
//  CENA 3 — Funcionalidades (18s a 35s)
// ═══════════════════════════════════════════════════════════════════

const Funcionalidades: React.FC = () => (
  <AbsoluteFill style={darkBg}>
    <FadeIn>
      <h2
        style={{
          fontSize: 44,
          fontWeight: 800,
          marginBottom: 50,
          textAlign: 'center' as const,
        }}
      >
        O que o p<span style={{ color: COLORS.yellow }}>AI</span>degua faz
      </h2>
    </FadeIn>

    <div
      style={{
        display: 'flex',
        gap: 24,
        justifyContent: 'center',
        flexWrap: 'wrap' as const,
        maxWidth: 1400,
      }}
    >
      <FeatureCard
        icon="📄"
        title="Extracao de conteudo"
        desc="Extrai texto de todos os documentos do processo automaticamente"
        delay={15}
      />
      <FeatureCard
        icon="📋"
        title="Resumo FIRAC+"
        desc="Analise completa: fatos, questoes, direito aplicavel e conclusao"
        delay={25}
      />
      <FeatureCard
        icon="⚖️"
        title="Geracao de minutas"
        desc="Sentencas, decisoes e despachos com modelos de referencia"
        delay={35}
      />
      <FeatureCard
        icon="🔍"
        title="OCR inteligente"
        desc="Reconhecimento de texto em documentos digitalizados"
        delay={45}
      />
    </div>
  </AbsoluteFill>
);

// ═══════════════════════════════════════════════════════════════════
//  CENA 4 — Minutas com Modelo (35s a 50s)
// ═══════════════════════════════════════════════════════════════════

const MinutasModelo: React.FC = () => (
  <AbsoluteFill style={darkBg}>
    <div style={{ maxWidth: 1200, padding: '0 80px' }}>
      <FadeIn>
        <h2
          style={{
            fontSize: 44,
            fontWeight: 800,
            marginBottom: 16,
          }}
        >
          Minutas com{' '}
          <span style={{ color: COLORS.yellow }}>seus modelos</span>
        </h2>
        <p
          style={{
            fontSize: 22,
            color: COLORS.muted,
            marginBottom: 40,
          }}
        >
          A IA escreve no estilo que voce ja adota
        </p>
      </FadeIn>

      <div
        style={{
          display: 'flex',
          gap: 40,
          alignItems: 'flex-start',
        }}
      >
        <div style={{ flex: 1 }}>
          <Bullet
            delay={20}
            text="Julgar procedente — sentenca com gabarito rigido"
            color={COLORS.primaryLight}
          />
          <Bullet
            delay={30}
            text="Julgar improcedente — mesma estrutura, outro resultado"
            color={COLORS.primaryLight}
          />
          <Bullet
            delay={40}
            text="Decidir — decisao interlocutoria focada na questao"
            color={COLORS.yellow}
          />
          <Bullet
            delay={50}
            text="Despachar — impulsionamento breve e objetivo"
            color={COLORS.yellow}
          />
          <Bullet
            delay={60}
            text="Converter em diligencia — providencias complementares"
            color={COLORS.yellow}
          />
        </div>

        <FadeIn delay={25}>
          <div
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: `1px solid rgba(255,255,255,0.1)`,
              borderRadius: 16,
              padding: '24px 28px',
              width: 400,
            }}
          >
            <p
              style={{
                fontSize: 14,
                color: COLORS.muted,
                margin: '0 0 8px',
                textTransform: 'uppercase' as const,
                letterSpacing: 1,
              }}
            >
              Busca automatica
            </p>
            <p style={{ fontSize: 18, margin: '0 0 16px', lineHeight: 1.5 }}>
              O sistema encontra o modelo mais similar na sua pasta e
              adapta ao caso concreto
            </p>
            <div
              style={{
                background: 'rgba(19,81,180,0.3)',
                borderRadius: 8,
                padding: '10px 14px',
                fontSize: 14,
                fontFamily: 'monospace',
                color: COLORS.primaryLight,
              }}
            >
              sentenca-bpc-loas.docx — 92% similar
            </div>
          </div>
        </FadeIn>
      </div>
    </div>
  </AbsoluteFill>
);

// ═══════════════════════════════════════════════════════════════════
//  CENA 5 — Mais recursos (50s a 62s)
// ═══════════════════════════════════════════════════════════════════

const MaisRecursos: React.FC = () => (
  <AbsoluteFill style={darkBg}>
    <div style={{ maxWidth: 1200, padding: '0 80px' }}>
      <FadeIn>
        <h2
          style={{
            fontSize: 44,
            fontWeight: 800,
            marginBottom: 40,
          }}
        >
          Mais recursos
        </h2>
      </FadeIn>

      <div style={{ display: 'flex', gap: 40 }}>
        <div style={{ flex: 1 }}>
          <FadeIn delay={10}>
            <h3
              style={{
                fontSize: 26,
                color: COLORS.yellow,
                marginBottom: 16,
                fontWeight: 700,
              }}
            >
              Anonimizacao
            </h3>
          </FadeIn>
          <Bullet delay={20} text="CPF, CNPJ, telefones — regex local" />
          <Bullet delay={28} text="Nomes de pessoas — deteccao por IA" />
          <Bullet delay={36} text="Sem envio de dados para anonimizar" />
        </div>

        <div style={{ flex: 1 }}>
          <FadeIn delay={15}>
            <h3
              style={{
                fontSize: 26,
                color: COLORS.yellow,
                marginBottom: 16,
                fontWeight: 700,
              }}
            >
              Chat livre
            </h3>
          </FadeIn>
          <Bullet delay={30} text="Pergunte qualquer coisa sobre o processo" />
          <Bullet delay={38} text="Entrada por voz com microfone" />
          <Bullet delay={46} text="Respostas baseadas nos documentos" />
        </div>
      </div>

      <FadeIn delay={55}>
        <div
          style={{
            marginTop: 40,
            display: 'flex',
            gap: 24,
            justifyContent: 'center',
          }}
        >
          <Tag text="Resumo em audio" />
          <Tag text="OCR local" />
          <Tag text="Insercao no CKEditor" />
          <Tag text="Multiplos provedores de IA" />
        </div>
      </FadeIn>
    </div>
  </AbsoluteFill>
);

const Tag: React.FC<{ text: string }> = ({ text }) => (
  <span
    style={{
      background: 'rgba(19,81,180,0.3)',
      border: '1px solid rgba(89,146,237,0.3)',
      borderRadius: 20,
      padding: '8px 20px',
      fontSize: 17,
      color: COLORS.primaryLight,
      fontWeight: 600,
    }}
  >
    {text}
  </span>
);

// ═══════════════════════════════════════════════════════════════════
//  CENA 6 — Seguranca (62s a 70s)
// ═══════════════════════════════════════════════════════════════════

const Seguranca: React.FC = () => (
  <AbsoluteFill style={darkBg}>
    <div
      style={{
        maxWidth: 1000,
        textAlign: 'center' as const,
        padding: '0 60px',
      }}
    >
      <ScaleIn>
        <div style={{ fontSize: 64, marginBottom: 20 }}>🔒</div>
      </ScaleIn>

      <FadeIn delay={10}>
        <h2
          style={{
            fontSize: 44,
            fontWeight: 800,
            marginBottom: 40,
          }}
        >
          Seguranca e conformidade
        </h2>
      </FadeIn>

      <div
        style={{
          display: 'flex',
          gap: 30,
          justifyContent: 'center',
          textAlign: 'left' as const,
        }}
      >
        <FadeIn delay={20}>
          <SecurityItem
            title="LGPD"
            desc="Aviso de privacidade obrigatorio antes do uso"
          />
        </FadeIn>
        <FadeIn delay={30}>
          <SecurityItem
            title="Res. CNJ 615/2025"
            desc="Classificacao como ferramenta de Baixo Risco"
          />
        </FadeIn>
        <FadeIn delay={40}>
          <SecurityItem
            title="OCR local"
            desc="Documentos digitalizados processados sem envio a nuvem"
          />
        </FadeIn>
      </div>
    </div>
  </AbsoluteFill>
);

const SecurityItem: React.FC<{ title: string; desc: string }> = ({
  title,
  desc,
}) => (
  <div
    style={{
      background: 'rgba(255,255,255,0.05)',
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 14,
      padding: '22px 20px',
      width: 260,
    }}
  >
    <h4
      style={{
        fontSize: 20,
        fontWeight: 700,
        margin: '0 0 8px',
        color: COLORS.yellow,
      }}
    >
      {title}
    </h4>
    <p style={{ fontSize: 16, color: COLORS.muted, margin: 0, lineHeight: 1.5 }}>
      {desc}
    </p>
  </div>
);

// ═══════════════════════════════════════════════════════════════════
//  CENA 7 — Encerramento (70s a 75s)
// ═══════════════════════════════════════════════════════════════════

const Encerramento: React.FC = () => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 30], [0.9, 1], {
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  return (
    <AbsoluteFill style={gradientBg}>
      <div
        style={{
          transform: `scale(${scale})`,
          textAlign: 'center' as const,
        }}
      >
        <Logo size={90} />
        <BrandTitle fontSize={72} />

        <FadeIn delay={10}>
          <p
            style={{
              fontSize: 30,
              marginTop: 24,
              color: 'rgba(255,255,255,0.85)',
              fontWeight: 500,
            }}
          >
            IA a servico da Justica
          </p>
        </FadeIn>

        <FadeIn delay={25}>
          <p
            style={{
              fontSize: 20,
              marginTop: 30,
              color: COLORS.yellow,
              fontWeight: 600,
            }}
          >
            Justica Federal no Ceara — JFCE
          </p>
        </FadeIn>
      </div>
    </AbsoluteFill>
  );
};

// ═══════════════════════════════════════════════════════════════════
//  COMPOSICAO PRINCIPAL
// ═══════════════════════════════════════════════════════════════════

export const PaideguaApresentacao: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: COLORS.bgDark }}>
      <Sequence from={sec(0)} durationInFrames={sec(8)} name="Abertura">
        <Abertura />
      </Sequence>

      <Sequence from={sec(8)} durationInFrames={sec(10)} name="O Problema">
        <Problema />
      </Sequence>

      <Sequence from={sec(18)} durationInFrames={sec(17)} name="Funcionalidades">
        <Funcionalidades />
      </Sequence>

      <Sequence from={sec(35)} durationInFrames={sec(15)} name="Minutas com Modelo">
        <MinutasModelo />
      </Sequence>

      <Sequence from={sec(50)} durationInFrames={sec(12)} name="Mais Recursos">
        <MaisRecursos />
      </Sequence>

      <Sequence from={sec(62)} durationInFrames={sec(8)} name="Seguranca">
        <Seguranca />
      </Sequence>

      <Sequence from={sec(70)} durationInFrames={sec(5)} name="Encerramento">
        <Encerramento />
      </Sequence>
    </AbsoluteFill>
  );
};