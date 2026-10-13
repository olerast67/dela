import { useEffect, useState } from 'react';
import { ApiError, NetworkError, UnpinnedMembersError, fingerprint, fromB64 } from '#core';
import { controller } from '../controller.ts';
import { navigate, useDoc } from '../hooks.ts';
import { IconX } from './icons.tsx';
import { showToast } from './toast.tsx';
import { tr, trc } from '../i18n.ts';

interface Member {
  readonly userId: string;
  readonly role: 'owner' | 'editor' | 'viewer';
  readonly email: string;
  readonly publicKey: string;
}

const ROLE: Record<Member['role'], string> = { owner: tr('владелец'), editor: tr('участник'), viewer: tr('читатель') };

function errorText(err: unknown): string {
  if (err instanceof NetworkError) return tr('Нет связи с сервером. Общий доступ настраивается только онлайн.');
  if (err instanceof ApiError && err.code === 'not_found') return tr('На этом сервере нет пользователя с таким адресом. Пусть сначала зарегистрируется.');
  if (err instanceof ApiError && err.code === 'rate_limited') return tr('Слишком много запросов. Попробуйте позже.');
  if (err instanceof Error && err.message === 'self_invite') return tr('Себя приглашать не нужно: вы уже владелец проекта.');
  return tr('Не получилось. Попробуйте ещё раз.');
}

export function ShareDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const ws = useDoc();
  const shared = ws.isShared(projectId);
  const owner = controller.roleIn(projectId) === 'owner';
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [unpinned, setUnpinned] = useState<UnpinnedMembersError['members'] | null>(null);
  const warning = controller.keyWarning(projectId);

  const load = () =>
    controller
      .members(projectId)
      .then((r) => setMembers(r.members))
      .catch((err) => setMsg(errorText(err)));

  useEffect(() => {
    if (shared) void load();
  }, [projectId, shared]);

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal palette share" role="dialog" aria-label={tr('Общий доступ')}>
        <div className="share-head">
          <h2 className="palette-title">{tr('Общий доступ')}</h2>
          <button className="icon" onClick={onClose} aria-label={tr('Закрыть')}>
            <IconX />
          </button>
        </div>
        {!shared ? (
          <div className="share-body">
            <p>
              {tr('Проект переедет в отдельное пространство со своим ключом шифрования. Участники получат этот ключ, запечатанный их личными ключами; сервер его не видит. Метки остаются личными и в общий проект не переносятся.')}
            </p>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setMsg(null);
                try {
                  const id = await controller.shareProject(projectId);
                  navigate({ view: 'project', id });
                  showToast(tr('Проект стал общим. Пригласите участников.'));
                } catch (err) {
                  setMsg(errorText(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? tr('Подождите…') : tr('Сделать проект общим')}
            </button>
          </div>
        ) : (
          <div className="share-body">
            {warning && (
              <div className="notice" role="alert">
                {warning === 'unsigned'
                  ? tr('Новый ключ проекта пришёл без подтверждения владельца, поэтому он не принят: правки в этом проекте пока шифруются прежним ключом. Скорее всего, владелец пользуется старой версией Dela.')
                  : tr('Новый ключ проекта прислал не тот владелец, которому вы доверяли. Отпечаток отправителя: {warning}. Если владелец проекта сменился (например, прежний удалил аккаунт), сверьте отпечаток с ним по другому каналу.', { warning: warning })}
                {warning !== 'unsigned' && (
                  <button onClick={() => void controller.trustSpaceSender(projectId).then(() => setMsg(tr('Ключ нового владельца принят.')))}>{tr('Доверять этому ключу')}</button>
                )}
              </div>
            )}
            {unpinned && (
              <div className="notice" role="alert">
                <p>{tr('Ключ проекта не сменён. Сверьте отпечатки ключей этих участников с ними по другому каналу:')}</p>
                {unpinned.map((u) => (
                  <p key={u.userId}>
                    {u.email} · <span className="mono">{fingerprint(fromB64(u.publicKey))}</span>
                    {u.changed ? tr(' (ключ изменился с момента приглашения)') : tr(' (приглашён на другом устройстве или в старой версии)')}
                  </p>
                ))}
                <button
                  onClick={async () => {
                    controller.pinMembers(projectId, unpinned);
                    setUnpinned(null);
                    try {
                      await controller.rotateKey(projectId);
                      setMsg(tr('Ключ проекта заменён.'));
                    } catch (err) {
                      setMsg(errorText(err));
                    }
                  }}
                >
                  {tr('Отпечатки совпадают, сменить ключ')}
                </button>
              </div>
            )}
            {members === null && !msg && <p className="muted">{tr('Загрузка…')}</p>}
            {members?.map((m) => (
              <div key={m.userId} className="trash-row">
                <span>
                  {m.email} <span className="muted">· {ROLE[m.role]}</span>
                  <br />
                  <span className="muted mono" title={tr('Отпечаток ключа: сверьте его с участником по другому каналу')}>
                    {fingerprint(fromB64(m.publicKey))}
                  </span>
                </span>
                {m.role !== 'owner' && (owner || m.userId === controller.userId) && (
                  <button
                    onClick={async () => {
                      const self = m.userId === controller.userId;
                      if (self && !confirm(tr('Выйти из проекта? Его задачи пропадут с ваших устройств.'))) return;
                      try {
                        await controller.removeMember(projectId, m.userId);
                        if (self) {
                          onClose();
                          navigate({ view: 'today' });
                        } else {
                          setMsg(tr('Участник убран. Ключ проекта заменён: новых изменений он не увидит.'));
                          void load();
                        }
                      } catch (err) {
                        if (err instanceof UnpinnedMembersError) {
                          setUnpinned(err.members);
                          void load();
                        } else setMsg(errorText(err));
                      }
                    }}
                  >
                    {m.userId === controller.userId ? trc('проект', 'Выйти') : tr('Убрать')}
                  </button>
                )}
              </div>
            ))}
            {owner && (
              <form
                className="row"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  setMsg(null);
                  try {
                    const fp = await controller.addMember(projectId, email.trim(), 'editor');
                    setMsg(tr('Добавлен. Отпечаток ключа участника: {fp}. Если хотите убедиться, что ключ не подменён, сверьте отпечаток с ним по телефону.', { fp: fp }));
                    setEmail('');
                    void load();
                  } catch (err) {
                    setMsg(errorText(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <input type="email" required placeholder={tr('Почта участника')} value={email} onChange={(e) => setEmail(e.target.value)} aria-label={tr('Почта участника')} />
                <button className="primary" disabled={busy}>
                  {tr('Пригласить')}
                </button>
              </form>
            )}
          </div>
        )}
        {msg && <p className="notice share-msg">{msg}</p>}
      </div>
    </div>
  );
}
