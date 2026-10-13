import { useEffect, useState } from 'react';
import { ApiError, NetworkError, fingerprint, fromB64 } from '#core';
import { controller } from '../controller.ts';
import { navigate, useDoc } from '../hooks.ts';
import { IconX } from './icons.tsx';
import { showToast } from './toast.tsx';

interface Member {
  readonly userId: string;
  readonly role: 'owner' | 'editor' | 'viewer';
  readonly email: string;
  readonly publicKey: string;
}

const ROLE: Record<Member['role'], string> = { owner: 'владелец', editor: 'участник', viewer: 'читатель' };

function errorText(err: unknown): string {
  if (err instanceof NetworkError) return 'Нет связи с сервером. Общий доступ настраивается только онлайн.';
  if (err instanceof ApiError && err.code === 'not_found') return 'На этом сервере нет пользователя с таким адресом. Пусть сначала зарегистрируется.';
  if (err instanceof ApiError && err.code === 'rate_limited') return 'Слишком много запросов. Попробуйте позже.';
  return 'Не получилось. Попробуйте ещё раз.';
}

export function ShareDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const ws = useDoc();
  const shared = ws.isShared(projectId);
  const owner = controller.roleIn(projectId) === 'owner';
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

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
      <div className="modal palette share" role="dialog" aria-label="Общий доступ">
        <div className="share-head">
          <h2 className="palette-title">Общий доступ</h2>
          <button className="icon" onClick={onClose} aria-label="Закрыть">
            <IconX />
          </button>
        </div>
        {!shared ? (
          <div className="share-body">
            <p>
              Проект переедет в отдельное пространство со своим ключом шифрования. Участники получат этот ключ, запечатанный их личными ключами;
              сервер его не видит. Метки остаются личными и в общий проект не переносятся.
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
                  showToast('Проект стал общим. Пригласите участников.');
                } catch (err) {
                  setMsg(errorText(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Подождите…' : 'Сделать проект общим'}
            </button>
          </div>
        ) : (
          <div className="share-body">
            {members === null && !msg && <p className="muted">Загрузка…</p>}
            {members?.map((m) => (
              <div key={m.userId} className="trash-row">
                <span>
                  {m.email} <span className="muted">· {ROLE[m.role]}</span>
                  <br />
                  <span className="muted mono" title="Отпечаток ключа: сверьте его с участником по другому каналу">
                    {fingerprint(fromB64(m.publicKey))}
                  </span>
                </span>
                {m.role !== 'owner' && (owner || m.userId === controller.userId) && (
                  <button
                    onClick={async () => {
                      const self = m.userId === controller.userId;
                      if (self && !confirm('Выйти из проекта? Его задачи пропадут с ваших устройств.')) return;
                      try {
                        await controller.removeMember(projectId, m.userId);
                        if (self) {
                          onClose();
                          navigate({ view: 'today' });
                        } else {
                          setMsg('Участник убран. Ключ проекта заменён: новых изменений он не увидит.');
                          void load();
                        }
                      } catch (err) {
                        setMsg(errorText(err));
                      }
                    }}
                  >
                    {m.userId === controller.userId ? 'Выйти' : 'Убрать'}
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
                    setMsg(`Добавлен. Отпечаток ключа участника: ${fp}. Если хотите убедиться, что ключ не подменён, сверьте отпечаток с ним по телефону.`);
                    setEmail('');
                    void load();
                  } catch (err) {
                    setMsg(errorText(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <input type="email" required placeholder="Почта участника" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Почта участника" />
                <button className="primary" disabled={busy}>
                  Пригласить
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
