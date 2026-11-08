import { VideoPipeline } from './pipeline.js';
import { VideoNotesStore } from './store.js';
import { SaveNoteInput, ScopeMode } from './types.js';
export declare function createTools(pipeline: VideoPipeline, store: VideoNotesStore, pythonExe: string, subprocessService?: any): ({
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            url: {
                type: string;
                description: string;
            };
            scope: {
                type: string;
                enum: string[];
                description: string;
            };
        };
        required: string[];
    };
    output: {
        schema: {
            type: string;
            properties: {
                source: {
                    type: string;
                };
                sourceType: {
                    type: string;
                };
                isCollection: {
                    type: string;
                };
                totalItems: {
                    type: string;
                };
                summary: {
                    type: string;
                };
                items: {
                    type: string;
                    items: {
                        type: string;
                        properties: {
                            id: {
                                type: string;
                            };
                            stableId: {
                                type: string;
                            };
                            title: {
                                type: string;
                            };
                            url: {
                                type: string;
                            };
                            duration: {
                                type: string;
                            };
                            status: {
                                type: string;
                            };
                        };
                    };
                };
            };
        };
        render(args: any, value: any): {
            type: "text";
            text: string;
        }[];
    };
    execute(args: {
        url: string;
        scope?: ScopeMode;
    }, exec: any): Promise<import("./types.js").InspectResult>;
} | {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            url: {
                type: string;
                description: string;
            };
            entryId: {
                type: string;
                description: string;
            };
            forceRebuild: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    output: {
        schema: {
            type: string;
            properties: {
                entryId: {
                    type: string;
                };
                title: {
                    type: string;
                };
                duration: {
                    type: string;
                };
                transcriptSource: {
                    type: string;
                };
                frameCount: {
                    type: string;
                };
                transcriptPath: {
                    type: string;
                };
                framesDir: {
                    type: string;
                };
                reusedExisting: {
                    type: string;
                };
                message: {
                    type: string;
                };
            };
        };
        render(args: any, value: any): {
            type: "text";
            text: string;
        }[];
    };
    execute(args: {
        url: string;
        entryId: string;
        forceRebuild?: boolean;
    }, exec: any): Promise<import("./types.js").PrepareResult>;
} | {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            entryId: {
                type: string;
                description: string;
            };
            startTimeSec: {
                type: string;
                description: string;
            };
            durationSec: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    output: {
        schema: {
            type: string;
            properties: {
                entryId: {
                    type: string;
                };
                title: {
                    type: string;
                };
                timeRange: {
                    type: string;
                    items: {
                        type: string;
                    };
                };
                totalDuration: {
                    type: string;
                };
                hasMore: {
                    type: string;
                };
                nextRange: {
                    type: string;
                    items: {
                        type: string;
                    };
                };
                segments: {
                    type: string;
                    items: {
                        type: string;
                    };
                };
                frames: {
                    type: string;
                    items: {
                        type: string;
                    };
                };
            };
        };
        render(args: any, value: any): {
            type: "text";
            text: string;
        }[];
    };
    execute(args: {
        entryId: string;
        startTimeSec?: number;
        durationSec?: number;
    }): Promise<import("./types.js").SliceResult>;
} | {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            entryId: {
                type: string;
                description: string;
            };
            title: {
                type: string;
                description: string;
            };
            status: {
                type: string;
                enum: string[];
                description: string;
            };
            contentMarkdown: {
                type: string;
                description: string;
            };
            gaps: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            aiNotes: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    output: {
        schema: {
            type: string;
            properties: {
                entryId: {
                    type: string;
                };
                notePath: {
                    type: string;
                };
                status: {
                    type: string;
                };
                bytes: {
                    type: string;
                };
                cleanedWorkDir: {
                    type: string;
                };
                message: {
                    type: string;
                };
            };
        };
        render(args: any, value: any): {
            type: "text";
            text: string;
        }[];
    };
    execute(args: SaveNoteInput): Promise<import("./types.js").SaveNoteResult>;
})[];
//# sourceMappingURL=tools.d.ts.map