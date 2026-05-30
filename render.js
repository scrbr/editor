(function () {
'use strict';

  const editor = document.getElementById('editor');
  if (!editor) return;

  // ── State ──────────────────────────────────────────────────────
  let busy        = false;
  let rawMode     = false;   // true = show all raw markdown, no rendering
  let activeLine  = -1;      // index of the line div the cursor is on

  // ── Init ───────────────────────────────────────────────────────
  editor.innerHTML = '<div><br></div>';

  // ── MD toggle button ───────────────────────────────────────────
  const btnMd = document.getElementById('btn-md-toggle');
  if (btnMd) {
    btnMd.addEventListener('click', () => {
      rawMode = !rawMode;
      editor.classList.toggle('md-raw-mode', rawMode);
      btnMd.classList.toggle('active', rawMode);
      // Re-render to apply/remove active-line treatment
      rerender();
    });
  }

  // ── Placeholder ────────────────────────────────────────────────
  function syncPlaceholder() {
    const txt = (editor.innerText || '').replace(/\n/g, '').trim();
    editor.classList.toggle('is-empty', txt === '');
  }
  syncPlaceholder();

  // ── DOM → markdown source ──────────────────────────────────────

  function lineDivToSource(div) {
    if (div.nodeType === 3) return div.textContent;
    const cl = div.classList;

    // In raw mode, read the full text content (including raw-syntax spans)
    // so that editing / deleting the prefix chars works correctly
    if (rawMode) {
      return rawTextContent(div);
    }

    const inner = nodesToSource(div.childNodes);
    // Only prepend block prefix if the raw-syntax span is actually present —
    // prevents inherited classes on Enter-created divs from adding phantom prefixes
    const hasPfxSpan = pfx => {
      for (const n of div.childNodes)
        if (n.classList && n.classList.contains('md-raw-syntax') && n.textContent === pfx) return true;
      return false;
    };
    if (cl && cl.contains('md-callout')  && hasPfxSpan('> '))   return '> ' + inner;
    if (cl && cl.contains('md-h1')       && hasPfxSpan('# '))   return '# ' + inner;
    if (cl && cl.contains('md-h2')       && hasPfxSpan('## '))  return '## ' + inner;
    if (cl && cl.contains('md-h3')       && hasPfxSpan('### ')) return '### ' + inner;
    if (cl && cl.contains('md-ul-item')  && hasPfxSpan('- '))   return '- ' + inner;
    if (cl && cl.contains('md-ol-item')) {
      const numSpan = div.querySelector('.md-ol-num');
      if (numSpan) return numSpan.textContent + inner;
    }
    return inner;
  }

  // Read full text of a node including raw-syntax spans (for raw mode)
  function rawTextContent(node) {
    let s = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) s += n.textContent;
      else if (n.nodeName === 'BR') { /* skip */ }
      else s += rawTextContent(n);
    }
    return s;
  }

  function nodesToSource(nodes) {
    let s = '';
    for (const n of nodes) {
      if      (n.nodeType === 3)                    s += n.textContent;
      else if (n.nodeName === 'BR')                 { /* skip */ }
      else if (n.classList && n.classList.contains('md-raw-syntax')) { /* skip — syntax chars stored here */ }
      else if (n.nodeName === 'MARK')               s += '==' + nodesToSource(n.childNodes) + '==';
      else if (n.classList && n.classList.contains('md-bold'))   s += '**' + nodesToSource(n.childNodes) + '**';
      else if (n.classList && n.classList.contains('md-italic')) s += '_' + nodesToSource(n.childNodes) + '_';
      else if (n.classList && n.classList.contains('md-strike')) s += '~~' + nodesToSource(n.childNodes) + '~~';
      else                                          s += nodesToSource(n.childNodes);
    }
    return s;
  }

  function domToMarkdown() {
    const parts = [];
    for (const child of editor.childNodes) parts.push(lineDivToSource(child));
    return parts.join('\n');
  }

  // ── Source line parsing ─────────────────────────────────────────

  // Returns { type, prefix, content }
  // type: 'h1'|'h2'|'h3'|'callout'|'ul'|'ol'|'plain'
  function parseLine(src) {
    if (/^### /.test(src))      return { type: 'h3',      prefix: '### ',  content: src.slice(4)  };
    if (/^## /.test(src))       return { type: 'h2',      prefix: '## ',   content: src.slice(3)  };
    if (/^# /.test(src))        return { type: 'h1',      prefix: '# ',    content: src.slice(2)  };
    if (/^> /.test(src))        return { type: 'callout', prefix: '> ',    content: src.slice(2)  };
    if (/^- /.test(src))        return { type: 'ul',      prefix: '- ',    content: src.slice(2)  };
    return                             { type: 'plain',   prefix: '',      content: src };
  }

  // ── Inline rendering ────────────────────────────────────────────

  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Render inline markdown to HTML spans (with raw-syntax nodes embedded)
  // active=true → wrap syntax chars in .md-raw-syntax spans (visible when active)
  function renderInlineHTML(text, active) {
    // Tokenise: **bold**, _italic_, ~~strike~~, ==highlight==
    const tokens = tokeniseInline(text);
    let html = '';
    for (const tok of tokens) {
      if (tok.type === 'text') {
        html += esc(tok.val);
      } else {
        const { open, close, cls, tag } = tok;
        const inner = esc(tok.val);
        const rawOpen  = `<span class="md-raw-syntax">${esc(open)}</span>`;
        const rawClose = `<span class="md-raw-syntax">${esc(close)}</span>`;
        if (tag === 'mark') {
          html += `<mark>${rawOpen}${inner}${rawClose}</mark>`;
        } else {
          html += `<span class="${cls}">${rawOpen}${inner}${rawClose}</span>`;
        }
      }
    }
    return html || '<br>';
  }

  function tokeniseInline(text) {
    // Single-pass regex tokeniser for **bold**, _italic_, ~~strike~~, ==highlight==
    const re = /(\*\*)((?:[^*]|\*(?!\*))+?)(\*\*)|(_)((?:[^_])+?)(_)|(~~)((?:[^~]|~(?!~))+?)(~~)|(==)((?:[^=]|=(?!=))+?)(==)/g;
    const tokens = [];
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) tokens.push({ type: 'text', val: text.slice(last, m.index) });
      if (m[1])      tokens.push({ type: 'fmt', open: '**', close: '**', cls: 'md-bold',   tag: 'span', val: m[2] });
      else if (m[4]) tokens.push({ type: 'fmt', open: '_',  close: '_',  cls: 'md-italic', tag: 'span', val: m[5] });
      else if (m[7]) tokens.push({ type: 'fmt', open: '~~', close: '~~', cls: 'md-strike', tag: 'span', val: m[8] });
      else if (m[10])tokens.push({ type: 'fmt', open: '==', close: '==', cls: 'md-mark',   tag: 'mark', val: m[11] });
      last = m.index + m[0].length;
    }
    if (last < text.length) tokens.push({ type: 'text', val: text.slice(last) });
    return tokens;
  }

  // ── Full line rendering ─────────────────────────────────────────

  // Render a source line to a DOM div (does not attach to editor)
  // isActive: cursor is on this line → show raw syntax, un-style block prefix
  function renderLineDiv(src, isActive) {
    const { type, prefix, content, num } = parseLine(src);
    const innerHTML = renderInlineHTML(content, isActive);
    const div = document.createElement('div');

    // Set type class first, then optionally active-line
    if (type === 'h1')      div.classList.add('md-h1');
    else if (type === 'h2') div.classList.add('md-h2');
    else if (type === 'h3') div.classList.add('md-h3');
    else if (type === 'callout') div.classList.add('md-callout');
    else if (type === 'ul') div.classList.add('md-ul-item');

    if (isActive) div.classList.add('md-active-line');

    // Prefix raw syntax span (for block markers)
    const prefixSpan = prefix
      ? `<span class="md-raw-syntax">${esc(prefix)}</span>`
      : '';

    if (type !== 'plain') {
      div.innerHTML = prefixSpan + (innerHTML === '<br>' ? '' : innerHTML);
    } else {
      div.innerHTML = innerHTML;
    }

    // For block-type lines, ensure there's always a text node after the prefix span
    // so the cursor has a valid non-raw-syntax target
    if (type !== 'plain') {
      const childNodes = Array.from(div.childNodes);
      const lastChild = childNodes[childNodes.length - 1];
      if (!lastChild || lastChild.nodeType !== 3) {
        div.appendChild(document.createTextNode(''));
      }
    }

    return div;
  }

  function renderSource(src) {
    const lines = src ? src.split('\n') : [''];
    const frag = document.createDocumentFragment();
    lines.forEach((line, i) => {
      frag.appendChild(renderLineDiv(line, !rawMode && i === activeLine));
    });
    return frag;
  }

  // ── Cursor save / restore ───────────────────────────────────────

  function nodeToLinePos(container, containerOff) {
    let lineDiv = container.nodeType === 1 ? container : container.parentNode;
    while (lineDiv && lineDiv.parentNode !== editor) lineDiv = lineDiv.parentNode;
    if (!lineDiv || lineDiv === editor) return { li: 0, off: 0 };

    const li = Array.from(editor.children).indexOf(lineDiv);
    let off  = 0, done = false;

    function countFull(n) {
      if (n.nodeType === 3) { off += n.textContent.length; return; }
      if (n.nodeName === 'BR') return;
      // skip .md-raw-syntax nodes — they don't contribute to visible offset
      if (n.classList && n.classList.contains('md-raw-syntax')) return;
      for (const c of n.childNodes) countFull(c);
    }

    function walk(n) {
      if (done) return;
      if (n === container) {
        if (n.nodeType === 3) {
          // if inside a raw-syntax node, don't count
          if (isInsideRawSyntax(n)) { done = true; return; }
          off += containerOff;
        } else {
          for (let i = 0; i < containerOff; i++) countFull(n.childNodes[i]);
        }
        done = true;
        return;
      }
      if (n.nodeType === 3) {
        if (!isInsideRawSyntax(n)) off += n.textContent.length;
        return;
      }
      if (n.nodeName === 'BR') return;
      if (n.classList && n.classList.contains('md-raw-syntax')) return;
      for (const c of n.childNodes) { walk(c); if (done) return; }
    }

    walk(lineDiv);
    return { li, off };
  }

  function isInsideRawSyntax(node) {
    let n = node.parentNode;
    while (n && n !== editor) {
      if (n.classList && n.classList.contains('md-raw-syntax')) return true;
      n = n.parentNode;
    }
    return false;
  }

  function getCursorPos() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    return nodeToLinePos(r.startContainer, r.startOffset);
  }

  function getActiveLine() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return -1;
    const r = sel.getRangeAt(0);
    let node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode;
    while (node && node.parentNode !== editor) node = node.parentNode;
    if (!node || node === editor) return -1;
    return Array.from(editor.children).indexOf(node);
  }

  function setCursorPos({ li, off }) {
    const lines  = Array.from(editor.children);
    const lineDiv = lines[Math.min(li, lines.length - 1)];
    if (!lineDiv) return;

    const sel   = window.getSelection();
    const range = document.createRange();
    let cnt = 0, done = false;

    function walk(n) {
      if (done) return;
      // skip raw-syntax spans
      if (n.classList && n.classList.contains('md-raw-syntax')) return;
      if (n.nodeType === 3) {
        const len = n.textContent.length;
        if (cnt + len >= off) {
          range.setStart(n, Math.min(off - cnt, len));
          range.collapse(true);
          done = true;
          return;
        }
        cnt += len;
        return;
      }
      if (n.nodeName === 'BR') return;
      for (const c of n.childNodes) { walk(c); if (done) return; }
    }

    walk(lineDiv);
    if (!done) {
      // Cursor offset is beyond content length — place at end of last visible text node
      const endNode = lastVisibleTextNode(lineDiv);
      if (endNode) {
        range.setStart(endNode, endNode.textContent.length);
        range.collapse(true);
      } else {
        // No text node at all — place after the last child of lineDiv
        range.setStart(lineDiv, lineDiv.childNodes.length);
        range.collapse(true);
      }
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function fixCursorIfInRawSyntax() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (!r.collapsed) return;
    if (isInsideRawSyntax(r.startContainer)) {
      // Move cursor to after the raw-syntax ancestor
      let rawNode = r.startContainer;
      while (rawNode.parentNode && !rawNode.parentNode.classList?.contains('md-raw-syntax')) {
        if (rawNode.classList?.contains('md-raw-syntax')) break;
        rawNode = rawNode.parentNode;
      }
      // rawNode is the md-raw-syntax span; move after it
      const parent = rawNode.parentNode;
      if (parent) {
        const newRange = document.createRange();
        const idx = Array.from(parent.childNodes).indexOf(rawNode);
        newRange.setStart(parent, idx + 1);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }
    }
  }

  function lastVisibleTextNode(root) {
    let last = null;
    function walk(n) {
      if (n.classList && n.classList.contains('md-raw-syntax')) return;
      if (n.nodeType === 3) { last = n; return; }
      for (const c of n.childNodes) walk(c);
    }
    walk(root);
    return last;
  }

  // ── Core re-render ──────────────────────────────────────────────

  function rerender() {
    if (busy) return;
    busy = true;

    if (editor.children.length > 0) {
      for (const node of [...editor.childNodes]) {
        if (node.nodeType !== 1) editor.removeChild(node);
      }
    }

    const pos  = getCursorPos();
    activeLine = getActiveLine();

    const src  = domToMarkdown();
    const srcLines = src ? src.split('\n') : [''];
    const domLines = Array.from(editor.children);

    // Smart rerender: only replace lines whose source or type changed.
    // This avoids destroying the cursor's text node on every keystroke.
    const maxLen = Math.max(srcLines.length, domLines.length);
    for (let i = 0; i < maxLen; i++) {
      const lineSrc = srcLines[i] !== undefined ? srcLines[i] : null;
      const oldDiv  = domLines[i] || null;
      const isActive = !rawMode && i === activeLine;

      if (lineSrc === null) {
        // Extra DOM line — remove
        if (oldDiv) editor.removeChild(oldDiv);
        continue;
      }

      if (!oldDiv) {
        // New line — append
        editor.appendChild(renderLineDiv(lineSrc, isActive));
        continue;
      }

      // Check if the rendered source of this div already matches
      const oldSrc = lineDivToSource(oldDiv);
      const oldActive = oldDiv.classList.contains('md-active-line');
      if (oldSrc === lineSrc && oldActive === isActive) continue; // no change

      const newDiv = renderLineDiv(lineSrc, isActive);
      editor.replaceChild(newDiv, oldDiv);
    }

    if (pos) setCursorPos(pos);
    syncPlaceholder();
    busy = false;
  }

  // Update active-line highlighting without full rerender (used on cursor moves)
  function rerenderActiveLine() {
    if (busy) return;
    const newActive = getActiveLine();
    if (newActive === activeLine) return;

    busy = true;
    const pos = getCursorPos();

    // Re-render old active line (remove active class)
    if (activeLine >= 0) {
      const lines = Array.from(editor.children);
      const oldDiv = lines[activeLine];
      if (oldDiv) {
        const src = lineDivToSource(oldDiv);
        const newDiv = renderLineDiv(src, false);
        editor.replaceChild(newDiv, oldDiv);
      }
    }

    activeLine = newActive;

    // Re-render new active line (add active class)
    if (activeLine >= 0) {
      const lines = Array.from(editor.children);
      const curDiv = lines[activeLine];
      if (curDiv) {
        const src = lineDivToSource(curDiv);
        const newDiv = renderLineDiv(src, !rawMode);
        editor.replaceChild(newDiv, curDiv);
      }
    }

    if (pos) setCursorPos(pos);
    busy = false;
  }

  // ── Track which inline span the cursor is inside ─────────────────
  // Adds .md-cursor-inside to the innermost inline format span containing
  // the cursor, so only its md-raw-syntax chars are shown.

  let lastCursorSpan = null;

  function updateCursorInside() {
    const sel = window.getSelection();
    const node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;

    // Walk up from cursor node to find an inline format span
    let target = null;
    let n = node;
    while (n && n !== editor) {
      if (n.nodeType === 1) {
        const cl = n.classList;
        if (cl && (cl.contains('md-bold') || cl.contains('md-italic') ||
                   cl.contains('md-strike') || n.nodeName === 'MARK')) {
          target = n;
          break;
        }
      }
      n = n.parentNode;
    }

    if (target === lastCursorSpan) return;

    if (lastCursorSpan) lastCursorSpan.classList.remove('md-cursor-inside');
    lastCursorSpan = target;
    if (lastCursorSpan) lastCursorSpan.classList.add('md-cursor-inside');
  }

  // ── Event listeners ─────────────────────────────────────────────

  editor.addEventListener('input', () => { rerender(); updateCursorInside(); });

  // Cursor movement: update active line without rerendering content
  editor.addEventListener('keyup', e => {
    const nav = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'];
    if (nav.includes(e.key)) { rerenderActiveLine(); updateCursorInside(); }
  });

  editor.addEventListener('mouseup', () => {
    requestAnimationFrame(() => { rerenderActiveLine(); updateCursorInside(); });
  });

  editor.addEventListener('focus', () => {
    requestAnimationFrame(() => { rerenderActiveLine(); updateCursorInside(); });
  });

  editor.addEventListener('blur', () => {
    if (lastCursorSpan) { lastCursorSpan.classList.remove('md-cursor-inside'); lastCursorSpan = null; }
    // When focus leaves, remove active-line treatment
    if (activeLine >= 0 && !rawMode) {
      busy = true;
      const pos = getCursorPos();
      const lines = Array.from(editor.children);
      const curDiv = lines[activeLine];
      if (curDiv) {
        const src = lineDivToSource(curDiv);
        const newDiv = renderLineDiv(src, false);
        editor.replaceChild(newDiv, curDiv);
      }
      activeLine = -1;
      busy = false;
    }
  });

  // Click pane padding → focus
  const pane = document.getElementById('editor-pane');
  if (pane) pane.addEventListener('click', e => {
    if (e.target === pane) editor.focus();
  });

  // ── renderedOff → source offset (for inline format insertion) ───

  function renderedOffToSrc(contentSrc, rendOff) {
    const re = /(\*\*[^*]+?\*\*|_[^_]+?_|~~[^~]+?~~|==[^=]+?==)/g;
    let srcI = 0, rndI = 0, m;
    while ((m = re.exec(contentSrc)) !== null) {
      const gapLen = m.index - srcI;
      if (rndI + gapLen > rendOff) return srcI + (rendOff - rndI);
      rndI += gapLen;
      const raw  = m[0];
      // detect markers length: **, _, ~~, ==
      const mlen = raw.startsWith('**') || raw.startsWith('~~') || raw.startsWith('==') ? 2 : 1;
      const innerLen = raw.length - mlen * 2;
      if (rndI + innerLen > rendOff) return m.index + mlen + (rendOff - rndI);
      rndI += innerLen;
      srcI = m.index + raw.length;
    }
    return srcI + (rendOff - rndI);
  }

  // ── Toolbar format actions ───────────────────────────────────────

  function applyInlineFormat(before, after, placeholder) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;

    const range    = sel.getRangeAt(0);
    const selected = range.toString();
    const inner    = selected || placeholder;

    const startPos = nodeToLinePos(range.startContainer, range.startOffset);
    const endPos   = sel.isCollapsed
      ? startPos
      : nodeToLinePos(range.endContainer, range.endOffset);

    if (startPos.li !== endPos.li) return;

    const { li, off: startRnd } = startPos;
    const endRnd = endPos.off;

    const lines   = Array.from(editor.children);
    const lineDiv = lines[li];
    if (!lineDiv) return;

    const fullSrc  = lineDivToSource(lineDiv);
    const parsed   = parseLine(fullSrc);
    // Use parsed.prefix for ALL block types (headings, lists, callout, etc.)
    const blockPfx = parsed.prefix;
    const contentSrc = fullSrc.slice(blockPfx.length);

    const srcStart = renderedOffToSrc(contentSrc, startRnd);
    const srcEnd   = renderedOffToSrc(contentSrc, endRnd);

    const newContent = contentSrc.slice(0, srcStart) + before + inner + after + contentSrc.slice(srcEnd);
    const newFullSrc = blockPfx + newContent;
    const newOff     = startRnd + inner.length;

    const newDiv = renderLineDiv(newFullSrc, !rawMode);
    editor.replaceChild(newDiv, lineDiv);

    editor.focus();
    setCursorPos({ li, off: newOff });
    syncPlaceholder();
  }

  function applyLinePrefix(prefix) {
    editor.focus();
    const pos = getCursorPos();
    if (!pos) return;
    const { li } = pos;

    const lines   = Array.from(editor.children);
    const lineDiv = lines[li];
    if (!lineDiv) return;

    const src = lineDivToSource(lineDiv);
    const blockRe     = /^(#{1,3} |> |- |\d+\. )/;
    const existingPfx = (src.match(blockRe) || [''])[0];
    const bare        = src.slice(existingPfx.length);
    const newSrc      = existingPfx === prefix ? bare : prefix + bare;

    const newDiv = renderLineDiv(newSrc, !rawMode);
    editor.replaceChild(newDiv, lineDiv);

    // Find the trailing content text node (after the prefix raw-syntax span)
    // and place cursor there directly, bypassing setCursorPos offset logic.
    const sel = window.getSelection();
    const range = document.createRange();
    const contentNode = lastVisibleTextNode(newDiv);
    if (contentNode) {
      range.setStart(contentNode, contentNode.textContent.length);
      range.collapse(true);
    } else {
      // Fallback: place after all children of newDiv
      range.setStart(newDiv, newDiv.childNodes.length);
      range.collapse(true);
    }
    sel.removeAllRanges();
    sel.addRange(range);

    syncPlaceholder();
  }

  // ── Toolbar wiring ───────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  // Prevent toolbar buttons from stealing focus (which loses the selection)
  document.querySelector('.fmt-toolbar').addEventListener('mousedown', e => {
    if (e.target.closest('.fmt-btn')) e.preventDefault();
  });

  $('fmt-h1')       .addEventListener('click', () => applyLinePrefix('# '));
  $('fmt-h2')       .addEventListener('click', () => applyLinePrefix('## '));
  $('fmt-h3')       .addEventListener('click', () => applyLinePrefix('### '));
  $('fmt-bold')     .addEventListener('click', () => applyInlineFormat('**', '**', 'bold text'));
  $('fmt-strike')   .addEventListener('click', () => applyInlineFormat('~~', '~~', 'strikethrough'));
  $('fmt-highlight').addEventListener('click', () => applyInlineFormat('==', '==', 'highlighted'));
  $('fmt-ul')       .addEventListener('click', () => applyLinePrefix('- '));
  $('fmt-ol')       .addEventListener('click', () => applyLinePrefix('1. '));
  $('fmt-callout')  .addEventListener('click', () => applyLinePrefix('> '));

  // ── Keyboard shortcuts ───────────────────────────────────────────

editor.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation(); // ← ADD THIS
      busy = true;
      document.execCommand('insertText', false, '    ');
      busy = false;
      rerender();
      return;
    }

    if (mod && !e.shiftKey && e.key === 'b') {
      e.preventDefault();
      applyInlineFormat('**', '**', 'bold text');
      return;
    }

    if (mod && e.shiftKey && e.key === 'H') {
      e.preventDefault();
      applyInlineFormat('==', '==', 'highlighted');
      return;
    }

    // For printable characters on block-type lines: ensure the character
    // is inserted into the content area (after the prefix span), not before it.
    // This fixes the case where rerender placed the cursor at element-level offset.
    if (!mod && e.key.length === 1) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      // If cursor is at the element level inside a block-type line div
      // (container is the div itself, not a text node inside it), fix it first.
      if (r.startContainer.nodeType === 1) {
        const div = r.startContainer;
        const cl = div.classList;
        const isBlock = cl && (cl.contains('md-ul-item') || cl.contains('md-ol-item') ||
                               cl.contains('md-h1') || cl.contains('md-h2') || cl.contains('md-h3') ||
                               cl.contains('md-callout'));
        if (isBlock) {
          e.preventDefault();
          // Place cursor at end of visible content then insert
          const textNode = lastVisibleTextNode(div);
          const range = document.createRange();
          if (textNode) {
            range.setStart(textNode, textNode.textContent.length);
          } else {
            range.setStart(div, div.childNodes.length);
          }
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          busy = true;
          document.execCommand('insertText', false, e.key);
          busy = false;
          rerender();
        }
      }
    }
  });

  // ── Paste: plain text only ───────────────────────────────────────
  editor.addEventListener('paste', e => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    busy = true;
    document.execCommand('insertText', false, text);
    busy = false;
    rerender();
  });
  })();
