// Token Radar client dashboard: zero-network, deterministic, reads window.RADAR from ../data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('radar-app');

  var state = {
    q: '',
    category: 'all',
    tier: 'all',
    tab: 'pre-token',
    sort: 'implied',
    dir: -1,
    selected: null
  };

  var usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFmt.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // Mirrors lib/model.ts impliedValue() so the UI verifies board.json arithmetic live.
  function recomputeImplied(row, m) {
    var rawG = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    var gPct = clamp(rawG, m.growth_floor, m.growth_cap);
    var gMult = 1 + (gPct / 100) * m.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? m.unknown_age_days : row.age_days;
    var mMult = m.maturity_floor + (clamp(age, 0, m.maturity_days) / m.maturity_days) * m.maturity_range;
    var extra = clamp((row.chains ? row.chains.length : 1) - 1, 0, m.breadth_max_extra);
    var bMult = 1 + extra * m.breadth_step;
    return Math.max(1, Math.round(row.tvl_usd * row.category_multiple * gMult * mMult * bMult));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    state.q = '';
    state.category = 'all';
    state.tier = 'all';
    state.tab = 'pre-token';
    state.sort = 'implied';
    state.dir = -1;
    state.selected = null;
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return;
    var p = new URLSearchParams(h);
    if (p.get('q')) state.q = p.get('q');
    if (p.get('category')) state.category = p.get('category');
    if (p.get('tier')) state.tier = p.get('tier');
    if (p.get('tab')) state.tab = p.get('tab');
    if (p.get('sort')) state.sort = p.get('sort');
    if (p.get('dir')) state.dir = p.get('dir') === '1' ? 1 : -1;
    if (p.get('p')) state.selected = p.get('p');
  }

  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.tier !== 'all') p.set('tier', state.tier);
    if (state.tab !== 'pre-token') p.set('tab', state.tab);
    if (state.sort !== 'implied') p.set('sort', state.sort);
    if (state.dir !== -1) p.set('dir', String(state.dir));
    if (state.selected) p.set('p', state.selected);
    var s = p.toString();
    window.history.replaceState(null, '', s ? '#' + s : window.location.pathname + window.location.search);
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.tier === 'watchlist' && !r.in_watchlist) return false;
      if (state.tier === 'early' && r.in_watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? -1 : a.age_days; bv = b.age_days === null ? -1 : b.age_days; }
      else if (key === 'mult') { av = a.category_multiple; bv = b.category_multiple; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.rank - b.rank;
    });
  }

  function renderHeader() {
    return el('header', { class: 'topbar' },
      el('div', { class: 'brand' },
        el('span', { class: 'dot' }),
        el('span', { class: 'brand-title', text: 'Token Radar' })
      ),
      el('div', { class: 'meta-pills' },
        el('span', { class: 'pill', text: 'Snapshot ' + DATA.as_of }),
        el('span', { class: 'pill', text: 'Model ' + DATA.model_version }),
        el('span', { class: 'pill', text: DATA.live_peer_count + ' live peers calibrated' })
      )
    );
  }

  function renderHero() {
    var topImplied = DATA.rows.length > 0 ? DATA.rows[0].implied_value_usd : 0;
    return el('section', { class: 'hero' },
      el('div', null,
        el('h1', { text: 'Pre-token protocols ranked by peer-calibrated implied value' }),
        el('p', { text: 'Covers all ' + DATA.watchlist_size + ' watchlist protocols (>= $' + Math.round(DATA.floor_usd / 1e6) + 'M TVL, no token on record) plus ' + DATA.early_size + ' early pre-token protocols. Multiples are calibrated from ' + DATA.live_peer_count + ' live-token peers in the same snapshot.' })
      ),
      el('div', { class: 'kpi-grid' },
        el('div', { class: 'kpi' }, el('span', { text: 'Watchlist coverage' }), el('b', { class: 'warn', text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'kpi' }, el('span', { text: 'Pre-token ranked' }), el('b', { class: 'accent', text: String(DATA.board_size) })),
        el('div', { class: 'kpi' }, el('span', { text: 'Global median MCAP/TVL' }), el('b', { text: DATA.global_median_multiple.toFixed(2) + 'x' })),
        el('div', { class: 'kpi' }, el('span', { text: 'Top implied value' }), el('b', { text: fmtUsd(topImplied) }))
      )
    );
  }

  function renderControls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = el('input', {
      type: 'search', id: 'q', placeholder: 'Search protocol, chain, or category...',
      value: state.q, 'aria-label': 'Search protocols'
    });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });

    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories (' + categories.length + ')' }),
      categories.map(function (c) {
        return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null });
      })
    );
    select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });

    var tierBtns = [
      { id: 'all', label: 'All (' + DATA.board_size + ')' },
      { id: 'watchlist', label: 'Watchlist (' + (DATA.board_size - DATA.early_size) + ')' },
      { id: 'early', label: 'Early (' + DATA.early_size + ')' }
    ].map(function (t) {
      return el('button', {
        type: 'button', 'aria-pressed': state.tier === t.id ? 'true' : 'false', text: t.label,
        onclick: function () { state.tier = t.id; state.tab = 'pre-token'; writeHash(); render(); }
      });
    });

    var tabPre = el('button', {
      type: 'button', class: 'tab-active', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false',
      text: 'Pre-token Radar', onclick: function () { state.tab = 'pre-token'; writeHash(); render(); }
    });
    var tabLive = el('button', {
      type: 'button', class: 'tab-active', 'aria-pressed': state.tab === 'live' ? 'true' : 'false',
      text: 'Live Tokens (' + DATA.live_size + ')', onclick: function () { state.tab = 'live'; writeHash(); render(); }
    });

    var shown = state.tab === 'pre-token' ? filteredRows().length : DATA.live.length;
    var hasFilter = state.q !== '' || state.category !== 'all' || state.tier !== 'all';

    return el('section', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('label', { text: 'Tier' }), el('div', { class: 'seg' }, tierBtns)),
      el('div', { class: 'field' }, el('label', { text: 'View' }), el('div', { class: 'seg' }, tabPre, tabLive)),
      el('div', { class: 'controls-right' },
        el('span', { class: 'count-label', text: shown + ' shown' }),
        hasFilter ? el('button', {
          type: 'button', class: 'btn-ghost', text: 'Reset',
          onclick: function () { state.q = ''; state.category = 'all'; state.tier = 'all'; writeHash(); render(); }
        }) : null
      )
    );
  }

  function sortTh(key, label) {
    var arrow = state.sort === key ? (state.dir < 0 ? ' ↓' : ' ↑') : '';
    return el('th', { scope: 'col' },
      el('button', {
        type: 'button',
        onclick: function () {
          if (state.sort === key) state.dir = -state.dir;
          else { state.sort = key; state.dir = -1; }
          writeHash();
          render();
        }
      }, label + arrow)
    );
  }

  function renderPreTokenTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' },
        el('div', { class: 'empty' },
          el('h2', { text: 'No pre-token protocols match these filters' }),
          el('p', { text: 'Clear the search query, category, or tier filter to view the ranked board.' }),
          el('button', {
            type: 'button', class: 'btn-primary', text: 'Reset all filters',
            onclick: function () { state.q = ''; state.category = 'all'; state.tier = 'all'; writeHash(); render(); }
          })
        )
      );
    }

    var maxImplied = Math.max.apply(null, list.map(function (r) { return r.implied_value_usd; })) || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var gText = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var gCls = r.change_7d === null ? '' : (r.change_7d >= 0 ? 'pos' : 'neg');
      var chainsText = r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') : 'unlisted chain';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: '#' + r.rank }),
        el('td', null,
          el('div', { class: 'proto-cell' },
            el('span', { class: 'proto-name', text: r.name }),
            el('span', { class: 'pill ' + (r.in_watchlist ? 'watch' : 'early'), text: r.in_watchlist ? 'Watchlist' : 'Early' })
          ),
          el('div', { class: 'proto-sub', text: (r.category || 'Other') + ' · ' + chainsText })
        ),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + gCls, text: gText }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: r.category_multiple.toFixed(2) + 'x' }),
        el('td', null,
          el('div', { class: 'val-wrap' },
            el('div', { class: 'bar', 'aria-hidden': 'true' },
              el('i', { style: 'width:' + Math.max(4, Math.round((r.implied_value_usd / maxImplied) * 100)) + '%' })
            ),
            el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
          )
        )
      );
      tbody.appendChild(tr);
    });

    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Pre-token protocols ranked by implied value. Click any row for its valuation equation and concrete farm plan.' }),
          el('thead', null, el('tr', null,
            sortTh('implied', 'Rank'),
            sortTh('name', 'Protocol'),
            sortTh('tvl', 'TVL'),
            sortTh('growth', '7d TVL'),
            sortTh('age', 'Age'),
            sortTh('mult', 'Cat. Mult'),
            sortTh('implied', 'Implied Value')
          )),
          tbody
        )
      )
    );
  }

  function renderLiveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      var gCls = r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg';
      tbody.appendChild(el('tr', null,
        el('td', null, el('span', { class: 'pill live', text: 'Trading' })),
        el('td', null,
          el('div', { class: 'proto-name', text: r.name }),
          el('div', { class: 'proto-sub', text: (r.category || 'Other') + ' · ' + (r.chains.slice(0, 2).join(', ') || 'unlisted') })
        ),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + gCls, text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.mcap_tvl_ratio !== null ? r.mcap_tvl_ratio.toFixed(2) + 'x' : 'n/a' })
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Live-token protocols set aside from the pre-token ranking. Their market-cap-to-TVL ratios calibrate the category peer multiples.' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Status' }),
            el('th', { scope: 'col', text: 'Protocol' }),
            el('th', { scope: 'col', text: 'TVL' }),
            el('th', { scope: 'col', text: '7d TVL' }),
            el('th', { scope: 'col', text: 'Market Cap' }),
            el('th', { scope: 'col', text: 'MCAP/TVL' })
          )),
          tbody
        )
      )
    );
  }

  function renderModelPanel() {
    var m = DATA.model;
    var topCats = (DATA.category_stats || []).slice(0, 10);
    return el('section', { class: 'panel model-panel' },
      el('h2', { text: 'Peer-calibrated valuation model (' + DATA.model_version + ')' }),
      el('div', { class: 'formula-box', text: 'implied = round( tvl_usd * cat_multiple * (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ')/100 * ' + m.growth_weight + ') * (' + m.maturity_floor + ' + min(age, ' + m.maturity_days + ')/' + m.maturity_days + ' * ' + m.maturity_range + ') * (1 + min(chains-1, ' + m.breadth_max_extra + ') * ' + m.breadth_step + ') )' }),
      el('p', { class: 'proto-sub', text: 'Category multiples are shrinkage-smoothed toward the global live-token median (' + DATA.global_median_multiple.toFixed(4) + 'x across ' + DATA.live_peer_count + ' peers, prior weight ' + m.prior_weight + '). Top calibrated categories:' }),
      el('div', { class: 'peer-grid' }, topCats.map(function (c) {
        return el('span', { class: 'peer-chip' }, c.category + ' (' + c.peers + '): ', el('b', { text: c.smoothed_multiple.toFixed(2) + 'x' }));
      }))
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); render(); });

  function parseStep(s) {
    var cIdx = s.indexOf(' Cost: ');
    var tIdx = s.indexOf(' Time: ');
    var action = cIdx >= 0 ? s.slice(0, cIdx) : s;
    var cost = cIdx >= 0 && tIdx > cIdx ? s.slice(cIdx + 7, tIdx).replace(/\.$/, '') : '';
    var time = tIdx >= 0 ? s.slice(tIdx + 7).replace(/\.$/, '') : '';
    return { action: action, cost: cost, time: time };
  }

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';

    var verified = recomputeImplied(row, DATA.model);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('div', { class: 'proto-cell' },
          el('span', { class: 'pill', text: 'Rank #' + row.rank + ' of ' + DATA.board_size }),
          el('span', { class: 'pill ' + (row.in_watchlist ? 'watch' : 'early'), text: row.in_watchlist ? 'Watchlist' : 'Early Radar' })
        ),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'proto-sub', text: (row.category || 'Other') + ' · slug: ' + row.slug })
      ),
      el('button', { type: 'button', class: 'close-btn', text: 'Close', onclick: function () { dialog.close(); } })
    ));

    if (row.chains && row.chains.length) {
      dialog.appendChild(el('div', { class: 'chain-row' }, row.chains.map(function (c) {
        return el('span', { class: 'pill', text: c });
      })));
    }

    dialog.appendChild(el('section', { class: 'detail-sec' },
      el('h3', { text: 'Valuation Breakdown' }),
      el('div', { class: 'eq-grid' },
        el('div', { class: 'eq-row' }, el('span', { text: 'Total Value Locked (TVL)' }), el('b', { text: fmtUsd(row.tvl_usd) })),
        el('div', { class: 'eq-row' }, el('span', { text: 'Category Peer Multiple' }), el('b', { text: row.category_multiple.toFixed(4) + 'x' })),
        el('div', { class: 'eq-row' }, el('span', { text: '7d Growth (' + fmtPct(row.change_7d) + ')' }), el('b', { text: row.growth_multiplier.toFixed(4) + 'x' })),
        el('div', { class: 'eq-row' }, el('span', { text: 'Maturity (' + fmtAge(row.age_days) + ')' }), el('b', { text: row.maturity_multiplier.toFixed(4) + 'x' })),
        el('div', { class: 'eq-row' }, el('span', { text: 'Chain Breadth (' + (row.chains ? row.chains.length : 1) + ' chains)' }), el('b', { text: row.breadth_multiplier.toFixed(4) + 'x' })),
        el('div', { class: 'eq-row total' }, el('span', { text: 'Implied Token Value' }), el('b', { text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'proto-sub', style: 'margin-top:8px', text: 'Client verification: ' + fmtUsd(verified) + (verified === row.implied_value_usd ? ' (matches board.json)' : ' (mismatch)') })
    ));

    dialog.appendChild(el('section', { class: 'detail-sec' },
      el('h3', { text: 'Concrete Farm Plan (' + row.farm_steps.length + ' steps)' }),
      el('ol', { class: 'steps-list' }, row.farm_steps.map(function (raw) {
        var parsed = parseStep(raw);
        return el('li', null,
          el('span', { class: 'step-action', text: parsed.action }),
          el('div', { class: 'step-meta' },
            parsed.cost ? el('span', { class: 'step-cost', text: 'Cost: ' + parsed.cost }) : null,
            parsed.time ? el('span', { class: 'step-time', text: 'Time: ' + parsed.time }) : null
          )
        );
      }))
    ));

    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(renderHeader());
    shell.appendChild(renderHero());
    shell.appendChild(renderControls());
    shell.appendChild(state.tab === 'pre-token' ? renderPreTokenTable() : renderLiveTable());
    if (state.tab === 'pre-token') shell.appendChild(renderModelPanel());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('hashchange', function () {
    readHash();
    if (!state.selected && dialog.open) dialog.close();
    render();
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
