import { Composition } from 'remotion';
import { PaideguaApresentacao } from './Apresentacao';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="pAIdegua-Apresentacao"
      component={PaideguaApresentacao}
      durationInFrames={30 * 75} // 75 segundos a 30fps
      fps={30}
      width={1920}
      height={1080}
    />
  );
};