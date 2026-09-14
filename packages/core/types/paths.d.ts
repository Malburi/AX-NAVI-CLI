export interface ProjectPaths {
  /** 프로젝트 루트 절대경로. */
  readonly root: string;
  /** 런타임 산출물 루트 — 플러그인과 공유한다. */
  readonly workspaceDir: string;
  /** 결정론적 인덱스. */
  readonly indexDir: string;
  /** 스킬 리포트 산출물. */
  readonly reportsDir: string;
  /** 분리 저장소 페어 설정(마크다운, 레거시 형식). */
  readonly pairConfigPath: string;
  /** CLI 전용 디렉터리. */
  readonly axnaviDir: string;
  readonly configPath: string;
  readonly sessionsDir: string;
  readonly logsDir: string;
}

export interface ProjectState {
  readonly initialized: boolean;
  readonly hasIndex: boolean;
  readonly hasPluginHarness: boolean;
}
