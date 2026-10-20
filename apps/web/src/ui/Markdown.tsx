/**
 * Markdown в описании задачи и комментариях. Текст разбирает лексер marked, а элементы
 * строятся из токенов как React-узлы: сырой HTML показывается текстом и в DOM как HTML
 * не попадает, поэтому санитайзер не нужен. Ссылки только http(s) и mailto.
 * Картинки не загружаются: внешний адрес выдал бы серверу картинки, что задача открыта.
 */
import { createElement, useMemo, type ReactNode } from 'react';
import { Lexer, type Token, type Tokens } from 'marked';
import { openExternal } from '../platform.ts';
import { tr } from '../i18n.ts';

const OPTIONS = { gfm: true, breaks: true } as const;

function lex(text: string): Token[] {
  return Lexer.lex(text, OPTIONS);
}

/**
 * Куда на самом деле ведёт ссылка, если её текст говорит другое: «[google.com](https://evil.example)»
 * в общем проекте или комментарии иначе выглядит как google.com. null, если текст и есть адрес.
 */
export function linkHost(text: string, href: string): string | null {
  const bare = (s: string) => s.trim().toLowerCase().replace(/^(https?:\/\/|mailto:)/, '').replace(/^www\./, '').replace(/\/+$/, '');
  if (bare(text) === bare(href)) return null;
  const u = new URL(href);
  return u.protocol === 'mailto:' ? u.pathname : u.host.replace(/^www\./, '');
}

/** Первая непустая строка описания без разметки: под названием задачи в списке. */
export function previewLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return line
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?![\w*])/g, '$1$2')
    .trim();
}

/** Адрес ссылки, если его можно открыть: http(s) или mailto. Иначе null, и ссылка показывается текстом. */
export function safeHref(href: string): string | null {
  try {
    const u = new URL(href.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Позиции «[» у пунктов чек-листа в тексте, в том же порядке, в каком их обходит показ.
 * Верхние токены лексера по raw склеиваются ровно в исходный текст (с переводами строк \n),
 * а вложенный пункт ищется по первой строке своего raw от текущей позиции.
 */
export function taskOffsets(source: string): number[] {
  const src = source.replace(/\r\n|\r/g, '\n');
  const out: number[] = [];
  let cursor = 0;
  const find = (raw: string) => {
    const first = raw.split('\n')[0] ?? '';
    const at = src.indexOf(first, cursor);
    if (at < 0) return -1;
    cursor = at + first.length;
    return at;
  };
  const walk = (tokens: Token[]) => {
    for (const t of tokens) {
      if (t.type === 'list') {
        for (const item of (t as Tokens.List).items) {
          const at = find(item.raw);
          if (item.task && at >= 0) {
            const box = item.tokens.find((x) => x.type === 'checkbox');
            const rel = item.raw.split('\n')[0]!.indexOf(box?.raw ?? '[');
            out.push(at + Math.max(rel, 0));
          }
          walk(item.tokens);
        }
      } else if (t.type === 'code') {
        find(t.raw);
      } else if ('tokens' in t && Array.isArray(t.tokens)) {
        walk(t.tokens);
      }
    }
  };
  let top = 0;
  for (const t of lex(src)) {
    cursor = top;
    walk([t]);
    top += t.raw.length;
  }
  return out;
}

/** Переключает пункт чек-листа номер index: «[ ]» ↔ «[x]». Если пункта нет, текст не меняется. */
export function toggleTask(source: string, index: number): string {
  const src = source.replace(/\r\n|\r/g, '\n');
  const at = taskOffsets(src)[index];
  if (at === undefined || src[at] !== '[') return source;
  const mark = src[at + 1] === ' ' ? 'x' : ' ';
  return src.slice(0, at + 1) + mark + src.slice(at + 2);
}

type Ctx = { task: number; onToggle: ((index: number) => void) | undefined };

function inline(tokens: Token[] | undefined, ctx: Ctx): ReactNode[] {
  return (tokens ?? []).map((t, i) => inlineToken(t, i, ctx));
}

function inlineToken(t: Token, key: number, ctx: Ctx): ReactNode {
  switch (t.type) {
    case 'text':
      return 'tokens' in t && t.tokens?.length ? <span key={key}>{inline(t.tokens, ctx)}</span> : t.text;
    case 'escape':
      return t.text;
    case 'strong':
      return <strong key={key}>{inline(t.tokens, ctx)}</strong>;
    case 'em':
      return <em key={key}>{inline(t.tokens, ctx)}</em>;
    case 'del':
      return <del key={key}>{inline(t.tokens, ctx)}</del>;
    case 'codespan':
      return <code key={key}>{t.text}</code>;
    case 'br':
      return <br key={key} />;
    case 'link':
    case 'image': {
      const href = safeHref(t.href);
      const label = t.type === 'image' ? t.text || t.href : inline(t.tokens, ctx);
      if (!href) return <span key={key}>{label}</span>;
      const host = linkHost(t.type === 'image' ? t.text || t.href : t.text, href);
      return (
        <span key={key}>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={href}
            onClick={(e) => {
              e.preventDefault();
              void openExternal(href);
            }}
          >
            {label}
          </a>
          {host && <span className="muted"> ({host})</span>}
        </span>
      );
    }
    // Сырой HTML и всё незнакомое показываются как написано.
    default:
      return t.raw;
  }
}

function blocks(tokens: Token[], ctx: Ctx): ReactNode[] {
  return tokens.map((t, i) => block(t, i, ctx));
}

function block(t: Token, key: number, ctx: Ctx): ReactNode {
  switch (t.type) {
    case 'space':
    case 'def':
      return null;
    case 'paragraph':
      return <p key={key}>{inline(t.tokens, ctx)}</p>;
    case 'heading':
      // Заголовки внутри карточки мельче заголовка задачи: # становится h3.
      return createElement(`h${Math.min(t.depth + 2, 6)}`, { key, className: 'md-h' }, inline(t.tokens, ctx));
    case 'code':
      return (
        <pre key={key}>
          <code>{t.text}</code>
        </pre>
      );
    case 'blockquote':
      return <blockquote key={key}>{blocks(t.tokens ?? [], ctx)}</blockquote>;
    case 'hr':
      return <hr key={key} />;
    case 'list': {
      const list = t as Tokens.List;
      const items = list.items.map((item, i) => listItem(item, i, ctx));
      return list.ordered ? (
        <ol key={key} start={list.start === '' || list.start === 1 ? undefined : list.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case 'table': {
      const table = t as Tokens.Table;
      const align = (a: Tokens.TableCell['align']) => (a ? { textAlign: a } : undefined);
      return (
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>
                {table.header.map((c, i) => (
                  <th key={i} style={align(c.align)}>
                    {inline(c.tokens, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td key={i} style={align(c.align)}>
                      {inline(c.tokens, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'html':
      return <p key={key}>{t.text}</p>;
    case 'text':
      return 'tokens' in t && t.tokens?.length ? <span key={key}>{inline(t.tokens, ctx)}</span> : t.text;
    default:
      return inlineToken(t, key, ctx);
  }
}

function listItem(item: Tokens.ListItem, key: number, ctx: Ctx): ReactNode {
  const rest = item.tokens.filter((x) => x.type !== 'checkbox');
  if (!item.task) return <li key={key}>{blocks(rest, ctx)}</li>;
  // Номер пункта берётся до вложенных пунктов: порядок совпадает с taskOffsets.
  const index = ctx.task++;
  const toggle = ctx.onToggle;
  // Вложенный список идёт отдельно от текста пункта, чтобы зачёркивание его не задевало.
  const text = rest.filter((x) => x.type !== 'list');
  const nested = rest.filter((x) => x.type === 'list');
  return (
    <li key={key} className={`md-task${item.checked ? ' done' : ''}`}>
      <input
        type="checkbox"
        checked={!!item.checked}
        disabled={!toggle}
        onChange={() => toggle?.(index)}
        aria-label={item.checked ? tr('Снять отметку') : tr('Отметить пункт')}
      />
      <div className="md-task-text">{blocks(text, ctx)}</div>
      {blocks(nested, ctx)}
    </li>
  );
}

/** Показ Markdown. onToggle есть — чек-лист кликабелен, иначе только для показа. */
export function Markdown({ text, onToggle, className }: { text: string; onToggle?: (index: number) => void; className?: string }) {
  const tokens = useMemo(() => lex(text), [text]);
  const ctx: Ctx = { task: 0, onToggle };
  return <div className={className ? `md ${className}` : 'md'}>{blocks(tokens, ctx)}</div>;
}
