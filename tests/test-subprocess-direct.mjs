import path from 'path';
import { promises as fs } from 'fs';

// 读取并测试 isolated profile 中的 subprocessService
console.log('Testing subprocessService behavior...');
const ffprobe = path.resolve('E:/0/AI/DeepSeek Harness/插件制作/.dsh-isolated/profiles/headless/node_modules/dsh-video-notes/bin/ffprobe.exe');
console.log('ffprobe path:', ffprobe);
console.log('exists:', await fs.stat(ffprobe).then(s => s.isFile()).catch(() => false));
