declare module 'liquid-gl' {
  type LiquidGlassOptions = {
    target: string;
    snapshot?: string;
    content?: string | false;
    engine?: 'auto' | 'webgpu' | 'webgl2' | 'webgl';
    resolution?: number;
    refraction?: number;
    bevelDepth?: number;
    bevelWidth?: number;
    frost?: number;
    shadow?: boolean;
    specular?: boolean;
    reveal?: 'fade' | 'none';
    tilt?: boolean;
    interaction?: 'none' | 'fluid';
    tint?: string | null;
  };
  export default function liquidGL(options: LiquidGlassOptions): {destroy: () => void} | undefined;
}
