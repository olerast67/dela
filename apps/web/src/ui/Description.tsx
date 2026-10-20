/**
 * Описание проекта или раздела под заголовком: Markdown, щелчок по тексту открывает правку,
 * Esc или уход фокуса сохраняет. Пустое описание места не занимает — добавляется кнопкой «Описание».
 */
import { useEffect, useState } from 'react';
import { Markdown, toggleTask } from './Markdown.tsx';
import { tr } from '../i18n.ts';

export function Description({
  text,
  editing,
  onEditing,
  onSave,
  className = '',
}: {
  text: string;
  editing: boolean;
  onEditing: (v: boolean) => void;
  onSave: (v: string) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(text);
  // Правка от другого устройства или участника приходит, пока поле закрыто.
  useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing]);
  if (editing) {
    return (
      <textarea
        className={`desc-edit ${className}`}
        autoFocus
        rows={3}
        placeholder={tr('Описание')}
        aria-label={tr('Описание')}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft.trimEnd() !== text) onSave(draft);
          onEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            e.currentTarget.blur();
          }
        }}
      />
    );
  }
  if (!text.trim()) return null;
  return (
    // Щелчок по тексту (не по ссылке и не по пункту чек-листа) открывает правку.
    <div
      className={`desc-view ${className}`}
      role="button"
      tabIndex={0}
      aria-label={tr('Описание, изменить')}
      title={tr('Щёлкните, чтобы изменить')}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a, input, button')) return;
        if (window.getSelection()?.toString()) return;
        onEditing(true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault();
          onEditing(true);
        }
      }}
    >
      <Markdown text={text} onToggle={(i) => onSave(toggleTask(text, i))} />
    </div>
  );
}
