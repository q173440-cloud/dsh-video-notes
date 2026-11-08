import { VideoPipeline } from './pipeline.js';
import { inspectSource } from './source.js';
import { VideoNotesStore } from './store.js';
import { SaveNoteInput, ScopeMode } from './types.js';

export function createTools(pipeline: VideoPipeline, store: VideoNotesStore, pythonExe: string, subprocessService?: any) {
  // 1. video_inspect
  const videoInspect = {
    name: 'video_inspect',
    description: '探测视频链接（B站/YouTube/本地文件）的元信息、分P与合集目录。仅进行元信息探测，不下载视频亦不进行总结。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '视频 URL（B站、YouTube等）或本地视频文件绝对路径'
        },
        scope: {
          type: 'string',
          enum: ['single', 'collection'],
          description: '处理范围：single 仅处理当前单集/指定分P；collection 展开处理整个合集/所有分P。默认 single。'
        }
      },
      required: ['url']
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          sourceType: { type: 'string' },
          isCollection: { type: 'boolean' },
          totalItems: { type: 'number' },
          summary: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                stableId: { type: 'string' },
                title: { type: 'string' },
                url: { type: 'string' },
                duration: { type: 'number' },
                status: { type: 'string' }
              }
            }
          }
        }
      },
      render(args: any, value: any) {
        let text = `【视频探测结果】\n来源类型: ${value.sourceType}\n概括: ${value.summary}\n`;
        if (value.items && value.items.length > 0) {
          text += `条目列表 (共 ${value.items.length} 条):\n`;
          for (const item of value.items) {
            text += `- [${item.stableId}] 《${item.title}》 (${item.duration ? Math.round(item.duration) + '秒' : '时长未知'})\n`;
          }
        }
        return [{ type: 'text' as const, text }];
      }
    },
    async execute(args: { url: string; scope?: ScopeMode }, exec: any) {
      if (!args.url || typeof args.url !== 'string') {
        throw new Error('Missing or invalid required argument: url');
      }
      return await inspectSource(args.url, {
        pythonExe,
        scope: args.scope || 'single',
        signal: exec.signal,
        subprocessService
      });
    }
  };

  // 2. video_prepare
  const videoPrepare = {
    name: 'video_prepare',
    description: '对选定条目获取音视频媒体、转写字幕（本地 faster-whisper ASR 或官方字幕）并抽取关键帧图片证据。如果已有产物完整且有效，默认直接复用。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '视频 URL 或本地视频绝对路径'
        },
        entryId: {
          type: 'string',
          description: '条目标识（建议使用 video_inspect 返回的 stableId）'
        },
        forceRebuild: {
          type: 'boolean',
          description: '是否强制重新下载媒体并重新转写抽帧（默认 false，优先复用已有产物）'
        }
      },
      required: ['url', 'entryId']
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          entryId: { type: 'string' },
          title: { type: 'string' },
          duration: { type: 'number' },
          transcriptSource: { type: 'string' },
          frameCount: { type: 'number' },
          transcriptPath: { type: 'string' },
          framesDir: { type: 'string' },
          reusedExisting: { type: 'boolean' },
          message: { type: 'string' }
        }
      },
      render(args: any, value: any) {
        const text = `【准备就绪】\n${value.message}\n字幕数据: ${value.transcriptPath}\n关键帧目录: ${value.framesDir}\n可调用 video_read_slice 按时间段读取字幕与画面。\n产物模式: ${value.reusedExisting ? '复用已有完整资产' : '新生成并入库'}`;
        return [{ type: 'text' as const, text }];
      }
    },
    async execute(args: { url: string; entryId: string; forceRebuild?: boolean }, exec: any) {
      if (!args.url || !args.entryId) {
        throw new Error('Both url and entryId are required for video_prepare');
      }
      return await pipeline.prepareEpisode(args.url, args.entryId, {
        signal: exec.signal,
        forceRebuild: Boolean(args.forceRebuild)
      });
    }
  };

  // 3. video_read_slice
  const videoReadSlice = {
    name: 'video_read_slice',
    description: '按时间范围读取指定视频条目的字幕分段和对应的关键帧图片批次，供 Agent 进行多模态阅读与综合分析。',
    parameters: {
      type: 'object',
      properties: {
        entryId: {
          type: 'string',
          description: '条目标识 (stableId)'
        },
        startTimeSec: {
          type: 'number',
          description: '切片起始秒数（默认 0）'
        },
        durationSec: {
          type: 'number',
          description: '切片时长秒数（默认 120 秒）'
        }
      },
      required: ['entryId']
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          entryId: { type: 'string' },
          title: { type: 'string' },
          timeRange: { type: 'array', items: { type: 'number' } },
          totalDuration: { type: 'number' },
          hasMore: { type: 'boolean' },
          nextRange: { type: 'array', items: { type: 'number' } },
          segments: { type: 'array', items: { type: 'object' } },
          frames: { type: 'array', items: { type: 'object' } }
        }
      },
      render(args: any, value: any) {
        let text = `【时间切片: ${value.timeRange[0]}s -> ${value.timeRange[1]}s (总长 ${Math.round(value.totalDuration)}s)】\n`;
        text += `\n--- 字幕片段 (${value.segments.length} 条) ---\n`;
        for (const s of value.segments) {
          const rawInfo = (s.rawText && s.rawText !== s.text) ? ` [原听写: ${s.rawText}]` : '';
          text += `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s]: ${s.text}${rawInfo}\n`;
        }
        text += `\n--- 关键帧证据 (${value.frames.length} 张) ---\n`;
        for (const f of value.frames) {
          text += `[时间点 ${f.relativeTime} (${f.timestamp}s)] 截图文件: ${f.path}\n`;
        }
        if (value.hasMore && value.nextRange) {
          text += `\n后续分段: [${value.nextRange[0]}s -> ${value.nextRange[1]}s]，可继续调用 video_read_slice 获取。\n`;
        } else {
          text += `\n已到达视频结尾。\n`;
        }
        return [{ type: 'text' as const, text }];
      }
    },
    async execute(args: { entryId: string; startTimeSec?: number; durationSec?: number }) {
      if (!args.entryId) {
        throw new Error('Missing entryId in video_read_slice');
      }
      const start = Number(args.startTimeSec || 0);
      const dur = Number(args.durationSec || 120);
      return await pipeline.readSlice(args.entryId, start, dur);
    }
  };

  // 4. video_save_note
  const videoSaveNote = {
    name: 'video_save_note',
    description: '保存单集结构化复习笔记 Markdown，校验必要内容，并安全清理下载的媒体工作缓存。',
    parameters: {
      type: 'object',
      properties: {
        entryId: {
          type: 'string',
          description: '条目标识 (stableId)'
        },
        title: {
          type: 'string',
          description: '视频标题'
        },
        status: {
          type: 'string',
          enum: ['completed', 'partial'],
          description: '总结状态：completed 完整完成；partial 部分完成（有缺口）'
        },
        contentMarkdown: {
          type: 'string',
          description: '完整的单集 Markdown 复习笔记内容'
        },
        gaps: {
          type: 'array',
          items: { type: 'string' },
          description: '已知缺口、模糊未听清或未识别细节清单'
        },
        aiNotes: {
          type: 'string',
          description: 'AI 补充解释（背景拓展、术语补充），不冒充原视频观点'
        }
      },
      required: ['entryId', 'title', 'status', 'contentMarkdown']
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          entryId: { type: 'string' },
          notePath: { type: 'string' },
          status: { type: 'string' },
          bytes: { type: 'number' },
          cleanedWorkDir: { type: 'boolean' },
          message: { type: 'string' }
        }
      },
      render(args: any, value: any) {
        return [{
          type: 'text' as const,
          text: `【笔记保存结果】\n条目: ${value.entryId}\n状态: ${value.status}\n路径: ${value.notePath}\n大小: ${value.bytes} 字节\n临时视频清理: ${value.cleanedWorkDir ? '已安全清除' : '未清理（保留恢复素材）'}\n${value.message}`
        }];
      }
    },
    async execute(args: SaveNoteInput) {
      if (!args.entryId || !args.contentMarkdown) {
        throw new Error('Both entryId and contentMarkdown are required for video_save_note');
      }
      return await store.saveNote(args);
    }
  };

  return [videoInspect, videoPrepare, videoReadSlice, videoSaveNote];
}
