import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, linkHost, previewLine, safeHref, taskOffsets, toggleTask } from '../src/ui/Markdown.tsx';

const html = (text: string, toggle = false) => renderToStaticMarkup(createElement(Markdown, toggle ? { text, onToggle: () => undefined } : { text }));

describe('Markdown: XSS', () => {
  it('сырой HTML показывается текстом', () => {
    const out = html('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\nтекст <b onclick="x()">жирный</b>');
    expect(out).not.toMatch(/<img|<script|<b /);
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('&lt;script&gt;');
  });

  it('ссылки javascript: и data: не становятся ссылками', () => {
    for (const src of ['[x](javascript:alert(1))', '[x](JAVASCRIPT:alert(1))', '[x]( javascript:alert(1))', '[x](data:text/html,<script>alert(1)</script>)', '<a href="javascript:alert(1)">x</a>', '![x](javascript:alert(1))']) {
      const out = html(src);
      expect(out, src).not.toMatch(/<a /);
      expect(out, src).not.toMatch(/ href="/);
    }
  });

  it('http(s) и mailto открываются как ссылки с noopener', () => {
    const out = html('[сайт](https://olerast.com) и https://example.org/a?b=1 и <mailto:me@example.org>');
    expect(out).toContain('<a href="https://olerast.com/" target="_blank" rel="noopener noreferrer" title="https://olerast.com/">сайт</a><span class="muted"> (olerast.com)</span>');
    expect(out).toContain('href="https://example.org/a?b=1"');
    expect(out).toContain('href="mailto:me@example.org"');
  });

  it('safeHref', () => {
    expect(safeHref('https://a.b/c')).toBe('https://a.b/c');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('/relative')).toBeNull();
    expect(safeHref('vbscript:x')).toBeNull();
  });

  it('картинки не загружаются, остаются ссылкой', () => {
    const out = html('![кот](https://example.org/cat.png)');
    expect(out).not.toContain('<img');
    expect(out).toContain('<a href="https://example.org/cat.png"');
  });
});

describe('Markdown: разметка', () => {
  it('заголовки, жирный, курсив, код, цитата', () => {
    const out = html('# Заголовок\n\n**жирный** *курсив* `код`\n\n> цитата\n\n```\nx < y\n```');
    expect(out).toContain('<h3 class="md-h">Заголовок</h3>');
    expect(out).toContain('<strong>жирный</strong>');
    expect(out).toContain('<em>курсив</em>');
    expect(out).toContain('<code>код</code>');
    expect(out).toContain('<blockquote><p>цитата</p></blockquote>');
    expect(out).toContain('<pre><code>x &lt; y</code></pre>');
  });

  it('таблица GFM в обёртке с прокруткой', () => {
    const out = html('| a | b |\n|:--|--:|\n| 1 | **2** |');
    expect(out).toContain('<div class="md-table"><table>');
    expect(out).toContain('<th style="text-align:left">a</th>');
    expect(out).toContain('<td style="text-align:right"><strong>2</strong></td>');
  });

  it('чек-лист: в описании кликабелен, в комментарии нет', () => {
    const src = '- [ ] купить\n- [x] позвонить\n- обычный';
    const view = html(src);
    expect(view.match(/type="checkbox"/g)).toHaveLength(2);
    expect(view.match(/disabled=""/g)).toHaveLength(2);
    expect(view).toMatch(/<li class="md-task done"><input type="checkbox"[^>]*checked=""/);
    const edit = html(src, true);
    expect(edit).not.toContain('disabled');
  });

  it('переводы строк сохраняются', () => {
    expect(html('строка 1\nстрока 2')).toBe('<div class="md"><p>строка 1<br/>строка 2</p></div>');
  });
});

describe('toggleTask', () => {
  it('переключает пункт по номеру', () => {
    const src = '- [ ] a\n- [x] b\n- [ ] c';
    expect(toggleTask(src, 0)).toBe('- [x] a\n- [x] b\n- [ ] c');
    expect(toggleTask(src, 1)).toBe('- [ ] a\n- [ ] b\n- [ ] c');
    expect(toggleTask(src, 2)).toBe('- [ ] a\n- [x] b\n- [x] c');
    expect(toggleTask(src, 3)).toBe(src);
  });

  it('не путается в коде, цитатах и вложенных списках', () => {
    const src = ['```', '- [ ] в коде', '```', '', '    - [ ] отступ это код', '', '- [ ] в коде', '  - [X] вложенный', '1. [ ] нумерованный', '', '> - [ ] в цитате'].join('\n');
    expect(taskOffsets(src)).toHaveLength(4);
    expect(toggleTask(src, 0).split('\n')[6]).toBe('- [x] в коде');
    expect(toggleTask(src, 0).split('\n')[1]).toBe('- [ ] в коде');
    expect(toggleTask(src, 1).split('\n')[7]).toBe('  - [ ] вложенный');
    expect(toggleTask(src, 2).split('\n')[8]).toBe('1. [x] нумерованный');
    expect(toggleTask(src, 3).split('\n')[10]).toBe('> - [x] в цитате');
  });

  it('число пунктов совпадает с показом', () => {
    for (const src of ['- [ ] a\n\n  - [x] b\n\n- [ ] c\n\n  текст', '* [x] a\n+ [ ] b\n\n> 1. [ ] c\n> 2. [x] d', 'нет пунктов\n- [ ]\n- [ ]x']) {
      expect(taskOffsets(src).length, src).toBe((html(src, true).match(/type="checkbox"/g) ?? []).length);
    }
  });

  it('CRLF не мешает', () => {
    expect(toggleTask('x\r\n- [ ] a\r\n- [ ] b', 1)).toBe('x\n- [ ] a\n- [x] b');
  });
});

describe('previewLine', () => {
  it('первая строка описания без разметки', () => {
    expect(previewLine('\n## План на **неделю**\nдальше')).toBe('План на неделю');
    expect(previewLine('- [ ] купить [хлеб](https://x.ru) и `молоко`')).toBe('купить хлеб и молоко');
    expect(previewLine('1. *первый* шаг, snake_case_name')).toBe('первый шаг, snake_case_name');
  });
});

describe('linkHost', () => {
  it('показывает настоящий адрес, если текст ссылки другой', () => {
    expect(linkHost('google.com', 'https://evil.example/')).toBe('evil.example');
    expect(linkHost('хлеб', 'https://www.shop.ru/bread')).toBe('shop.ru');
    expect(linkHost('https://example.com', 'https://example.com/')).toBeNull();
    expect(linkHost('example.com', 'https://www.example.com/')).toBeNull();
    expect(linkHost('a@b.ru', 'mailto:a@b.ru')).toBeNull();
    expect(html('[google.com](https://evil.example)')).toContain('(evil.example)');
  });
});
