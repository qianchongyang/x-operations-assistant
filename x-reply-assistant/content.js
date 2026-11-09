(() => {
  const { idFromUrl, locate, read } = globalThis.XReplyPost;
  const { automatic, directions, tones, lengths, defaults } = globalThis.XReplyOptions;
  let postId = '';
  let button = null;
  let toolbar = null;
  let dialog = null;
  let active = null;
  let refreshTimer;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function control(label, action, className = 'xra-small-button') {
    const node = element('button', className, label);
    node.type = 'button';
    node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    return node;
  }

  function resetPage() {
    active = null;
    dialog?.close();
    dialog?.remove();
    dialog = null;
    toolbar?.remove();
    toolbar = null;
    button?.remove();
    button = null;
  }

  function refresh() {
    const id = idFromUrl(location.href);
    if (id !== postId) {
      resetPage();
      postId = id;
    }
    if (!id || button?.isConnected) return;
    const found = locate(id);
    if (!found) return;
    button = control('分析并起草', start, 'xra-entry');
    button.disabled = Boolean(active);
    const caret = [...found.main.querySelectorAll('[data-testid="caret"]')].find((node) =>
      !node.closest('div[role="link"], [data-testid="quoteTweet"]') && node.closest('article') === found.main);
    const menu = caret?.closest('button, [role="button"]');
    if (menu) {
      menu.before(button);
    } else {
      toolbar = element('div', 'xra-toolbar');
      toolbar.append(button);
      found.main.prepend(toolbar);
    }
  }

  function showDialog() {
    if (!dialog) {
      dialog = element('dialog', 'xra-dialog');
      dialog.setAttribute('aria-label', 'X 运营助手');
      dialog.addEventListener('close', () => {
        if (dialog?.open) return;
        active = null;
        if (button) button.disabled = false;
      });
      document.body.append(dialog);
    }
    if (!dialog.open) dialog.showModal();
    return dialog;
  }

  function layout(title) {
    const panel = showDialog();
    const header = element('header', 'xra-header');
    const name = element('div');
    name.append(element('p', 'xra-kicker', 'X 运营助手'), element('h2', '', title));
    const close = control('关闭', () => panel.close());
    header.append(name, close);
    const body = element('div', 'xra-body');
    panel.replaceChildren(header, body);
    return body;
  }

  function metaText(post, minutes) {
    const age = minutes == null ? '发布时间未知' : minutes < 1 ? '刚刚发布'
      : minutes < 60 ? '已发 ' + minutes + ' 分钟'
      : '已发 ' + Math.floor(minutes / 60) + ' 小时' + (minutes % 60 ? ' ' + minutes % 60 + ' 分钟' : '');
    const sample = post.replies.length ? '已分析 ' + post.replies.length + ' 条已加载回复' : '仅分析原帖';
    return age + ' · ' + sample + ' · 本次仅分析文字';
  }

  function section(body, title, text) {
    const block = element('section', 'xra-section');
    block.append(element('h3', '', title), element('p', 'xra-prose', text));
    body.append(block);
    return block;
  }

  async function copyEnglish(english, feedback) {
    try {
      await navigator.clipboard.writeText(english);
      feedback.textContent = '已复制英文';
    } catch {
      feedback.textContent = '复制失败，可选中英文后手动复制。';
    }
  }

  function choiceField(label, entries, initial) {
    const field = element('label', 'xra-field');
    const select = element('select');
    for (const [value, title] of entries) {
      const option = element('option', '', title);
      option.value = value;
      select.append(option);
    }
    select.value = initial;
    field.append(element('span', '', label), select);
    return { field, select };
  }

  function contextGaps(post) {
    return [
      post.translated && '只读到了 X 平台译文',
      !post.replies.length && '没有读到已加载的回复',
      post.hasMedia && '图像或视频内容未知',
    ].filter(Boolean);
  }

  function isCurrent(body, post) {
    return body.isConnected && dialog?.open && post.id === idFromUrl(location.href);
  }

  function openSettings() {
    return chrome.runtime.sendMessage({ type: 'openSettings' });
  }

  function heartControl(label, action) {
    const node = control('', action, 'xra-heart');
    node.setAttribute('aria-label', label);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 20.6 3.9 12.5a4.8 4.8 0 0 1 6.8-6.8L12 7l1.3-1.3a4.8 4.8 0 0 1 6.8 6.8Z');
    svg.append(path);
    node.append(svg);
    return node;
  }

  function translationPanel(post) {
    const panel = element('section', 'xra-manual');
    const input = element('textarea');
    input.setAttribute('aria-label', '要转换的中文回复');
    input.placeholder = '输入你想回复的中文';
    input.rows = 3;
    input.maxLength = 2000;
    const output = element('div', 'xra-translation');
    output.hidden = true;
    const feedback = element('p', 'xra-feedback');
    feedback.setAttribute('role', 'status');
    const english = control('', () => copyEnglish(english.textContent, feedback), 'xra-english');
    english.title = '点击复制英文';
    output.append(element('span', 'xra-label', '英文译文 · 点击复制'), english);
    input.addEventListener('input', () => {
      output.hidden = true;
      feedback.textContent = '';
    });

    const convert = control('转换', async () => {
      const text = input.value.trim();
      if (!text) {
        feedback.textContent = '请先输入要转换的中文。';
        return;
      }
      input.disabled = convert.disabled = true;
      feedback.textContent = '正在转换成英文…';
      try {
        const response = await chrome.runtime.sendMessage({ type: 'translateReply', postId: post.id, text });
        if (!isCurrent(panel, post)) return;
        if (!response?.ok) throw new Error(response?.error);
        english.textContent = response.result.english;
        output.hidden = false;
        feedback.textContent = '';
      } catch (error) {
        if (isCurrent(panel, post)) feedback.textContent = error.message || '转换失败，请重试。';
      } finally {
        input.disabled = convert.disabled = false;
      }
    });

    panel.append(element('h3', '', '中文回复转英文'), input, convert, output, feedback);
    return panel;
  }

  function appendFooter(body, translator) {
    const footer = element('footer', 'xra-footer');
    footer.append(control('关闭', () => dialog.close()));
    body.append(translator, footer);
  }

  function resultView(post, result) {
    const body = layout(result.recommendation === 'reply' ? '回复建议' : '建议跳过');
    dialog.scrollTop = 0;
    body.append(element('p', 'xra-meta', metaText(post, result.minutes)));
    section(body, post.translated ? '原帖中文（依据 X 平台译文）' : '原帖中文', result.originalZh);
    const gaps = contextGaps(post);
    if (gaps.length) section(body, '本次上下文', gaps.join('。') + '。');
    section(body, '原帖与评论', result.summary);
    if (result.skipReason) section(body, '跳过原因', result.skipReason);

    const feedback = element('p', 'xra-feedback');
    feedback.setAttribute('role', 'status');
    const automaticChoices = [];
    let manualChoices = [];
    let selectedEnglish = result.selectedEnglish;
    let regenerating = false;
    let rewriting = false;
    let saving = false;

    const manual = element('section', 'xra-manual');
    manual.append(element('h3', '', '手动调整'));
    const direction = choiceField('接法', [automatic, ...directions].map((item) => [item, item]), defaults.direction);
    const tone = choiceField('语气', tones.map((item) => [item, item]), defaults.tone);
    const length = choiceField('长度', Object.entries(lengths).map(([key, value]) =>
      [key, value.label + '（≤' + value.limit + ' 字符）']), defaults.length);
    const status = element('p', 'xra-feedback');
    status.setAttribute('role', 'status');
    const manualResults = element('div', 'xra-manual-result');
    const regenerate = control('按选择重新生成', async () => {
      if (isBusy() || !isCurrent(body, post)) return;
      regenerating = true;
      updateControls();
      status.textContent = '正在按所选条件生成…';
      const preferences = { direction: direction.select.value, tone: tone.select.value, length: length.select.value };
      try {
        const generated = await requestAnalysis(post, preferences);
        if (!isCurrent(body, post)) return;
        if (generated.skipReason) {
          status.textContent = generated.skipReason;
          return;
        }
        manualResults.replaceChildren();
        manualChoices = [];
        generated.candidates.forEach((candidate, index) => {
          const choice = draftChoice(candidate, '手动候选 ' + (index + 1), preferences, manualChoices);
          manualChoices.push(choice);
          manualResults.append(choice.card);
        });
        updateChoice();
        status.textContent = '';
      } catch (error) {
        if (isCurrent(body, post)) status.textContent = error.message || '重新生成失败，请重试。';
      } finally {
        regenerating = false;
        updateControls();
      }
    });
    const fields = element('div', 'xra-actions');
    fields.append(direction.field, tone.field, length.field, regenerate);
    manual.append(fields, status, manualResults);

    const clearPrevious = heartControl('撤销本帖上次的风格标记', () => saveChoice(null));
    clearPrevious.setAttribute('aria-pressed', 'true');

    function isBusy() {
      return saving || rewriting || regenerating;
    }

    function visibleChoices() {
      return [...automaticChoices, ...manualChoices];
    }

    function updateChoice() {
      const visible = visibleChoices();
      for (const { node, candidate } of visible) {
        node.setAttribute('aria-pressed', String(candidate.en === selectedEnglish));
      }
      clearPrevious.hidden = !selectedEnglish || visible.some(({ candidate }) => candidate.en === selectedEnglish);
    }

    function updateControls() {
      const busy = isBusy();
      for (const { node, rewriteSelect } of visibleChoices()) node.disabled = rewriteSelect.disabled = busy;
      clearPrevious.disabled = direction.select.disabled = tone.select.disabled = length.select.disabled = regenerate.disabled = busy;
    }

    async function saveChoice(candidate) {
      if (isBusy() || !isCurrent(body, post)) return;
      saving = true;
      updateControls();
      const selection = candidate && (candidate.direction === '自写' || candidate.en !== selectedEnglish) ? candidate : null;
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'styleFeedback', postId: post.id, postKind: result.postKind, previous: selectedEnglish,
          candidate: selection && { en: selection.en, direction: selection.direction },
          context: selection && { text: post.text.slice(0, 500), translated: post.translated },
        });
        if (!isCurrent(body, post)) return;
        if (!response?.ok) throw new Error(response?.error);
        selectedEnglish = selection?.en ?? null;
        updateChoice();
        feedback.textContent = selection?.direction === '自写' ? '已保存你的回复。' : '';
      } catch (error) {
        if (isCurrent(body, post)) feedback.textContent = error.message || '风格标记保存失败，请重试。';
      } finally {
        saving = false;
        updateControls();
      }
    }

    function draftChoice(candidate, title, preferences, group) {
      const card = element('section', 'xra-candidate');
      const head = element('div', 'xra-candidate-head');
      const rewrites = ['更短', '更长', '更口语', ...tones].map((item) => [item, item]);
      const mode = choiceField(title + '的改写方式', [['', '改写'], ...rewrites], '');
      mode.field.className += ' xra-rewrite';
      mode.select.setAttribute('aria-label', title + '的改写方式');
      const node = heartControl('这句像我', () => saveChoice(choice.candidate));
      const choice = { candidate, card, node, rewriteSelect: mode.select };
      head.append(element('h3', '', title + ' · ' + candidate.direction), mode.field, node);

      const copied = element('p', 'xra-feedback');
      copied.setAttribute('role', 'status');
      const english = control('', () => copyEnglish(choice.candidate.en, copied), 'xra-english');
      english.title = '点击复制英文';
      const pair = element('div', 'xra-pair');
      const enColumn = element('div');
      enColumn.append(element('span', 'xra-label', '英文 · 点击复制'), english);
      const zhColumn = element('div');
      const chinese = element('p', 'xra-chinese');
      zhColumn.append(element('span', 'xra-label', '中文对照'), chinese);
      pair.append(enColumn, zhColumn);
      const meta = element('p', 'xra-candidate-meta');
      const status = element('p', 'xra-feedback');
      status.setAttribute('role', 'status');
      card.append(head, pair, meta, copied, status);

      function render() {
        const { en, zh, risk, risk_reason_zh, style_score } = choice.candidate;
        english.textContent = en;
        chinese.textContent = zh;
        meta.textContent = '像我 ' + style_score + '/5 · ' + (risk === 'medium' ? '中风险 · ' + risk_reason_zh : '低风险');
      }
      render();

      mode.select.addEventListener('change', async () => {
        const change = mode.select.value;
        mode.select.value = '';
        if (!change || isBusy() || !isCurrent(body, post)) return;
        rewriting = true;
        updateControls();
        status.textContent = '正在改写这条候选…';
        try {
          const response = await chrome.runtime.sendMessage({
            type: 'rewrite', post, preferences, change, draft: choice.candidate,
            others: group.filter((item) => item !== choice).map((item) => item.candidate.en),
          });
          if (!isCurrent(body, post)) return;
          if (!response?.ok) throw new Error(response?.error);
          if (response.result.skipReason) {
            status.textContent = response.result.skipReason;
            return;
          }
          choice.candidate = response.result.candidate;
          render();
          updateChoice();
          copied.textContent = '';
          status.textContent = '已改写。';
        } catch (error) {
          if (isCurrent(body, post)) status.textContent = error.message || '改写失败，请重试。';
        } finally {
          rewriting = false;
          updateControls();
        }
      });
      return choice;
    }

    if (result.candidates.length) {
      body.append(element('p', 'xra-meta', (result.usedStyleExamples ? '本次已参考你标记的写法。' : '') +
        '点爱心保存英文和原帖片段。之后起草或改写时，近期样本会发送给所选模型服务商。'));
    }
    result.candidates.forEach((candidate, index) => {
      const title = index === 0 ? '推荐回复' : '候选 ' + (index + 1);
      const choice = draftChoice(candidate, title, defaults, automaticChoices);
      automaticChoices.push(choice);
      body.append(choice.card);
    });
    if (result.note) section(body, '备注', result.note);
    updateChoice();
    body.append(clearPrevious, feedback);
    if (automaticChoices.length) {
      const own = element('details', 'xra-own-sample');
      const input = element('textarea');
      input.setAttribute('aria-label', '我的英文回复');
      input.placeholder = '粘贴你最终使用的英文';
      input.rows = 2;
      input.maxLength = 280;
      const save = control('保存为风格样本', () => {
        if (!input.value.trim()) {
          feedback.textContent = '请先填写自己的英文回复。';
          return;
        }
        saveChoice({ en: input.value.trim(), direction: '自写' });
      });
      own.append(element('summary', '', '保存我自己的回复'), input, save);
      body.append(own);
    }
    body.append(manual);
    appendFooter(body, translationPanel(post));
  }

  function errorView(message, code, post) {
    const body = layout(code === 'setup' ? '先配置扩展' : '暂时无法分析');
    const note = element('p', 'xra-prose', message);
    note.setAttribute('role', 'alert');
    body.append(note);
    if (code === 'setup') {
      body.append(control('打开设置', () => {
        openSettings().catch(() => {
          note.textContent = '请通过 Chrome 工具栏中的扩展图标打开设置。';
        });
      }));
    }
    if (post) appendFooter(body, translationPanel(post));
  }

  async function requestAnalysis(post, preferences) {
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'analyze', post, preferences });
    } catch {
      throw new Error('扩展连接中断，请刷新 X 页面后重试。');
    }
    if (!response?.ok) {
      throw Object.assign(new Error(response?.error || '扩展未能返回结果，请重试。'), { code: response?.code });
    }
    return response.result;
  }

  async function start() {
    const id = idFromUrl(location.href);
    if (!id || id !== postId || active) return;
    let post;
    try {
      post = read(id);
    } catch (error) {
      errorView(error.message);
      return;
    }

    const request = {};
    active = request;
    button.disabled = true;
    const body = layout('正在起草');
    dialog.scrollTop = 0;
    const loading = element('p', 'xra-meta', '正在根据本次读到的原帖和回复生成候选。');
    loading.setAttribute('role', 'status');
    body.append(loading);
    try {
      const result = await requestAnalysis(post, defaults);
      if (active === request && isCurrent(body, post)) resultView(post, result);
    } catch (error) {
      if (active === request && isCurrent(body, post)) errorView(error.message, error.code, post);
    } finally {
      if (active === request) {
        active = null;
        if (button) button.disabled = false;
      }
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, 50);
  }

  window.navigation?.addEventListener('currententrychange', scheduleRefresh);
  new MutationObserver(scheduleRefresh).observe(document.body, { childList: true, subtree: true });
  refresh();
})();
