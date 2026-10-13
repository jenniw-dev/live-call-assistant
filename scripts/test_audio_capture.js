/**
 * test_audio_capture.js — 独立验证 Electron 系统音频回环采集
 * 用法：npx electron scripts/test_audio_capture.js
 *
 * 验证项：
 *  1. getDisplayMedia 不再 Not supported
 *  2. 能拿到音频轨（loopback）
 *  3. 播放 440Hz 音调时录制 RMS 明显高于静音 → 回环音频真实流动
 */
const { app, BrowserWindow, session, desktopCapturer } = require('electron');

// 允许无用户手势播放音频（测试音调需要出声才能被回环采集）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const HTML = `<!DOCTYPE html><html><body><script>
async function recordRms(stream, ms, onStart) {
  const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise(res => { rec.onstop = res; });
  rec.start();
  if (onStart) onStart();
  await new Promise(r => setTimeout(r, ms));
  rec.stop();
  await done;
  const blob = new Blob(chunks, { type: 'audio/webm' });
  const buf = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(buf);
  const data = decoded.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, data.length));
}

function playTone(ms) {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.5;
  osc.frequency.value = 440;
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + ms / 1000);
}

async function run() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const at = stream.getAudioTracks(), vt = stream.getVideoTracks();
    console.log('CHECK1 getDisplayMedia OK, audio tracks=' + at.length +
                (at.length ? ' label=' + at[0].label : '') + ', video tracks=' + vt.length);
    if (!at.length) { console.log('RESULT: FAIL - no audio track'); return; }
    vt.forEach(t => t.stop());  // 与 App 一致：丢弃视频轨
    const audioStream = new MediaStream(at);

    const rmsSilent = await recordRms(audioStream, 2000, null);
    const rmsTone = await recordRms(audioStream, 2500, () => playTone(2500));
    console.log('CHECK2 RMS silent=' + rmsSilent.toFixed(4) + ' tone=' + rmsTone.toFixed(4));

    const flowing = rmsTone > 0.001 && rmsTone > rmsSilent * 2;
    console.log('RESULT: ' + (flowing ? 'PASS' : 'FAIL') +
                ' - loopback audio ' + (flowing ? 'is flowing' : 'NOT flowing'));
    stream.getTracks().forEach(t => t.stop());
  } catch (e) {
    console.log('RESULT: FAIL - ' + e.name + ': ' + e.message);
  }
}
run();
</script></body></html>`;

app.whenReady().then(() => {
  // 与生产 main.js 完全相同的处理器
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then(sources => {
      console.log('[main] screen sources: ' + sources.length);
      if (!sources.length) return callback({});
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(e => { console.log('[main] getSources error: ' + e); callback({}); });
  });

  const win = new BrowserWindow({ show: false });
  win.webContents.on('console-message', (event, level, message) => {
    console.log('[page] ' + message);
    if (message.startsWith('RESULT:')) {
      const ok = message.includes('PASS');
      setTimeout(() => { app.exit(ok ? 0 : 1); }, 300);
    }
  });
  // file:// 是 secure context（与实际 app 加载方式一致），data: 则没有 mediaDevices
  const fs = require('fs');
  const path = require('path');
  const htmlPath = path.join(__dirname, 'test_audio_capture.html');
  fs.writeFileSync(htmlPath, HTML);
  win.loadFile(htmlPath);

  // 60s 超时保护
  setTimeout(() => { console.log('RESULT: FAIL - timeout'); app.exit(2); }, 60000);
});
