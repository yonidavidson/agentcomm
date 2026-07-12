// Background: a small constellation of "agent" nodes exchanging glowing
// "message" pulses along their connections. Purely decorative, paused
// under prefers-reduced-motion.
(function agentNetwork() {
  // every code box gets a Copy button (commands only — outputs and comments
  // are display, not paste material); blocks with a hand-set data-copy keep it
  document.querySelectorAll('.codeblock').forEach((block) => {
    if (block.querySelector('.copy-btn')) return;
    const cmds = [...block.querySelectorAll('.line')]
      .filter((l) => !l.classList.contains('out') && !l.textContent.trim().startsWith('#'))
      .map((l) => l.textContent.replace(/^\$\s?/, '').trim())
      .filter(Boolean);
    if (!cmds.length) return;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.dataset.copy = cmds.join('\n');
    block.prepend(btn);
  });

  // Live board: the repo's own bus, read client-side. Listing via the
  // contents API (60/hr anon is plenty), bodies via the raw CDN. Any
  // failure hides the section — the page never shows a broken board.
  (async () => {
    const board = document.getElementById('live-board');
    if (!board) return;
    try {
      const list = await fetch(
        'https://api.github.com/repos/yonidavidson/agentcomm/contents/agents?ref=agentcomm',
      ).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
      const files = list.filter((f) => f.name.endsWith('.json')).slice(0, 12);
      const agents = (
        await Promise.all(
          files.map((f) =>
            fetch(f.download_url).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          ),
        )
      ).filter(Boolean);
      if (!agents.length) return;
      agents.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
      const rows = document.getElementById('live-rows');
      const rel = (iso) => {
        const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
        if (!isFinite(m)) return '';
        if (m < 1) return 'just now';
        if (m < 60) return m + 'm ago';
        if (m < 48 * 60) return Math.round(m / 60) + 'h ago';
        return Math.round(m / 1440) + 'd ago';
      };
      for (const a of agents.slice(0, 8)) {
        const row = document.createElement('div');
        row.className = 'board-row';
        const name = document.createElement('span');
        name.className = 'board-name';
        const dot = document.createElement('span');
        dot.className = 'board-dot' + (Date.now() - Date.parse(a.lastSeen) < 10 * 60000 ? ' on' : '');
        name.append(dot, document.createTextNode(a.name));
        const status = document.createElement('span');
        status.className = 'board-status' + (a.status ? '' : ' idle');
        status.textContent = a.status || '— no task set';
        const seen = document.createElement('span');
        seen.className = 'board-seen';
        seen.textContent = rel(a.lastSeen);
        row.append(name, status, seen);
        rows.append(row);
      }
      board.hidden = false;
    } catch {
      const rows = document.getElementById('live-rows');
      const row = document.createElement('div');
      row.className = 'board-row';
      const note = document.createElement('span');
      note.className = 'board-status idle';
      note.style.gridColumn = '1 / -1';
      note.textContent = 'could not load live data right now — the raw bus branch link below always works';
      row.append(note);
      rows.append(row);
      board.hidden = false;
    }
  })();

  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let width, height, dpr;
  let nodes = [];
  let pulses = [];
  let rings = [];
  let lastSpawn = 0;

  const NODE_COUNT_BASE = 16;
  const LINK_DIST = 230;
  const SPAWN_INTERVAL = 850;
  const ACCENT_A = [110, 231, 255];
  const ACCENT_B = [183, 148, 246];

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const count = Math.max(10, Math.min(26, Math.round((width * height) / 65000)));
    nodes = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.12,
      vy: (Math.random() - 0.5) * 0.12,
      r: 1.6 + Math.random() * 1.6,
      phase: Math.random() * Math.PI * 2,
    }));
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function mixColor(t) {
    const r = lerp(ACCENT_A[0], ACCENT_B[0], t);
    const g = lerp(ACCENT_A[1], ACCENT_B[1], t);
    const b = lerp(ACCENT_A[2], ACCENT_B[2], t);
    return `${r | 0},${g | 0},${b | 0}`;
  }

  function neighbors(node) {
    const out = [];
    for (const other of nodes) {
      if (other === node) continue;
      const dx = other.x - node.x;
      const dy = other.y - node.y;
      const d = Math.hypot(dx, dy);
      if (d < LINK_DIST) out.push({ node: other, d });
    }
    return out;
  }

  function spawnPulse(ts) {
    if (nodes.length < 2) return;
    const src = nodes[(Math.random() * nodes.length) | 0];
    const near = neighbors(src);
    if (!near.length) return;
    const dst = near[(Math.random() * near.length) | 0].node;
    pulses.push({
      src, dst,
      start: ts,
      duration: 900 + Math.random() * 700,
      color: mixColor(Math.random()),
    });
  }

  function step(ts) {
    ctx.clearRect(0, 0, width, height);

    // drift nodes gently
    for (const n of nodes) {
      n.x += n.vx;
      n.y += n.vy;
      if (n.x < -20) n.x = width + 20;
      if (n.x > width + 20) n.x = -20;
      if (n.y < -20) n.y = height + 20;
      if (n.y > height + 20) n.y = -20;
    }

    // links
    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const d = Math.hypot(dx, dy);
        if (d < LINK_DIST) {
          const alpha = (1 - d / LINK_DIST) * 0.16;
          ctx.strokeStyle = `rgba(140,160,200,${alpha})`;
          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.stroke();
        }
      }
    }

    // nodes
    for (const n of nodes) {
      const pulse = 0.55 + 0.45 * Math.sin(ts / 900 + n.phase);
      ctx.beginPath();
      ctx.fillStyle = `rgba(180,200,230,${0.35 + 0.25 * pulse})`;
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // spawn message pulses periodically
    if (!reduceMotion && ts - lastSpawn > SPAWN_INTERVAL) {
      lastSpawn = ts;
      spawnPulse(ts);
    }

    // traveling pulses
    pulses = pulses.filter((p) => ts - p.start < p.duration);
    for (const p of pulses) {
      const t = Math.min(1, (ts - p.start) / p.duration);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const x = lerp(p.src.x, p.dst.x, ease);
      const y = lerp(p.src.y, p.dst.y, ease);

      // trailing glow
      const grad = ctx.createRadialGradient(x, y, 0, x, y, 9);
      grad.addColorStop(0, `rgba(${p.color},0.9)`);
      grad.addColorStop(1, `rgba(${p.color},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.fillStyle = `rgba(${p.color},1)`;
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();

      if (t >= 0.995) {
        rings.push({ x: p.dst.x, y: p.dst.y, start: ts, color: p.color });
      }
    }

    // arrival rings
    rings = rings.filter((r) => ts - r.start < 600);
    for (const r of rings) {
      const t = (ts - r.start) / 600;
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${r.color},${1 - t})`;
      ctx.lineWidth = 1.4;
      ctx.arc(r.x, r.y, 4 + t * 18, 0, Math.PI * 2);
      ctx.stroke();
    }

    requestAnimationFrame(step);
  }

  resize();
  window.addEventListener('resize', resize);

  if (reduceMotion) {
    // Render one calm static frame, no animation loop.
    step(0);
  } else {
    requestAnimationFrame(step);
  }
})();

// Keep the selected install harness in sync across each command surface.
const harnessSwitchers = [...document.querySelectorAll('[data-harness-switcher]')];
const supportedHarnesses = new Set(['opencode', 'claude', 'codex']);
function selectHarness(harness, updateUrl = true) {
  if (!supportedHarnesses.has(harness)) harness = 'claude';
  for (const switcher of harnessSwitchers) {
    switcher.querySelectorAll('[data-harness-tab]').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab.dataset.harnessTab === harness));
    });
    switcher.querySelectorAll('[data-harness-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.harnessPanel !== harness;
    });
  }
  document.querySelectorAll('[data-harness-note]').forEach((note) => {
    note.hidden = note.dataset.harnessNote !== harness;
  });
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('harness', harness);
    history.replaceState(null, '', url);
  }
}
for (const switcher of harnessSwitchers) {
  switcher.querySelectorAll('[data-harness-tab]').forEach((tab) => {
    tab.addEventListener('click', () => selectHarness(tab.dataset.harnessTab));
  });
}
selectHarness(new URLSearchParams(window.location.search).get('harness') || 'claude', false);

// Copy-to-clipboard for code blocks.
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const text = btn.getAttribute('data-copy');
    try {
      await navigator.clipboard.writeText(text);
      const original = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('copied');
      }, 1400);
    } catch {
      /* clipboard unavailable; no-op */
    }
  });
});

// Reveal-on-scroll for sections.
const io = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        io.unobserve(entry.target);
      }
    }
  },
  { threshold: 0.12 },
);
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
