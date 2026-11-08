export type VideoSourceType = 'bilibili' | 'youtube' | 'local' | 'other';
export type ScopeMode = 'single' | 'collection';
export type ItemStatus = 'queued' | 'running' | 'partial' | 'completed' | 'failed' | 'cancelled';

export interface VideoItemSummary {
  id: string;
  stableId: string;
  title: string;
  url: string;
  duration?: number;
  uploader?: string;
  pIndex?: number;
  status: ItemStatus;
  notePath?: string;
}

export interface InspectResult {
  source: string;
  sourceType: VideoSourceType;
  scope: ScopeMode;
  isCollection: boolean;
  totalItems: number | 'unknown';
  items: VideoItemSummary[];
  summary: string;
}

export interface TranscriptSegment {
  id: number | string;
  start: number;
  end: number;
  text: string;
  rawText?: string;
  correctedText?: string;
  correctionNotes?: string;
  source: 'platform-manual' | 'platform-auto' | 'local-asr';
}

export interface VideoFrameEvidence {
  id: string;
  timestamp: number;
  path: string;
  relativeTime: string;
}

export interface PrepareResult {
  entryId: string;
  stableId: string;
  title: string;
  duration: number;
  status: ItemStatus;
  hasPlatformSubtitle: boolean;
  transcriptSource: 'platform-manual' | 'platform-auto' | 'local-asr';
  transcriptPath: string;
  srtPath: string;
  frameCount: number;
  framesDir: string;
  episodeDir: string;
  audioPath?: string;
  reusedExisting?: boolean;
  message: string;
}

export interface SliceResult {
  entryId: string;
  title: string;
  timeRange: [number, number];
  totalDuration: number;
  segments: TranscriptSegment[];
  frames: VideoFrameEvidence[];
  hasMore: boolean;
  nextRange?: [number, number];
}

export interface SaveNoteInput {
  entryId: string;
  title?: string;
  url?: string;
  status: 'completed' | 'partial';
  contentMarkdown: string;
  gaps?: string[];
  aiNotes?: string;
  observations?: Array<{
    timestamp: number;
    visualFact: string;
    spokenFact: string;
  }>;
}

export interface SaveNoteResult {
  entryId: string;
  notePath: string;
  status: ItemStatus;
  bytes: number;
  cleanedWorkDir: boolean;
  message: string;
}

export interface PluginConfig {
  dataDir?: string;
  pythonPath?: string;
  whisperModel?: string;
  computeType?: string;
  baselineIntervalSec?: number;
  sceneChangeThreshold?: number;
}
