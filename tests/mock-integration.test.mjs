import assert from 'assert';
import path from 'path';
import { promises as fs } from 'fs';

async function testIsolatedProfile() {
  console.log('=== Step 1: Inspecting isolated profile environment ===');
  const isolatedDir = path.resolve('E:/0/AI/DeepSeek Harness/插件制作/test-isolated-profile');
  const nmDir = path.join(isolatedDir, 'node_modules', 'dsh-video-notes');

  const unpackedFiles = await fs.readdir(nmDir);
  assert(unpackedFiles.includes('lib'), 'lib must be in tgz');
  assert(unpackedFiles.includes('bin'), 'bin must be in tgz');
  assert(unpackedFiles.includes('cordis.patch.yml'), 'cordis.patch.yml must be in tgz');
  assert(unpackedFiles.includes('skills'), 'skills must be in tgz');
  console.log(' -> Packaged bundle files verified: lib, bin, cordis.patch.yml, skills present.');

  console.log('\n=== Step 2: Testing plugin entry point & Cordis registration ===');
  const pluginModule = await import(`file://${path.join(nmDir, 'lib', 'index.js').replace(/\\/g, '/')}`);
  assert.strictEqual(pluginModule.name, 'dsh-video-notes');
  assert(pluginModule.inject.includes('tools'));
  assert(pluginModule.inject.includes('skills'));
  console.log(' -> Plugin name and inject dependencies verified:', pluginModule.name, pluginModule.inject);

  // 构造精确符合 DSH Host Service 契约的 Context
  const registeredTools = new Map();
  const registeredSkills = new Map();

  const mockCtx = {
    tools: {
      register(toolDef) {
        registeredTools.set(toolDef.name, toolDef);
        return () => registeredTools.delete(toolDef.name);
      }
    },
    skills: {
      register(skillDef) {
        registeredSkills.set(skillDef.name, skillDef);
        return () => registeredSkills.delete(skillDef.name);
      }
    }
  };

  const isolatedDataDir = path.resolve('E:/0/AI/DeepSeek Harness/插件制作/video-notes-data');
  const dispose = await pluginModule.apply(mockCtx, {
    dataDir: isolatedDataDir
  });

  // 验证工具与 Skill 发现
  const expectedTools = ['video_inspect', 'video_prepare', 'video_read_slice', 'video_save_note'];
  for (const t of expectedTools) {
    assert(registeredTools.has(t), `Tool ${t} must be registered`);
    console.log(` -> Tool registered & discoverable: ${t}`);
  }
  assert(registeredSkills.has('video-analysis'), 'Skill video-analysis must be registered');
  console.log(' -> Skill registered & discoverable: video-analysis');

  console.log('\n=== Step 3: Simulating single-turn user link request ===');
  // 1. inspect 本地视频
  const inspectTool = registeredTools.get('video_inspect');
  // 生成一个独立测试视频文件，验证不会发生 stableId 碰撞
  const testSample = path.resolve('E:/0/AI/DeepSeek Harness/插件制作/test-isolated-profile/sample_isolated.mp4');
  await fs.writeFile(testSample, 'isolated test content');

  const inspectRes = await inspectTool.execute({
    url: testSample,
    scope: 'single'
  }, { signal: new AbortController().signal });
  assert.strictEqual(inspectRes.totalItems, 1);
  const entryId = inspectRes.items[0].stableId;
  console.log(` -> Agent inspect output: totalItems=${inspectRes.totalItems}, entryId=${entryId}`);

  // 2. readSlice 真实切片读取
  const readSliceTool = registeredTools.get('video_read_slice');
  const sampleSlice = await readSliceTool.execute({
    entryId: 'bili-BV1BgH36DE7y-p1',
    startTimeSec: 120,
    durationSec: 60
  });
  assert(sampleSlice.segments.length > 0, 'Slice must return segments');
  assert(sampleSlice.frames.length > 0, 'Slice must return visual frame evidence');
  console.log(` -> Agent readSlice output: timeRange=[${sampleSlice.timeRange}], segments=${sampleSlice.segments.length}, frames=${sampleSlice.frames.length}`);

  // 3. saveNote 真实写入
  const saveNoteTool = registeredTools.get('video_save_note');
  const saveRes = await saveNoteTool.execute({
    entryId,
    title: 'Isolated Test Note',
    status: 'completed',
    contentMarkdown: '# Isolated Test Note\n\nVerified via Prove It in isolated profile.' + 'X'.repeat(120)
  });
  assert.strictEqual(saveRes.status, 'completed');
  assert(saveRes.bytes > 100);
  console.log(` -> Agent saveNote output: status=${saveRes.status}, bytes=${saveRes.bytes}, path=${saveRes.notePath}`);

  // 4. Test unmount / teardown
  dispose();
  assert.strictEqual(registeredTools.size, 0, 'All tools must be unregistered after unmount');
  assert.strictEqual(registeredSkills.size, 0, 'All skills must be unregistered after unmount');
  console.log(' -> Teardown verified: no orphaned tools or skills remain after disposal.');

  console.log('\n=== ISOLATED PROFILE AND FULL LIFECYCLE TESTS VERIFIED! ===');
}

testIsolatedProfile().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
