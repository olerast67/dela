/** Рисунки пустых экранов: линии цвета текста, заливки цвета акцента. Без текста внутри. */
export type EmptyKind = 'today' | 'inbox' | 'search' | 'done';

export function EmptyArt({ kind }: { kind: EmptyKind }) {
  return (
    <svg className="empty-art" width="180" height="130" viewBox="0 0 180 130" fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === 'today' && (
        <>
          {/* солнце над холмами и чашка: день разобран */}
          <circle cx="122" cy="44" r="18" className="fill-soft stroke-accent" />
          <path d="M122 14v8M122 66v8M92 44h8M144 44h8M101 23l5 5M138 60l5 5M143 23l-5 5" className="stroke-accent" />
          <path d="M10 112c22-20 46-26 72-14s52 10 88-8" className="stroke-line" />
          <path d="M38 78h40v14a16 16 0 0 1-16 16h-8a16 16 0 0 1-16-16z" className="fill-paper stroke-line" />
          <path d="M78 84h5a7 7 0 0 1 0 14h-6M50 70c0-5 6-5 6-10M62 70c0-5 6-5 6-10" className="stroke-line" />
          <path d="M50 90l6 6 10-11" className="stroke-accent" />
        </>
      )}
      {kind === 'inbox' && (
        <>
          {/* пустой лоток и искры: всё разобрано */}
          <path d="M40 66h28l7 13h30l7-13h28v34a8 8 0 0 1-8 8H48a8 8 0 0 1-8-8z" className="fill-soft stroke-line" />
          <path d="M40 66l16-34h68l16 34" className="stroke-line" />
          <path d="M90 14v12M78 20l5 6M102 20l-5 6" className="stroke-accent" />
          <circle cx="150" cy="30" r="3" className="fill-accent" />
          <circle cx="30" cy="44" r="2.5" className="fill-accent" />
        </>
      )}
      {kind === 'search' && (
        <>
          <circle cx="78" cy="58" r="30" className="fill-soft stroke-line" />
          <path d="M100 80l26 26" className="stroke-line" strokeWidth="6" />
          <path d="M66 58h24" className="stroke-accent" />
        </>
      )}
      {kind === 'done' && (
        <>
          <rect x="44" y="24" width="92" height="88" rx="12" className="fill-paper stroke-line" />
          <path d="M62 50l7 7 12-13M62 80l7 7 12-13" className="stroke-accent" />
          <path d="M92 52h26M92 82h20" className="stroke-line" />
        </>
      )}
    </svg>
  );
}
