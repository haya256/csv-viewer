'use strict';

// データはこの変数（メモリ）だけに保持する。外部送信・ストレージ保存はしない。
const state = {
  fileName: '',
  buffer: null,     // 読み込んだ ArrayBuffer（文字コード切替時の再デコード用）
  encoding: '',     // 実際に使った文字コード
  headers: [],
  rows: [],
  filtered: [],     // 表示対象の行インデックス
  renderedCount: 0,
  colWidths: [],    // 列幅(px)。[0] は行番号列、[i + 1] がデータ列 i
};

const PAGE_SIZE = 1000;
const MIN_COL_WIDTH = 40;
const MAX_AUTO_FIT_WIDTH = 800;
const AUTO_FIT_SAMPLE_ROWS = 5000;

const OPERATORS = [
  { value: 'contains', label: 'を含む' },
  { value: 'notContains', label: 'を含まない' },
  { value: 'equals', label: 'と等しい' },
  { value: 'notEquals', label: 'と等しくない' },
  { value: 'startsWith', label: 'で始まる' },
  { value: 'gt', label: '> (数値)' },
  { value: 'lt', label: '< (数値)' },
  { value: 'gte', label: '≧ (数値)' },
  { value: 'lte', label: '≦ (数値)' },
  { value: 'empty', label: '空', noValue: true },
  { value: 'notEmpty', label: '空でない', noValue: true },
];

const el = {
  fileInput: document.getElementById('fileInput'),
  encodingSelect: document.getElementById('encodingSelect'),
  searchInput: document.getElementById('searchInput'),
  addFilterButton: document.getElementById('addFilterButton'),
  filterList: document.getElementById('filterList'),
  status: document.getElementById('status'),
  tableContainer: document.getElementById('tableContainer'),
  moreButton: document.getElementById('moreButton'),
  dropOverlay: document.getElementById('dropOverlay'),
};

// ---------- 読み込み ----------

function loadFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    state.fileName = file.name;
    state.buffer = reader.result;
    el.filterList.textContent = '';
    el.searchInput.value = '';
    processBuffer();
  };
  reader.onerror = () => {
    el.status.textContent = 'ファイルの読み込みに失敗しました。';
  };
  reader.readAsArrayBuffer(file);
}

function decode(buffer, mode) {
  const bytes = new Uint8Array(buffer);
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

  if (mode === 'auto') {
    if (hasBom) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8 (BOM付き)' };
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' };
    } catch (e) {
      return { text: new TextDecoder('shift_jis').decode(bytes), encoding: 'Shift_JIS' };
    }
  }
  if (mode === 'utf-8') {
    return { text: new TextDecoder('utf-8').decode(hasBom ? bytes.subarray(3) : bytes), encoding: 'UTF-8' };
  }
  return { text: new TextDecoder('shift_jis').decode(bytes), encoding: 'Shift_JIS' };
}

function processBuffer() {
  if (!state.buffer) return;
  const { text, encoding } = decode(state.buffer, el.encodingSelect.value);
  state.encoding = encoding;

  const delimiter = /\.tsv$/i.test(state.fileName) ? '\t' : ',';
  const records = parseCsv(text, delimiter);
  const colCount = records.reduce((max, r) => Math.max(max, r.length), 0);

  const header = records.shift() || [];
  state.headers = Array.from({ length: colCount }, (_, i) => header[i] || `列${i + 1}`);
  state.rows = records;
  state.colWidths = [];

  // 列名が変わる可能性があるので、既存フィルタの列選択肢を更新
  el.filterList.querySelectorAll('.filter-column').forEach(fillColumnOptions);

  el.searchInput.disabled = false;
  el.addFilterButton.disabled = false;
  applyFilters();
}

// ---------- CSVパース（RFC4180準拠の状態機械） ----------

function parseCsv(text, delimiter) {
  const records = [];
  let record = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { inQuotes = true; i++; continue; }
    if (c === delimiter) { record.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      record.push(field); field = '';
      records.push(record); record = [];
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++; continue;
    }
    field += c; i++;
  }
  // 末尾に改行がない最終行
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // 空行（フィールドが1つで空）は除外
  return records.filter(r => !(r.length === 1 && r[0] === ''));
}

// ---------- 検索・フィルタ ----------

function fillColumnOptions(select) {
  const current = select.value;
  select.textContent = '';
  state.headers.forEach((name, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = name;
    select.appendChild(opt);
  });
  if (current !== '' && Number(current) < state.headers.length) select.value = current;
}

function addFilterRow() {
  const row = document.createElement('div');
  row.className = 'filter-row';

  const andLabel = document.createElement('span');
  andLabel.className = 'and-label';
  andLabel.textContent = el.filterList.children.length === 0 ? '条件' : 'かつ';

  const colSelect = document.createElement('select');
  colSelect.className = 'filter-column';
  fillColumnOptions(colSelect);

  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.className = 'filter-value';
  valueInput.placeholder = '値';

  const opSelect = document.createElement('select');
  opSelect.className = 'filter-op';
  OPERATORS.forEach(op => {
    const opt = document.createElement('option');
    opt.value = op.value;
    opt.textContent = op.label;
    opSelect.appendChild(opt);
  });

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.textContent = '×';
  removeButton.title = 'この条件を削除';

  colSelect.addEventListener('change', applyFilters);
  opSelect.addEventListener('change', () => {
    const op = OPERATORS.find(o => o.value === opSelect.value);
    valueInput.hidden = !!op.noValue;
    applyFilters();
  });
  valueInput.addEventListener('input', debounce(applyFilters, 200));
  removeButton.addEventListener('click', () => {
    row.remove();
    const first = el.filterList.querySelector('.and-label');
    if (first) first.textContent = '条件';
    applyFilters();
  });

  // 「[列] が [値] [演算子]」の語順で並べる
  const ga = document.createElement('span');
  ga.textContent = 'が';
  row.append(andLabel, colSelect, ga, valueInput, opSelect, removeButton);
  el.filterList.appendChild(row);
  valueInput.focus();
}

function readConditions() {
  return Array.from(el.filterList.querySelectorAll('.filter-row')).map(row => ({
    col: Number(row.querySelector('.filter-column').value),
    op: row.querySelector('.filter-op').value,
    value: row.querySelector('.filter-value').value,
  }));
}

function toNumber(s) {
  const t = String(s).replace(/,/g, '').trim();
  if (t === '') return NaN;
  return Number(t);
}

function matchCondition(cell, cond) {
  const v = cell == null ? '' : cell;
  const lv = v.toLowerCase();
  const lq = cond.value.toLowerCase();
  switch (cond.op) {
    case 'contains': return lv.includes(lq);
    case 'notContains': return !lv.includes(lq);
    case 'equals': return v === cond.value;
    case 'notEquals': return v !== cond.value;
    case 'startsWith': return lv.startsWith(lq);
    case 'empty': return v.trim() === '';
    case 'notEmpty': return v.trim() !== '';
  }
  const a = toNumber(v);
  const b = toNumber(cond.value);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  switch (cond.op) {
    case 'gt': return a > b;
    case 'lt': return a < b;
    case 'gte': return a >= b;
    case 'lte': return a <= b;
  }
  return true;
}

function applyFilters() {
  const keyword = el.searchInput.value.trim().toLowerCase();
  // 値未入力の条件（空/空でない以外）は無視する
  const conds = readConditions().filter(c => {
    const op = OPERATORS.find(o => o.value === c.op);
    return op.noValue || c.value !== '';
  });

  state.filtered = [];
  state.rows.forEach((row, idx) => {
    if (keyword && !row.some(cell => cell.toLowerCase().includes(keyword))) return;
    if (!conds.every(c => matchCondition(row[c.col], c))) return;
    state.filtered.push(idx);
  });
  renderTable();
}

// ---------- 描画 ----------

function renderTable() {
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const numTh = document.createElement('th');
  numTh.className = 'row-num';
  numTh.textContent = '#';
  headRow.appendChild(numTh);
  state.headers.forEach((name, i) => {
    const th = document.createElement('th');
    th.textContent = name;
    const resizer = document.createElement('div');
    resizer.className = 'col-resizer';
    resizer.title = 'ドラッグで幅を変更／ダブルクリックで自動調整';
    resizer.addEventListener('pointerdown', e => startResize(e, table, i + 1));
    resizer.addEventListener('dblclick', () => setColumnWidth(table, i + 1, autoFitWidth(i)));
    th.appendChild(resizer);
    headRow.appendChild(th);
  });

  const colgroup = document.createElement('colgroup');
  for (let c = 0; c <= state.headers.length; c++) colgroup.appendChild(document.createElement('col'));
  table.appendChild(colgroup);
  thead.appendChild(headRow);
  table.appendChild(thead);
  table.appendChild(document.createElement('tbody'));

  el.tableContainer.textContent = '';
  el.tableContainer.appendChild(table);
  el.tableContainer.scrollTop = 0;
  state.renderedCount = 0;
  renderMoreRows();
  applyColumnWidths(table);
}

// ---------- 列幅 ----------

// 初回はブラウザの自動レイアウト結果を測って幅を確定し、以降は固定レイアウトで保持する
function applyColumnWidths(table) {
  const ths = table.querySelectorAll('thead th');
  if (state.colWidths.length !== ths.length) {
    state.colWidths = Array.from(ths, th => Math.ceil(th.getBoundingClientRect().width));
    // 「さらに表示」で行番号の桁が増えても切れないようにする
    const numWidth = measureTextWidth(String(state.rows.length), ths[0]) + cellPadding(ths[0]);
    state.colWidths[0] = Math.max(state.colWidths[0], numWidth);
  }
  table.querySelectorAll('col').forEach((col, i) => { col.style.width = state.colWidths[i] + 'px'; });
  table.style.width = state.colWidths.reduce((a, b) => a + b, 0) + 'px';
  table.classList.add('fixed');
}

function setColumnWidth(table, colIndex, width) {
  state.colWidths[colIndex] = Math.round(width);
  table.querySelectorAll('col')[colIndex].style.width = state.colWidths[colIndex] + 'px';
  table.style.width = state.colWidths.reduce((a, b) => a + b, 0) + 'px';
}

function startResize(e, table, colIndex) {
  e.preventDefault();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startWidth = state.colWidths[colIndex];
  document.body.classList.add('resizing');

  const move = ev => setColumnWidth(table, colIndex, Math.max(MIN_COL_WIDTH, startWidth + ev.clientX - startX));
  const end = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    document.body.classList.remove('resizing');
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// 見出しと該当行の内容（各行の最長行）に合わせた幅を求める
function autoFitWidth(dataCol) {
  const th = el.tableContainer.querySelectorAll('thead th')[dataCol + 1];
  const td = el.tableContainer.querySelector('tbody td:not(.row-num)') || th;
  let max = measureTextWidth(state.headers[dataCol], th);
  const limit = Math.min(state.filtered.length, AUTO_FIT_SAMPLE_ROWS);
  for (let i = 0; i < limit; i++) {
    const cell = state.rows[state.filtered[i]][dataCol];
    if (!cell) continue;
    for (const line of cell.split('\n')) max = Math.max(max, measureTextWidth(line, td));
  }
  return Math.min(MAX_AUTO_FIT_WIDTH, Math.max(MIN_COL_WIDTH, Math.ceil(max) + cellPadding(th) + 4));
}

let measureCtx = null;
function measureTextWidth(text, refEl) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  const cs = getComputedStyle(refEl);
  measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return measureCtx.measureText(text).width;
}

function cellPadding(cellEl) {
  const cs = getComputedStyle(cellEl);
  return parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
    parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
}

function renderMoreRows() {
  const tbody = el.tableContainer.querySelector('tbody');
  if (!tbody) return;
  const end = Math.min(state.renderedCount + PAGE_SIZE, state.filtered.length);
  const frag = document.createDocumentFragment();
  const colCount = state.headers.length;

  for (let i = state.renderedCount; i < end; i++) {
    const idx = state.filtered[i];
    const row = state.rows[idx];
    const tr = document.createElement('tr');
    const numTd = document.createElement('td');
    numTd.className = 'row-num';
    numTd.textContent = String(idx + 1);
    tr.appendChild(numTd);
    for (let c = 0; c < colCount; c++) {
      const td = document.createElement('td');
      td.textContent = row[c] == null ? '' : row[c];
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  state.renderedCount = end;

  const remaining = state.filtered.length - state.renderedCount;
  el.moreButton.hidden = remaining <= 0;
  el.moreButton.textContent = `さらに表示（残り ${remaining.toLocaleString()} 行）`;
  updateStatus();
}

function updateStatus() {
  const total = state.rows.length.toLocaleString();
  const hit = state.filtered.length.toLocaleString();
  const shown = state.renderedCount.toLocaleString();
  el.status.textContent =
    `${state.fileName} ｜ 文字コード: ${state.encoding} ｜ 全 ${total} 行中 ${hit} 行が該当` +
    (state.renderedCount < state.filtered.length ? `（${shown} 行を表示中）` : '');
}

// ---------- ユーティリティ ----------

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------- イベント ----------

el.fileInput.addEventListener('change', () => {
  loadFile(el.fileInput.files[0]);
  el.fileInput.value = ''; // 同じファイルを再選択できるように
});
el.encodingSelect.addEventListener('change', processBuffer);
el.searchInput.addEventListener('input', debounce(applyFilters, 200));
el.addFilterButton.addEventListener('click', addFilterRow);
el.moreButton.addEventListener('click', renderMoreRows);

let dragDepth = 0;
document.addEventListener('dragenter', e => {
  e.preventDefault();
  dragDepth++;
  el.dropOverlay.hidden = false;
});
document.addEventListener('dragleave', e => {
  e.preventDefault();
  dragDepth--;
  if (dragDepth <= 0) { dragDepth = 0; el.dropOverlay.hidden = true; }
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  el.dropOverlay.hidden = true;
  loadFile(e.dataTransfer.files[0]);
});
