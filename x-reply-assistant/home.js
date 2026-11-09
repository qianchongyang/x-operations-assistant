(() => {
  const { own, permalink } = globalThis.XReplyPost;
  const tweet = 'article[data-testid="tweet"]';
  const hoverCard = '[data-testid="HoverCard"]';
  const setting = 'xra.home.scoring';
  const batchSize = 10;
  const profiles = new Map();
  const attempted = new Set();
  const badges = new Map();
  let enabled = true;
  let toggle;
  let details;
  let closeDetailsTimer;
  let scheduled = 0;
  let pending;
  let pauseUntil = 0;

  try { enabled = sessionStorage.getItem(setting) !== 'off'; } catch { /* tab storage can be unavailable */ }

  function onHome() {
    return /^\/home\/?$/.test(location.pathname);
  }

  function count(text) {
    const match = text?.replace(/[\s\u202f]/g, '').match(/(\d[\d,.]*)([kmb万萬亿億])?/i);
    if (!match) return null;
    const unit = match[2]?.toLowerCase();
    const scale = { k: 1e3, m: 1e6, b: 1e9, 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8 }[unit] || 1;
    const numeric = unit && !match[1].includes('.') ? match[1].replace(',', '.') : match[1].replaceAll(',', '');
    const value = Number(numeric);
    return Number.isFinite(value) ? Math.round(value * scale) : null;
  }

  function nodeCount(node) {
    return count(node?.getAttribute('aria-label')) ?? count(node?.textContent);
  }

  function language(article) {
    const label = own(article, 'span, [data-testid="translationLabel"]').find((node) =>
      !node.closest('[data-testid="tweetText"]') &&
      /^(?:翻译自|翻譯自|translated from)/i.test(node.textContent.trim()));
    if (label) {
      const source = label.textContent.trim().replace(/^(?:翻译自|翻譯自|translated from)\s*/i, '');
      if (source) return /^(?:英语|英文|英語|english\b)/i.test(source) ? 'en' : 'other';
      return 'unknown';
    }
    const code = own(article, '[data-testid="tweetText"][lang]')[0]?.lang.toLowerCase();
    return code ? (/^en(?:-|$)/.test(code) ? 'en' : 'other') : 'unknown';
  }

  function readPost(article) {
    const link = permalink(article);
    const match = link?.pathname.match(/^\/([\w]+)\/status\/(\d+)\/?$/);
    const published = Date.parse(link?.querySelector('time')?.dateTime);
    if (!match || !Number.isFinite(published)) return null;
    const [, name, id] = match;
    const views = own(article, 'a[href$="/analytics"]').find((node) => node.pathname.includes(`/status/${id}/`));
    return {
      article, id, name, author: name.toLowerCase(), published,
      views: nodeCount(views), replies: nodeCount(own(article, '[data-testid="reply"]')[0]),
      language: language(article),
    };
  }

  function batch() {
    const column = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main');
    if (!column) return [];
    const articles = [...column.querySelectorAll(tweet)];
    const start = articles.findIndex((article) => article.getBoundingClientRect().bottom > 56);
    if (start < 0) return [];
    const posts = new Map();
    for (const article of articles.slice(start)) {
      if (article.querySelector('[data-testid="promotedIndicator"], [data-testid="promoted-label"]')) continue;
      const post = readPost(article);
      if (post && !posts.has(post.id)) posts.set(post.id, post);
      if (posts.size > batchSize) break; // The next already-loaded author can be looked up before scrolling.
    }
    return [...posts.values()];
  }

  function collectProfiles(authors) {
    for (const card of document.querySelectorAll(hoverCard)) {
      if (!card.getClientRects().length || card.closest('[hidden], [aria-hidden="true"]')) continue;
      const links = [...card.querySelectorAll('a[href]')];
      const match = links.map((link) => link.pathname.match(/^\/([\w]+)\/(?:verified_followers|followers|following)\/?$/i)).find(Boolean);
      const author = match?.[1].toLowerCase();
      if (!authors.has(author)) continue;
      if (pending?.author === author) card.classList.add('xra-home-auto-hover');
      const stat = (suffix) => links.find((link) => link.pathname.toLowerCase().replace(/\/$/, '') === `/${author}/${suffix}`);
      const previous = profiles.get(author) || {};
      const followers = nodeCount(stat('followers') || stat('verified_followers')) ?? previous.followers;
      const following = nodeCount(stat('following')) ?? previous.following;
      const followsYou = card.querySelector('[data-testid="userFollowIndicator"]') ||
        [...card.querySelectorAll('span')].some((node) => /^(?:Follows you|(?:正在)?[关關]注(?:了)?你|跟隨你)$/i.test(node.textContent.trim()));
      const youFollow = card.querySelector('[data-testid$="-unfollow"]') ? true :
        card.querySelector('[data-testid$="-follow"]') ? false : previous.youFollow;
      profiles.set(author, { followers, following, youFollow, followsYou: Boolean(followsYou) });
      if (pending?.author === author && (followers != null || following != null)) finishProbe();
    }
  }

  function hoverEvents(target, enter) {
    const rect = target.getBoundingClientRect();
    const options = { bubbles: true, composed: true, view: window, relatedTarget: document.body,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    target.dispatchEvent(new PointerEvent(enter ? 'pointerover' : 'pointerout', { ...options, pointerType: 'mouse', isPrimary: true }));
    target.dispatchEvent(new MouseEvent(enter ? 'mouseover' : 'mouseout', options));
    target.dispatchEvent(new MouseEvent(enter ? 'mouseenter' : 'mouseleave', { ...options, bubbles: false }));
  }

  function finishProbe() {
    if (!pending) return;
    const { target, timer } = pending;
    pending = null;
    clearTimeout(timer);
    hoverEvents(target, false);
    schedule();
  }

  function probeNext(posts) {
    if (pending || Date.now() < pauseUntil || document.querySelector(hoverCard)) return;
    for (const { article, author } of posts) {
      if (profiles.get(author)?.followers != null || attempted.has(author)) continue;
      const links = own(article, 'a[href]');
      const isAuthor = (link) => link.pathname.toLowerCase().replace(/\/$/, '') === `/${author}`;
      const target = links.find((link) => isAuthor(link) && link.closest('[data-testid="User-Name"]')) || links.find(isAuthor);
      if (!target) continue;
      attempted.add(author);
      pending = { author, target, timer: setTimeout(finishProbe, 1800) };
      hoverEvents(target, true);
      break;
    }
  }

  function score(posts) {
    const now = Date.now();
    const rows = posts.map((post) => {
      const age = Math.max(0, (now - post.published) / 60000);
      const decay = 0.20 + 0.80 * 2 ** (-age / 80);
      const views = post.views ?? 0;
      const replies = post.replies;
      const pace = 60 * views / Math.max(age, 15) * decay;
      const room = replies == null ? 0 : (views / (views + 500)) / (1 + replies / 20 + 200 * replies / (views + 500));
      const profile = profiles.get(post.author);
      return { post, age, decay, views, pace, room, profile, followers: profile?.followers ?? 1000 };
    });
    const max = (key) => Math.max(0, ...rows.map((row) => row[key]));
    const limits = { pace: max('pace'), views: max('views'), followers: max('followers') };
    const normalize = (row, key, scale) => limits[key] ? Math.log1p(row[key] / scale) / Math.log1p(limits[key] / scale) : 0;
    for (const row of rows) {
      row.parts = [60 * normalize(row, 'pace', 50), 20 * normalize(row, 'followers', 100) * row.decay,
        10 * normalize(row, 'views', 100), 10 * row.room];
      const coefficient = { en: 1, other: 0.5, unknown: 0.85 }[row.post.language];
      row.raw = coefficient * row.parts.reduce((total, value) => total + value, 0);
    }
    return rows.sort((a, b) => b.raw - a.raw || a.age - b.age);
  }

  function button(className, action) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = className;
    node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      action?.();
    });
    return node;
  }

  function hideDetails() {
    clearTimeout(closeDetailsTimer);
    if (!details) return;
    details.entry.node.removeAttribute('aria-describedby');
    details.panel.remove();
    details = null;
  }

  function deferHideDetails() {
    clearTimeout(closeDetailsTimer);
    closeDetailsTimer = setTimeout(() => {
      if (details && !details.entry.node.matches(':hover, :focus-visible') && !details.panel.matches(':hover')) hideDetails();
    }, 150);
  }

  function updateDetails() {
    if (!details) return;
    const { entry, panel, lines } = details;
    const { row, rank } = entry;
    const anchor = entry.node.getBoundingClientRect();
    if (anchor.bottom <= 0 || anchor.top >= window.innerHeight) {
      hideDetails();
      return;
    }
    const format = (value) => value == null ? '未知' : value.toLocaleString();
    const minutes = Math.floor(row.age);
    const age = minutes < 60 ? `${minutes}分钟` : `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
    const followers = row.profile?.followers;
    const followerText = followers > 10_000 ? `${(followers / 10_000).toFixed(2)}万` : format(followers);
    const lang = { en: '英文', other: '非英文', unknown: '未知' }[row.post.language];
    const youFollow = row.profile?.youFollow == null ? '未知' : row.profile.youFollow ? '已关注' : '未关注';
    const text = [
      `${rank} 分 · @${row.post.name}`,
      `本批相对优先级 · 内部得分 ${row.raw.toFixed(2)} / 100`,
      `发帖 ${age} · 原帖语言 ${lang}`,
      `浏览 ${format(row.post.views)} · 回复 ${format(row.post.replies)}`,
      `粉丝 ${followerText}${followers == null ? '（暂按 1,000 计算）' : ''} · 正在关注 ${format(row.profile?.following)}`,
      `你关注作者 ${youFollow} · 作者关注你 ${row.profile?.followsYou ? '已关注' : '未关注'}`,
      `增速 ${row.parts[0].toFixed(1)} · 粉丝 ${row.parts[1].toFixed(1)} · 浏览 ${row.parts[2].toFixed(1)} · 空位 ${row.parts[3].toFixed(1)}`,
      '增速按本次浏览和帖龄估算，分数仅与当前批次比较。',
    ];
    lines.forEach((line, index) => {
      if (line.textContent !== text[index]) line.textContent = text[index];
    });
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const gap = 7;
    const below = anchor.bottom + gap;
    const top = below + height <= window.innerHeight - gap ? below : anchor.top - height - gap;
    panel.style.left = `${Math.max(gap, Math.min(anchor.right - width, window.innerWidth - width - gap))}px`;
    panel.style.top = `${Math.max(gap, top)}px`;
  }

  function showDetails(entry) {
    if (!enabled || !onHome()) return;
    if (details?.entry === entry) {
      clearTimeout(closeDetailsTimer);
      return;
    }
    hideDetails();
    const panel = document.createElement('div');
    panel.id = 'xra-home-score-tooltip';
    panel.className = 'xra-home-details';
    panel.setAttribute('role', 'tooltip');
    const title = document.createElement('strong');
    const summary = document.createElement('p');
    const list = document.createElement('ul');
    const items = Array.from({ length: 5 }, () => document.createElement('li'));
    const note = document.createElement('p');
    list.append(...items);
    panel.append(title, summary, list, note);
    panel.addEventListener('mouseenter', () => clearTimeout(closeDetailsTimer));
    panel.addEventListener('mouseleave', deferHideDetails);
    details = { entry, panel, lines: [title, summary, ...items, note] };
    entry.node.setAttribute('aria-describedby', panel.id);
    document.body.append(panel);
    updateDetails();
  }

  function scoreAnchor(article) {
    const caret = own(article, '[data-testid="caret"]')[0]?.closest('button, [role="button"]');
    if (!caret) return null;
    const grok = own(article, 'button[aria-label*="Grok" i], [role="button"][aria-label*="Grok" i]')[0];
    if (!grok) return caret;
    let anchor = caret;
    while (anchor.parentElement !== article && !anchor.parentElement.contains(grok)) anchor = anchor.parentElement;
    return anchor.parentElement === article ? caret : anchor;
  }

  function render(rows) {
    const current = new Set(rows.map(({ post }) => post.article));
    for (const [article, entry] of badges) {
      if (current.has(article) && entry.node.isConnected) continue;
      if (details?.entry === entry) hideDetails();
      entry.node.remove();
      badges.delete(article);
    }
    rows.forEach((row, index) => {
      const { article } = row.post;
      let entry = badges.get(article);
      const anchor = scoreAnchor(article);
      if (!anchor) {
        if (entry && details?.entry === entry) hideDetails();
        entry?.node.remove();
        badges.delete(article);
        return;
      }
      if (!entry) {
        entry = { node: button('xra-home-score') };
        entry.node.addEventListener('mouseenter', () => showDetails(entry));
        entry.node.addEventListener('mouseleave', deferHideDetails);
        entry.node.addEventListener('focus', () => {
          if (entry.node.matches(':focus-visible')) showDetails(entry);
        });
        entry.node.addEventListener('blur', deferHideDetails);
        badges.set(article, entry);
      }
      if (entry.node.nextElementSibling !== anchor) anchor.before(entry.node);
      entry.row = row;
      entry.rank = batchSize - index;
      const label = String(entry.rank);
      if (entry.node.textContent !== label) {
        entry.node.textContent = label;
        entry.node.setAttribute('aria-label', `${entry.rank} 分，查看首页评分依据`);
      }
    });
    updateDetails();
  }

  function refresh() {
    const home = onHome();
    if (!home) {
      toggle?.remove();
      toggle = null;
    } else if (!toggle?.isConnected) {
      toggle = button('xra-home-toggle', () => {
        enabled = !enabled;
        try { sessionStorage.setItem(setting, enabled ? 'on' : 'off'); } catch { /* keep the in-memory setting */ }
        refresh();
      });
      toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V13m7 6V8m7 11V4"/></svg>';
      document.body.append(toggle);
    }
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(enabled));
      toggle.setAttribute('aria-label', '首页评分');
      toggle.title = enabled ? '关闭首页评分' : '开启首页评分';
    }
    if (!home || !enabled) {
      finishProbe();
      render([]);
      hideDetails();
      return;
    }
    const posts = batch();
    collectProfiles(new Set(posts.map(({ author }) => author)));
    render(score(posts.slice(0, batchSize)));
    probeNext(posts);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      refresh();
    });
  }

  document.addEventListener('pointerover', (event) => {
    if (!event.isTrusted || !onHome() || !enabled || !event.target.closest?.('a[href]')) return;
    pauseUntil = Date.now() + 800;
    finishProbe();
    for (const card of document.querySelectorAll('.xra-home-auto-hover')) card.classList.remove('xra-home-auto-hover');
    setTimeout(schedule, 850);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideDetails();
  });
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  window.navigation?.addEventListener('currententrychange', schedule);
  new MutationObserver((records) => {
    if ((onHome() || toggle) && records.some(({ target }) =>
      !(target.nodeType === 1 ? target : target.parentElement)?.closest('.xra-home-toggle, .xra-home-score, .xra-home-details'))) schedule();
  }).observe(document.body, { childList: true, characterData: true, subtree: true });
  refresh();
})();
