(() => {
  const tweet = 'article[data-testid="tweet"]';
  const tweetText = '[data-testid="tweetText"]';
  const quote = '[data-testid="quoteTweet"], [data-testid="card.wrapper"], div[role="link"]';
  const route = /^\/[A-Za-z0-9_]+\/status\/(\d+)\/?$/;
  const conversationCell = '[data-testid="cellInnerDiv"]';
  const edited = /last edited|最后编辑|最後編輯|上次编辑|上次編輯|编辑于|編輯於|最終編集|última edición|dernière modification/i;
  const translated = /translated from|show original|翻译自|翻譯自|显示原文|顯示原文|查看原文|原文を表示|traducción del|ver original|voir l.original/i;
  const discover = /^(discover more|more posts|sourced from across x|探索更多|发现更多|發現更多|おすすめのポスト|descubre más|découvrir plus)$/i;

  function idFromUrl(value) {
    try {
      const url = new URL(value, 'https://x.com');
      return url.origin === 'https://x.com' ? url.pathname.match(route)?.[1] || '' : '';
    } catch {
      return '';
    }
  }

  function own(article, selector) {
    return [...article.querySelectorAll(selector)].filter((node) => {
      if (node.closest(tweet) !== article) return false;
      const container = node.closest(quote);
      return !container || container === article || !article.contains(container);
    });
  }

  function permalink(article) {
    return own(article, 'a[href]').find((anchor) => idFromUrl(anchor.href) && anchor.querySelector('time'));
  }

  function articleId(article) {
    const link = permalink(article);
    if (link) return idFromUrl(link.href);
    const fallback = own(article, '[data-testid="User-Name"] a[href], a[data-testid="tweetTimestamp"][href]');
    return fallback.map((anchor) => idFromUrl(anchor.href)).find(Boolean) || '';
  }

  function locate(id) {
    if (!id) return null;
    const column = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main');
    if (!column) return null;
    const articles = [...column.querySelectorAll(tweet)].filter((article) =>
      !article.parentElement.closest(tweet) && !article.closest('[hidden], [aria-hidden="true"]'));
    const main = articles.find((article) => articleId(article) === id);
    return main ? { main, articles, column } : null;
  }

  function postText(article) {
    const texts = own(article, tweetText);
    const label = own(article, 'button, [role="button"], span').find((node) =>
      node.childElementCount === 0 && !node.closest(tweetText) && translated.test(node.textContent.trim()));
    const translationBlock = own(article, '[data-testid="translatedText"], [data-testid="translationLabel"]')[0];
    const marker = label || translationBlock;
    const first = texts[0];
    // Some X layouts keep the original above the translation control.
    const originalAbove = first && marker && Boolean(first.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      (texts.length > 1 || translationBlock?.textContent.trim());
    const textNode = first || (translationBlock?.matches('[data-testid="translatedText"]') ? translationBlock : null);
    return {
      text: (textNode?.innerText ?? textNode?.textContent ?? '').trim(),
      language: textNode?.getAttribute('lang') || '',
      translated: Boolean(marker && !originalAbove),
    };
  }

  function publishedAt(article) {
    const link = permalink(article);
    const time = link?.querySelector('time');
    if (!time || own(article, '[data-testid="editHistoryButton"], a[href*="/history"]').length) return null;
    const aroundTime = [time.textContent, link.getAttribute('aria-label'), link.title,
      link.parentElement?.textContent?.slice(0, 150)].filter(Boolean).join(' ');
    return edited.test(aroundTime) ? null : time.getAttribute('datetime');
  }

  function isTruncated(article) {
    return own(article, '[data-testid="tweet-text-show-more-link"], [data-testid="tweetTextShowMoreLink"]').length > 0;
  }

  function readReplies(found, id) {
    const mainCell = found.main.closest(conversationCell);
    const timeline = found.main.closest('[aria-label^="Timeline:"], [data-testid="conversationTimeline"]');
    const boundary = [...found.column.querySelectorAll('h2, [role="heading"], [data-testid="recommendations"]')].find((heading) =>
      (found.main.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      (heading.matches('[data-testid="recommendations"]') || discover.test(heading.textContent.trim())));
    const seen = new Set([id]);
    const seenCells = new Set(mainCell ? [mainCell] : []);
    const replies = [];
    for (const article of found.articles.slice(found.articles.indexOf(found.main) + 1)) {
      if (boundary && (boundary.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
      if (timeline && !timeline.contains(article)) break;
      if (article.closest('[data-testid="promotedTweet"]') ||
          own(article, '[data-testid="promotedIndicator"], [data-testid="promoted-label"]').length) continue;
      const cell = article.closest(conversationCell);
      if (cell && seenCells.has(cell)) continue;
      const parent = article.getAttribute('data-in-reply-to-status-id') || cell?.getAttribute('data-in-reply-to-status-id');
      if (parent && parent !== id) continue;
      const replyId = articleId(article);
      if (!replyId || seen.has(replyId)) continue;
      const { text } = postText(article);
      if (!text) continue;
      seen.add(replyId);
      if (cell) seenCells.add(cell);
      replies.push({ text, publishedAt: publishedAt(article), truncated: isTruncated(article) });
      if (replies.length === 8) break;
    }
    return replies;
  }

  function read(id) {
    const found = locate(id);
    if (!found) throw new Error('无法确认当前主帖。请等待帖子加载后再试。');
    if (isTruncated(found.main)) throw new Error('原帖还未展开。请在 X 点击「显示更多」，再分析。');
    const main = postText(found.main);
    const hasMedia = own(found.main, '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="videoComponent"], a[href*="/photo/"], a[href*="/video/"]').length > 0;
    if (!main.text) throw new Error(hasMedia
      ? '只找到图片或视频，扩展无法读取画面内容。可以关闭并跳过。'
      : '没有读到主帖正文，请等待加载或关闭并跳过。');
    return { id, ...main, hasMedia, publishedAt: publishedAt(found.main), replies: readReplies(found, id) };
  }

  globalThis.XReplyPost = { idFromUrl, locate, own, permalink, read };
})();
