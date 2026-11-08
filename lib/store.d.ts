import { SaveNoteInput, SaveNoteResult } from './types.js';
export interface EpisodePaths {
    episodeDir: string;
    sourceJson: string;
    transcriptJson: string;
    transcriptSrt: string;
    framesDir: string;
    noteMd: string;
    workDir: string;
}
export declare function decodeJpegDimensions(buf: Buffer): {
    width: number;
    height: number;
};
export declare class VideoNotesStore {
    readonly baseDataDir: string;
    constructor(baseDataDir: string);
    init(): Promise<void>;
    getEpisodePaths(entryId: string): EpisodePaths;
    hasPreparedArtifacts(entryId: string): Promise<boolean>;
    getEpisodeSource(entryId: string): Promise<Record<string, any>>;
    saveEpisodeSource(entryId: string, sourceData: Record<string, unknown>): Promise<void>;
    saveNote(input: SaveNoteInput): Promise<SaveNoteResult>;
}
//# sourceMappingURL=store.d.ts.map