/* 结构与逻辑自检：node selftest.js
   用桩 DOM 在 Node 里真实启动 index.html 里的游戏脚本，然后校验
   求解器、规则边界，以及「点棋子 -> 点空位」这条交互主路径。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const ok = [], fail = [];
const check = (name, cond, extra) => (cond ? ok : fail).push(name + (extra ? ' :: ' + extra : ''));

/* ---------- 1. 文件结构 ---------- */
check('内嵌 script 存在', /<script>[\s\S]*<\/script>/.test(html));
check('无外部资源依赖（可离线打开）', !/(src|href)\s*=\s*["']https?:/i.test(html));
check('声明了移动端 viewport', /name="viewport"/.test(html));
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

/* ---------- 2. 桩 DOM ---------- */
function makeStyle(init) {
  const store = Object.assign({}, init || {});
  return {
    setProperty: (k, v) => { store[k] = v; },
    getPropertyValue: k => store[k] || '',
    rowGap: '10px'
  };
}
function makeEl(tag) {
  const el = {
    tagName: tag, dataset: {}, style: makeStyle(), children: [], textContent: '',
    type: '', disabled: false, offsetWidth: 40, offsetHeight: 40, lang: '',
    _cls: new Set(), _attrs: {}, _listeners: {},
    classList: {
      add: (...c) => c.forEach(x => el._cls.add(x)),
      remove: (...c) => c.forEach(x => el._cls.delete(x)),
      contains: c => el._cls.has(c),
      toggle: (c, on) => { (on === undefined ? !el._cls.has(c) : on) ? el._cls.add(c) : el._cls.delete(c); }
    },
    appendChild(c) { el.children.push(c); c.parentElement = el; return c; },
    setAttribute(k, v) { el._attrs[k] = v; },
    getAttribute(k) { return k in el._attrs ? el._attrs[k] : null; },
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    // 桩里实现最小可用的 closest：支持 ".cls" 与标签名，沿 parentElement 上溯
    closest(sel) {
      const parts = String(sel).split(',').map(x => x.trim()).filter(Boolean);
      const match = (node) => parts.some(p => p.charAt(0) === '.'
        ? (node.className || '').split(/\s+/).indexOf(p.slice(1)) >= 0
        : (node.tagName || '').toLowerCase() === p.toLowerCase());
      let node = el;
      while (node) { if (match(node)) return node; node = node.parentElement; }
      return null;
    },
    getBoundingClientRect() {
      const i = +el.dataset.index || 0;
      return { top: 100 + i * 50, left: 10, width: 40, height: 40, bottom: 140 + i * 50, right: 50 };
    },
    fire(type, ev) { (el._listeners[type] || []).forEach(fn => fn(ev || {})); },
    find(pred) {
      if (pred(el)) return el;
      for (const c of el.children) { const r = c.find ? c.find(pred) : (pred(c) ? c : null); if (r) return r; }
      return null;
    }
  };
  Object.defineProperty(el, 'className', {
    get() { return [...el._cls].join(' '); },
    set(v) { el._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  });
  Object.defineProperty(el, 'firstChild', { get() { return el.children[0]; } });
  return el;
}
const registry = {};
function el(id) {
  if (!registry[id]) {
    registry[id] = makeEl('div');
    registry[id].id = id;
    registry[id].parentElement = { clientHeight: 640, clientWidth: 320 };
  }
  return registry[id];
}
const doc = {
  readyState: 'complete',
  documentElement: Object.assign(makeEl('html'), { style: makeStyle({ '--cell': '44px', '--gap': '10px' }) }),
  createElement: makeEl,
  getElementById: el,
  querySelectorAll: () => [],
  _listeners: {},
  addEventListener(t, fn) { (doc._listeners[t] = doc._listeners[t] || []).push(fn); },
  removeEventListener() {}
};
const win = makeEl('window');
const ctx = {
  console, setTimeout, clearTimeout, requestAnimationFrame: fn => setTimeout(fn, 0),
  document: doc, navigator: { language: 'zh-CN' },
  location: { search: '' },
  localStorage: { _s: {}, getItem(k) { return k in this._s ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); } },
  getComputedStyle: () => ({ rowGap: '10px' }),
  addEventListener(t, fn) { win.addEventListener(t, fn); },
  removeEventListener() {}
};
ctx.window = ctx;
Object.assign(ctx, { innerWidth: 390, innerHeight: 780 });
vm.createContext(ctx);

let booted = true, bootErr = '';
try { vm.runInContext(script, ctx, { filename: 'index.inline.js' }); }
catch (e) { booted = false; bootErr = e.message; }
check('内嵌脚本可执行（含初始化）', booted, bootErr);

const fj = ctx.__fj;
check('暴露了 __fj 测试接口', !!fj);

if (fj) {
  const { solve, legalMoves, isGoal, HOME, GOAL, state } = fj;
  const board = registry['board'], pieces = registry['pieces'];

  check('生成了 7 个格子', board.children.filter(c => c._cls.has('cell')).length === 7,
        '实际 ' + board.children.length);
  check('生成了 7 枚棋子', pieces.children.length === 7);
  check('棋盘上不再显示位置代号', !/id="labels"/.test(html));
  check('棋子上显示方向箭头而不是字母', (() => {
    const txt = pieces.children.map(c => (c.children[0] || {}).textContent);
    return txt.slice(0, 3).every(s => s === '↓') && txt.slice(4).every(s => s === '↑');
  })(), JSON.stringify(pieces.children.map(c => (c.children[0] || {}).textContent)));
  check('去掉了数字键选位', !/k >= '1'/.test(script));
  check('界面文案不再出现 a/b 代号', !/[ab] 只[能向]|a 三枚|b 三枚|a 全部/.test(html));

  /* ---------- 3. 求解器 ---------- */
  const path15 = solve(HOME);
  check('初始局面有解', !!path15);
  check('最优解为 15 步', path15 && path15.length === 15, '实际 ' + (path15 && path15.length));

  let b = HOME.slice(), replayOK = true, badAt = -1;
  (path15 || []).forEach((mv, k) => {
    if (!legalMoves(b).some(m => m.from === mv.from && m.to === mv.to)) { replayOK = false; badAt = k; }
    b[mv.to] = b[mv.from]; b[mv.from] = '.';
  });
  check('最优解每一步都合法', replayOK, replayOK ? '' : '第 ' + (badAt + 1) + ' 步非法');
  check('走完最优解达成目标', isGoal(b), b.join(''));

  /* ---------- 4. 规则边界 ---------- */
  check('初始不是终局', !isGoal(HOME));
  check('目标局面即终局', isGoal(GOAL));
  check('a 只向下、b 只向上', legalMoves(HOME).every(m => {
    const p = HOME[m.from];
    return p === 'a' ? m.to > m.from : m.to < m.from;
  }));
  check('不能跳过自己人', (() => {
    const t = ['a', 'a', '.', '.', '.', '.', '.'];
    return legalMoves(t).every(m => m.kind !== 'jump');
  })());
  check('跳必须落在空位', (() => {
    const t = ['a', 'b', '.', 'b', '.', '.', '.'];
    return legalMoves(t).every(m => t[m.to] === '.');
  })());
  check('初始局面只有 a3 与 b1 能动', (() => {
    const froms = legalMoves(HOME).map(m => m.from).sort((x, y) => x - y);
    return froms.length === 2 && froms[0] === 2 && froms[1] === 4;
  })());
  check('a1 被 a2 挡住、不能跳过自己人', legalMoves(HOME).every(m => m.from !== 0));
  check('a3 走进中间空位是唯一前进方式', (() => {
    const ms = legalMoves(HOME).filter(m => m.from === 2);
    return ms.length === 1 && ms[0].kind === 'step' && ms[0].to === 3;
  })());

  /* ---------- 5. 交互主路径：点棋子 -> 点空位 ---------- */
  const cellAt = i => board.children.filter(c => c._cls.has('cell'))[i];
  // 棋子挂在 pieces 容器下，按创建顺序对应位置下标
  const pieceAt = i => pieces.children.filter(c => (c.className || '').indexOf('piece') === 0)[i];
  const click = target => board.fire('click', { target });

  click(pieceAt(1));                                  // a2 被 a3 挡住，无路可走
  check('点走不动的棋子不会选中', state.selected === null, 'selected=' + state.selected);

  click(pieceAt(2));                                  // 选中 a3
  check('选中棋子后记录选中态', state.selected === 2, 'selected=' + state.selected);
  check('选中后高亮可达空位', cellAt(3)._cls.has('target'));
  check('选中后棋子标记 selected', pieceAt(2)._cls.has('selected'));

  click(cellAt(3));                                   // 走进中间空位
  check('落子后棋盘正确', state.board.join('') === 'aa.abbb', state.board.join(''));
  check('落子后步数 +1', state.moves === 1, 'moves=' + state.moves);
  check('落子后清空选中', state.selected === null);
  check('落子后撤销可用', el('btnUndo').disabled === false);

  click(cellAt(0));                                   // 点空位但没人能到 -> 不应改变局面
  check('非法空位不会改变局面', state.board.join('') === 'aa.abbb', state.board.join(''));

  el('btnUndo').fire('click');                        // 撤销
  check('撤销恢复上一步局面', state.board.join('') === 'aaa.bbb', state.board.join(''));
  check('撤销恢复步数', state.moves === 0, 'moves=' + state.moves);

  el('btnHint').fire('click');                        // 提示
  check('提示给出最优一步', state.hintMove && state.hintMove.length === 2);
  check('提示高亮起点与终点', cellAt(state.hintMove[0])._cls.has('hint') && cellAt(state.hintMove[1])._cls.has('hint'));

  el('btnRestart').fire('click');
  check('重开回到初始局面', state.board.join('') === 'aaa.bbb' && state.moves === 0, state.board.join('') + ' / ' + state.moves);

  /* ---------- 6. 完整通关（自动走完最优解，应触发胜利） ---------- */
  const auto = solve(state.board) || [];
  auto.forEach(mv => {
    click(pieceAt(mv.from));
    click(cellAt(mv.to));
  });
  check('走完最优解触发胜利', state.won === true, 'won=' + state.won);
  check('15 步通关', state.moves === 15, 'moves=' + state.moves);
  check('胜利弹层显示', el('winOverlay')._cls.has('show'));
  check('记录了最少步数', ctx.localStorage.getItem('fj_best') === '15', String(ctx.localStorage.getItem('fj_best')));
  check('记录了通关次数', ctx.localStorage.getItem('fj_wins') === '1', String(ctx.localStorage.getItem('fj_wins')));
}

console.log('\n通过 (' + ok.length + ')');
ok.forEach(s => console.log('  ✓ ' + s));
if (fail.length) {
  console.log('\n失败 (' + fail.length + ')');
  fail.forEach(s => console.log('  ✗ ' + s));
  process.exitCode = 1;
} else {
  console.log('\n全部通过 ✅');
}
