import FFT from 'fft.js';

const version = '0.02';
const fft_size = 1024;
let zoom = 1;
let begin_frame = 0;
let sample_rate = 0;
let wav;
let cursor = 0;
let grid = [];
let grid_drag_begin = -1;
let done = false;
let draw_lines_request_id = 0;

const scrollbar = {
  x: 0,
  y: 0,
  width: 16,
  height: 10,
  drag_offset: 0,
  drag: false
}

const settings = {
  blank_frame: 200,
  offset: 5,
  adjustment: 0,
  grid_enable: false,
  start_number: 0,
  bpm: 130,
  volume: 1,
  playback_rate: 1
};

const audio = {
  context: null,
  buffer: null,
  source: null,
  gain: null,
  playing: false,
  start_time: 0
}

document.getElementById('version').textContent = version;
const right_pane = document.getElementById('right-pane');
const right_pane_child = document.getElementById('right-pane-child');

audio.context = new AudioContext();
const canvas = document.getElementById('main-canvas');
const cursor_canvas = document.getElementById('cursor-canvas');
const canvas_ctx = canvas.getContext('2d');
const cursor_ctx = cursor_canvas.getContext('2d');
const offscreen = document.createElement('canvas');
offscreen.width = fft_size / 4;
offscreen.height = 0;
const offscreen_ctx = offscreen.getContext('2d');

/*
  画面リサイズ時の処理
*/
function resizeCanvas() {
  const rect = right_pane.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  cursor_canvas.width = rect.width;
  cursor_canvas.height = rect.height;
  draw();
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

/*
  設定値の処理
*/
function change_event(name, min, max, after) {
  document.getElementById(name).value = settings[name];
  document.getElementById(name).addEventListener('change', e => {
    const old = settings[name];
    try {
      settings[name] = parseFloat(e.target.value);
    } catch(err) {
      console.log(err);
    }
    if (isNaN(settings[name])) {
      settings[name] = old;
    }
    if (settings[name] < min) {
      settings[name] = min;
    } else if (settings[name] > max) {
      settings[name] = max;
    }
    e.target.value = settings[name];
    after();
  });
}

change_event('offset', -3600, +3600, generate_grid);
change_event('blank_frame', 0, Infinity, generate_grid);
change_event('adjustment', -3600, 3600, generate_grid);
change_event('start_number', 0, Infinity, generate_grid);
change_event('bpm', 1, 3600, generate_grid);

document.getElementById('zoom').addEventListener('input', e => {
  zoom = parseInt(e.target.value);
  draw();
});

document.getElementById('grid_enable').checked = settings.grid_enable;
document.getElementById('grid_enable').addEventListener('change', e => {
  settings.grid_enable = e.target.checked;
  draw_lines();
});

document.getElementById('volume').addEventListener('input', e => {
  settings.volume = parseFloat(e.target.value);
  if (audio.playing) {
    audio.gain.gain.value = settings.volume;
  }
});

document.getElementById('playback_rate').addEventListener('input', e => {
  settings.playback_rate = parseFloat(e.target.value);
  if (audio.playing) {
    play();
  }
});

/*
  スクロール時の処理
*/
right_pane.addEventListener('wheel', e => {
  if (!done) {
    return;
  }

  if (e.ctrlKey) {
    // Ctrlを押しているときはズーム
    e.preventDefault();
    zoom += e.deltaY > 0 ? -1 : 1;
    if (zoom < 1) {
      zoom = 1;
    } else if (zoom > 16) {
      zoom = 16;
    }
    document.getElementById('zoom').value = zoom;
  } else {
    // Ctrlを押していないときはスクロール
    begin_frame += Math.round(e.deltaY / zoom);
    if (begin_frame < 0) {
      begin_frame = 0;
    }
  }

  draw();
});

/*
  マウス処理
*/
right_pane.addEventListener('pointerdown', e => {
  if (!done) {
    return;
  }
  cursor = yToFrame(e.offsetY);

  // スクロールバークリック
  if (
    e.offsetX >= scrollbar.x &&
    e.offsetX <= scrollbar.x + scrollbar.width &&
    e.offsetY >= scrollbar.y &&
    e.offsetY <= scrollbar.y + scrollbar.height
  ) {
    scrollbar.drag = true;
    scrollbar.drag_offset = e.offsetY - scrollbar.y;
    right_pane.setPointerCapture(e.pointerId);
  } else if (settings.grid_enable && e.offsetX < scrollbar.x) {
    // グリッドをクリック
    cursor = yToFrame(e.offsetY);
      for (let i = 0; i < grid.length; i++) {
        if (cursor < grid[i] - 1) {
          break;
        }
        if (cursor >= grid[i] - 1 && cursor <= grid[i] + 2) {
          right_pane.style.cursor = 'row-resize';
          right_pane.setPointerCapture(e.pointerId);
          grid_drag_begin = i;
          break;
        }
      }
    }
});

right_pane.addEventListener('pointermove', e => {
  if (!done) {
    return;
  }
  cursor = yToFrame(e.offsetY);
  if (cursor < 0) {
    cursor = 0;
  }

  if (scrollbar.drag) {
    // スクロールバーのドラッグ
    begin_frame = (e.offsetY - scrollbar.drag_offset) * offscreen.height / (canvas.height - scrollbar.height);
    if (begin_frame < 0) {
      begin_frame = 0;
    }
    draw();
  } else if (grid_drag_begin >= 0) {
    // グリッドのドラッグ
    if (grid.length == 0) {
      return;
    }
    if (grid_drag_begin == 0) {
      if (cursor >= 0 && cursor <= offscreen.height) {
        settings.start_number = Number(cursor.toFixed(1));
        document.getElementById('start_number').value = settings.start_number;
      }
    } else if (cursor > settings.start_number) {
      settings.bpm = Number((grid_drag_begin * 3600 / (cursor - settings.start_number)).toFixed(3));
      if (settings.bpm < 1) {
        settings.bpm = 1;
      } else if (settings.bpm > 3600) {
        settings.bpm = 3600;
      }
      document.getElementById('bpm').value = settings.bpm;
    }
    generate_grid();
  } else {
    // グリッド上にあるときポインタを変更する
    right_pane.style.cursor = 'auto';
    if (settings.grid_enable && e.offsetX < scrollbar.x) {
      for (let i = 0; i < grid.length; i++) {
        if (cursor < grid[i] - 1) {
          break;
        }
        if (cursor >= grid[i] - 1 && cursor <= grid[i] + 2) {
          right_pane.style.cursor = 'row-resize';
        }
      }
    }

    draw_lines();
  }
})

right_pane.addEventListener('pointerup', e => {
  scrollbar.drag = false;
  grid_drag_begin = -1;
  right_pane.style.cursor = 'auto';
  right_pane.releasePointerCapture(e.pointerId);
});

right_pane.addEventListener('pointercancel', e => {
  scrollbar.drag = false;
  grid_drag_begin = -1;
  right_pane.style.cursor = 'auto';
  right_pane.releasePointerCapture(e.pointerId);
})

right_pane.addEventListener('dblclick', e => {
  if (!done) {
    return;
  }

  cursor = yToFrame(e.offsetY);
  settings.grid_enable = true;
  settings.start_number = Number(cursor.toFixed(1));
  document.getElementById('grid_enable').checked = settings.grid_enable;
  document.getElementById('start_number').value = settings.start_number;
  generate_grid();
})

/*
  ドラッグアンドドロップ
*/
right_pane.addEventListener('dragover', e => {
  e.preventDefault();
  right_pane_child.classList.add('drag-over');
});

right_pane.addEventListener('dragleave', e => {
  right_pane_child.classList.remove('drag-over');
});

right_pane.addEventListener('drop', async e => {
  e.preventDefault();

  const files = e.dataTransfer.files;
  if (!files || files.length === 0) {
    return;
  }

  right_pane_child.classList.remove('drag-over');
  right_pane_child.classList.remove('drop-area');
  canvas_ctx.clearRect(0, 0, canvas.width, canvas.height);
  cursor_ctx.clearRect(0, 0, canvas.width, canvas.height);

  await loadAudio(files[0]);
  right_pane_child.textContent = '';
});

/*
  オーディオ処理
*/
async function loadAudio(file) {
  document.getElementById('save_result').style.display = 'none';
  done = false;
  wav = null;
  right_pane_child.textContent = '読み込み中...';
  await dom_repaint();

  audio.buffer = await audio.context.decodeAudioData(await file.arrayBuffer());
  begin_frame = 0;
  sample_rate = audio.buffer.sampleRate;

  right_pane_child.textContent = '合成中...';
  await dom_repaint();
  wav = await mix_monaural(audio.buffer);

  right_pane_child.textContent = '解析中...';
  await dom_repaint();
  await generate_spectrogram();
  done = true;

  draw();
}

// モノラルに合成
async function mix_monaural(buffer) {
  const all = Array(buffer.numberOfChannels).fill(0).map((_, i) => buffer.getChannelData(i));
  const mono = new Float32Array(buffer.length);
  for (let i = 0; i < mono.length; i++) {
    mono[i] = 0;
    for (let ch = 0; ch < all.length; ch++) {
      mono[i] += all[ch][i];
    }
    mono[i] = mono[i] / all.length;
  }
  return mono;
}

// スペクトログラム作成
async function generate_spectrogram() {
  const fft = new FFT(fft_size);
  const comp = fft.createComplexArray(); 
  const window_arr = hann(fft_size);
  const len = Math.floor((wav.length - fft_size) / sample_rate * 60);

  const ctx = offscreen_ctx;
  offscreen.height = len;
  ctx.clearRect(0, 0, offscreen.width, offscreen.height);
  const image_data = ctx.createImageData(offscreen.width, offscreen.height);

  for (let frame = 0; frame < len; frame++) {
    const begin = frame * Math.floor(sample_rate / 60) - fft_size / 2;
    const input = new Array(fft_size);

    for (let i = 0; i < fft_size; i++) {
      input[i] = wav[begin + i] ?? 0 * window_arr[i];
    }

    fft.realTransform(comp, input);
    fft.completeSpectrum(comp);

    for (let i = 0; i < fft_size / 2; i += 2) {
      const abs = Math.sqrt(comp[i * 2] * comp[i * 2] + comp[i * 2 + 1] * comp[i * 2 + 1]);
      const val = Math.max(0, (20 * Math.log10(abs + 1e-8) + 80) / 80);
      const j = (frame * fft_size / 2 + i) * 2;

      let r, g, b;
      if (val < 0.25) {
        r = 0;
        g = val * 255 / 0.25;
        b = 255;
      } else if (val < 0.5) {
        r = 0;
        g = 255;
        b = 255 - (val - 0.25) * 255 / 0.25;
      } else if (val < 0.75) {
        r = (val - 0.5) * 255 / 0.25;
        g = 255;
        b = 0;
      } else {
        r = 255;
        g = 255 - (val - 0.75) * 255 / 0.25;
        b = 0;
      }

      image_data.data[j + 0] = r;
      image_data.data[j + 1] = g;
      image_data.data[j + 2] = b;
      image_data.data[j + 3] = 255;
    }
  }
  ctx.putImageData(image_data, 0, 0);
}

// 窓関数
function hann(size) {
  const w = new Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);
  }
  return w;
}

/*
  描画メイン
*/
function draw() {
  requestAnimationFrame(draw_main);
}

function draw_main() {
  if (!done) {
    return;
  }

  if (audio.playing) {
    play();
  }

  const ctx = canvas_ctx;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (begin_frame < 0) {
    begin_frame = 0;
  } else if (begin_frame > wav.length / sample_rate * 60) {
    begin_frame = Math.ceil(wav.length / sample_rate * 60);
  }

  generate_grid();
  draw_wav();
  draw_spectrogram();

  // スクロールバー
  ctx.fillStyle = '#333333';
  scrollbar.height = Math.max(10, (yToFrame(canvas.height - 1) - yToFrame(0)) / offscreen.height * canvas.height);
  scrollbar.x = canvas.width - scrollbar.width;
  scrollbar.y = begin_frame / offscreen.height * (canvas.height - scrollbar.height);

  ctx.fillRect(scrollbar.x, scrollbar.y, scrollbar.width, scrollbar.height);
}

// 波形描画
function draw_wav() {
  const ctx = canvas_ctx;
  ctx.beginPath();
  ctx.strokeStyle = '#333333';

  const begin = Math.floor(begin_frame / 60 * sample_rate);
  for (let i = begin + 1; i < begin + canvas.height / 60 * sample_rate / zoom; i++) {
    ctx.moveTo(wav[i - 1] * 100 + 100, (i - 1 - begin) / sample_rate * 60 * zoom);
    ctx.lineTo(wav[i] * 100 + 100, (i - begin) / sample_rate * 60 * zoom);
  }

  ctx.stroke();
}

// スペクトログラム描画
function draw_spectrogram() {
  const ctx = canvas_ctx;
  ctx.imageSmoothingEnabled = false;

  ctx.drawImage(offscreen,
    0,
    begin_frame,
    offscreen.width,
    Math.ceil(canvas.height / zoom),
    200,
    0,
    offscreen.width,
    Math.ceil(canvas.height / zoom) * zoom
  );
}

// カーソル・グリッド描画
function draw_lines() {
  if (!done) {
    return;
  }

  const ctx = cursor_ctx;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // グリッド表示
  if (settings.grid_enable) {
    for (let i = 0; i < grid.length; i++) {
      if (i % 4 == 0) {
        ctx.fillStyle = 'rgba(255, 0, 0, 0.25)';
      } else {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
      }
      const y = frameToY(grid[i]);
      if (y < 0) continue;
      if (y > canvas.height) break;
      ctx.fillRect(0, y, canvas.width - scrollbar.width, zoom);
    }
  }

  // 再生位置表示
  if (audio.playing) {
    const loop_len = audio.source.loopEnd - audio.source.loopStart;
    const elapsed = (audio.context.currentTime - audio.start_time) * settings.playback_rate - settings.adjustment / 60;
    const play_time = (elapsed % loop_len) + audio.source.loopStart;
    const y = frameToY(play_time * 60);
    ctx.fillStyle = 'rgba(255, 0, 0, 0.7)';
    ctx.fillRect(0, y, canvas.width - scrollbar.width, 1);
    if (draw_lines_request_id !== 0) {
      cancelAnimationFrame(draw_lines_request_id);
    }
    draw_lines_request_id = requestAnimationFrame(draw_lines);
  }

  // カーソル
  ctx.fillStyle = '#006600';
  ctx.fillRect(0, Math.round(frameToY(cursor)), canvas.width - scrollbar.width, 1);

  // カーソル位置表示
  const min = Math.floor(cursor / 3600);
  const sec = String(Math.floor(cursor / 60 - min * 60)).padStart(2, '0');
  const ms = String(Math.floor((cursor - min * 3600 - sec * 60) * 1000 / 60)).padStart(3, '0');
  document.getElementById('cursor_time').textContent = `${min}:${sec}.${ms}`;
  document.getElementById('cursor').textContent = (cursor + settings.blank_frame).toFixed(1);
}

// グリッド用の配列作成
function generate_grid() {
  document.getElementById('save_result').style.display = 'none';
  if (!done) {
    return;
  }

  grid = [];
  let frame = settings.start_number;
  let frame_per_beat = 3600 / settings.bpm;
  while (frame <= offscreen.height) {
    grid.push(Math.round(frame));
    frame += frame_per_beat;
  }

  draw_lines();
}

// DOM再描画
async function dom_repaint(resolve) {
  await new Promise(res => requestAnimationFrame(res));
  await new Promise(res => requestAnimationFrame(res));
}

/*
  座標計算
*/
function frameToY(frame) {
  return (frame - begin_frame - settings.offset) * zoom;
}

function yToFrame(y) {
  return y / zoom + begin_frame + settings.offset;
}

/*
  曲再生処理
*/
function play() {
  if (!done) {
    return;
  }

  play_stop();
  audio.source = audio.context.createBufferSource();
  audio.source.buffer = audio.buffer;
  audio.source.loop = true;
  audio.source.loopStart = begin_frame / 60;
  audio.source.loopEnd = Math.min(yToFrame(canvas.height) / 60, audio.buffer.duration);
  audio.source.playbackRate.value = settings.playback_rate;
  audio.start_time = audio.context.currentTime;

  audio.gain = audio.context.createGain();
  audio.gain.gain.value = settings.volume;
  audio.gain.connect(audio.context.destination);
  audio.source.connect(audio.gain);

  try {
    audio.source.start(audio.start_time, audio.source.loopStart);
    audio.playing = true;
  } catch (e){
    console.log(e);
    audio.source = null;
    audio.playing = false;
  }

  draw_lines();
}

function play_stop() {
  if (audio.source) {
    try {
      audio.source.stop();
    } catch (e) {
      console.log(e);
      audio.source = null;
    }
  }
  if (draw_lines_request_id !== 0) {
    cancelAnimationFrame(draw_lines_request_id);
    draw_lines_request_id = 0;
  }
  audio.playing = false;
}

function toggle_play() {
  if (audio.playing) {
    play_stop();
  } else {
    play();
  }
}

document.getElementById('play').addEventListener('click', toggle_play);
window.addEventListener('keypress', e => {
  if (e.key == 'Enter') {
    toggle_play();
  }
});

/*
  エディタ出力
*/
document.getElementById('save').addEventListener('click', e => {
  if (!navigator?.clipboard?.writeText) {
    return;
  }
  const save = {
    keyKind: document.getElementById('key').value,
    scores: [],
    blankFrame: settings.blank_frame,
    timings: [
      {
        label: 1,
        startNum: settings.start_number,
        bpm: settings.bpm,
        pageBlockNum: 8
      }
    ],
    scoreNumber: 1,
    scorePrefix: ''
  };
  navigator.clipboard.writeText(JSON.stringify(save)).catch(e => {
    console.log(e);
  }).then(e => {
    document.getElementById('save_result').style.display = 'inline';
  });
});
