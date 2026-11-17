import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { questionLayer } from '@shared/engine';
import { latestAnswer, renderQuestion, staleReason } from '@shared/templates';
import type { Question, WorkshopView } from '@shared/types';
import { AnswerInput, formatValue } from '../components/AnswerInput';
import { absorbKeysFromHash, getKey, useWorkshop } from '../lib/api';
import { ConnectionDot, Empty, FullPageMessage, Modal, Spinner, themeStyle, timeAgo, useAction, useToast } from '../lib/ui';

type Send = (command: Record<string, unknown>) => Promise<void>;

export function Participant() {
  const { workshopId = '' } = useParams();
  const [key] = useState(() => {
    absorbKeysFromHash(workshopId);
    return getKey(workshopId, 'participant');
  });
  const { view, status, send } = useWorkshop(workshopId, key);
  const [tab, setTab] = useState<'now' | 'answers'>('now');
  const [menu, setMenu] = useState(false);

  if (status === 'missing-key' || status === 'denied') {
    return (
      <FullPageMessage title="You are not signed in to this workshop">
        <p className="muted">This device does not have your place in this workshop. Join with the workshop code, or ask the facilitator for your personal link.</p>
        <Link className="btn btn-primary" to="/join">
          Join with a code
        </Link>
      </FullPageMessage>
    );
  }
  if (!view || view.role.type !== 'participant') return <Spinner label="Joining…" />;

  const me = view.role.id;
  const live = view.liveQuestionId ? view.questions[view.liveQuestionId] : undefined;
  const stageIndex = view.config.stages.findIndex((s) => s.id === view.stageId);
  const stage = view.config.stages[stageIndex];
  const stale = answeredQuestions(view, me).filter((q) => staleReason(view, q, latestAnswer(view, q.id, me)!) !== null).length;

  return (
    <div className="phone" style={themeStyle(view.config)}>
      <header className="phone-head">
        <div className="grow">
          <div className="truncate" style={{ fontWeight: 700 }}>
            {view.title}
          </div>
          <div className="tiny muted truncate">
            {stage ? `${stageIndex + 1} of ${view.config.stages.length} · ${stage.title}` : ''}
            {view.isExample ? ' · Fictional example' : ''}
          </div>
        </div>
        <ConnectionDot status={status} />
        <button className="btn btn-sm" onClick={() => setMenu(true)} aria-label="Your details">
          {view.participants[me]?.name ?? 'You'}
        </button>
      </header>
      <div style={{ padding: '0 16px 8px' }}>
        <div className="stage-steps" aria-hidden>
          {view.config.stages.map((s, i) => (
            <span key={s.id} className={i < stageIndex ? 'done' : i === stageIndex ? 'now' : ''} />
          ))}
        </div>
      </div>

      <main className="phone-main">
        {status === 'reconnecting' && <div className="banner banner-warn">Connection lost. Trying to reconnect — your saved answers are safe.</div>}
        {tab === 'now' && view.settings.layers.connections.open && (
          <Link className="card card-pad row" style={{ textDecoration: 'none', color: 'inherit', borderColor: 'var(--accent)' }} to={`/x/${workshopId}?as=me`}>
            <div className="grow">
              <h3>Draw your connections</h3>
              <p className="muted small">Open the map and draw arrows from what causes to what it affects. Your arrows are your own.</p>
            </div>
            <span className="btn btn-primary">Open map</span>
          </Link>
        )}
        {tab === 'now' && (live ? <LiveQuestion key={live.id + ':' + live.rounds} view={view} question={live} me={me} send={send} /> : <Waiting view={view} />)}
        {tab === 'answers' && <MyAnswers view={view} me={me} send={send} />}
      </main>

      <nav className="phone-nav" aria-label="Sections">
        <div className="phone-nav-inner">
          <button aria-current={tab === 'now' ? 'page' : undefined} onClick={() => setTab('now')}>
            <span className="nav-icon" aria-hidden>
              ●
            </span>
            Now
          </button>
          <button aria-current={tab === 'answers' ? 'page' : undefined} onClick={() => setTab('answers')}>
            <span className="nav-icon" aria-hidden>
              ✎
            </span>
            My answers
            {stale > 0 && <span className="nav-badge">{stale}</span>}
          </button>
          <Link to={`/x/${workshopId}?as=me`} style={{ flex: 1, textDecoration: 'none' }}>
            <button style={{ width: '100%' }} tabIndex={-1}>
              <span className="nav-icon" aria-hidden>
                ◇
              </span>
              {view.settings.layers.connections.open ? 'Draw my map' : 'My map'}
            </button>
          </Link>
        </div>
      </nav>

      {menu && <Menu view={view} me={me} send={send} workshopId={workshopId} participantKey={key!} onClose={() => setMenu(false)} />}
    </div>
  );
}

function Waiting({ view }: { view: WorkshopView }) {
  const stage = view.config.stages.find((s) => s.id === view.stageId);
  return (
    <section className="card waiting">
      <div className="waiting-dots" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <h2>Waiting for the next question</h2>
      <p className="muted">{stage?.description || 'The facilitator will put a question on your screen shortly.'}</p>
      <p className="muted tiny">No rush, and nothing is scored. You can review what you said under “My answers”.</p>
    </section>
  );
}

function LiveQuestion({ view, question, me, send }: { view: WorkshopView; question: Question; me: string; send: Send }) {
  const r = renderQuestion(view, question);
  const progress = view.progress[question.id];
  const others = question.revealed ? Object.entries(view.answers[question.id] ?? {}).filter(([pid]) => pid !== me) : [];
  const revealedSuggestions = question.revealed ? Object.values(view.suggestions).filter((s) => s.questionId === question.id && s.participantId !== me && s.status !== 'withdrawn') : [];
  return (
    <>
      <section className="card question-card">
        <div className="row-wrap">
          <span className="chip chip-accent">{r.title}</span>
          {progress && (
            <span className="chip right">
              {progress.responded} of {progress.total} responded
            </span>
          )}
        </div>
        <h1 className="question-prompt">{r.prompt}</h1>
        {r.help && <p className="question-help">{r.help}</p>}
        <AnswerInput view={view} question={question} participantId={me} send={send} via="question" />
      </section>
      {question.revealed && (
        <section className="card card-pad stack">
          <h3>What others said</h3>
          {others.length === 0 && revealedSuggestions.length === 0 && <p className="muted small">Nobody else has answered yet.</p>}
          {others.map(([pid, list]) => {
            const a = list[list.length - 1]!;
            return (
              <div key={pid} className="response">
                <span className="tiny muted">{view.participants[pid]?.name ?? 'Someone'}</span>
                <span className="answer-value">{formatValue(view, r.answer, a.value)}</span>
                {a.reasoning && <span className="small muted">{a.reasoning}</span>}
              </div>
            );
          })}
          {revealedSuggestions.map((s) => (
            <div key={s.id} className="response">
              <span className="tiny muted">{view.participants[s.participantId]?.name ?? 'Someone'}</span>
              <span className="answer-value">{s.text}</span>
            </div>
          ))}
          <p className="tiny muted">Seeing other answers is not a reason to change yours. Disagreement is kept, not smoothed over.</p>
        </section>
      )}
    </>
  );
}

function answeredQuestions(view: WorkshopView, me: string): Question[] {
  return Object.values(view.questions)
    .filter((q) => q.status !== 'superseded' && latestAnswer(view, q.id, me))
    .sort((a, b) => latestAnswer(view, b.id, me)!.at.localeCompare(latestAnswer(view, a.id, me)!.at));
}

function MyAnswers({ view, me, send }: { view: WorkshopView; me: string; send: Send }) {
  const [editing, setEditing] = useState<string | null>(null);
  const { run, busy } = useAction();
  const questions = useMemo(() => answeredQuestions(view, me), [view, me]);
  const mySuggestions = Object.values(view.suggestions).filter((s) => s.participantId === me && s.status !== 'withdrawn');
  const editingQuestion = editing ? view.questions[editing] : undefined;

  if (questions.length === 0 && mySuggestions.length === 0) {
    return (
      <section className="card">
        <Empty title="Nothing here yet" icon="✎">
          Your answers will appear here once you have given some. You can change any of them later.
        </Empty>
      </section>
    );
  }
  const openEnded = (q: Question) => ['suggestions', 'nominate-links'].includes(renderQuestion(view, q).answer.type);
  return (
    <>
      <section className="card card-pad">
        <h2>My answers</h2>
        <p className="muted small" style={{ marginTop: 4 }}>
          Tap “Change” to revise. Earlier versions are kept.
        </p>
        <div className="list" style={{ marginTop: 8 }}>
          {questions.map((q) => {
            const r = renderQuestion(view, q);
            const a = latestAnswer(view, q.id, me)!;
            const reason = staleReason(view, q, a);
            const canEdit = q.status === 'live' || q.status === 'closed' || view.settings.layers[questionLayer(view, q)].open;
            return (
              <div key={q.id} className="answer-row">
                <div className="small muted">{r.prompt}</div>
                <div className="answer-value">{formatValue(view, r.answer, a.value)}</div>
                {a.reasoning && <div className="small muted">“{a.reasoning}”</div>}
                {reason && (
                  <div className="banner banner-warn small stack-sm">
                    <span>{reason} Is your answer still right?</span>
                    <div className="row-wrap">
                      <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => send({ type: 'confirm_answer', questionId: q.id }), 'Kept')}>
                        Still right
                      </button>
                      {canEdit && (
                        <button className="btn btn-sm" onClick={() => setEditing(q.id)}>
                          Change it
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <div className="row tiny muted">
                  <span>
                    {timeAgo(a.at)}
                    {a.revision > 1 ? ` · version ${a.revision}` : ''}
                    {a.source === 'proposal' ? ' · from your own proposal' : ''}
                    {a.source === 'on-behalf' ? ' · entered by the facilitator' : ''}
                  </span>
                  {canEdit && !reason && (
                    <button className="btn btn-sm btn-ghost right" onClick={() => setEditing(q.id)}>
                      {openEnded(q) ? 'Add more' : 'Change'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
      {mySuggestions.length > 0 && (
        <section className="card card-pad stack-sm">
          <h3>My suggestions</h3>
          {mySuggestions.map((s) => (
            <div key={s.id} className="row small">
              <span className="grow">{s.text}</span>
              <span className={`chip ${s.status === 'accepted' || s.status === 'merged' ? 'chip-ok' : ''}`}>
                {s.status === 'pending' ? 'sent' : s.status === 'accepted' ? 'on the map' : s.status === 'merged' ? 'combined' : 'set aside'}
              </span>
            </div>
          ))}
        </section>
      )}
      {editingQuestion && (
        <Modal title="Change your answer" onClose={() => setEditing(null)}>
          <div className="stack">
            <div>
              <h3>{renderQuestion(view, editingQuestion).prompt}</h3>
              {renderQuestion(view, editingQuestion).help && <p className="muted small">{renderQuestion(view, editingQuestion).help}</p>}
            </div>
            <AnswerInput view={view} question={editingQuestion} participantId={me} send={send} via="question" compact onSaved={() => !openEnded(editingQuestion) && setEditing(null)} />
          </div>
        </Modal>
      )}
    </>
  );
}

function Menu({ view, me, send, workshopId, participantKey, onClose }: { view: WorkshopView; me: string; send: Send; workshopId: string; participantKey: string; onClose: () => void }) {
  const toast = useToast();
  const { run, busy } = useAction();
  const [name, setName] = useState(view.participants[me]?.name ?? '');
  const link = `${window.location.origin}/x/${workshopId}?as=me#pkey=${participantKey}`;
  return (
    <Modal title="You" onClose={onClose}>
      <div className="stack-lg">
        <form
          className="stack-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => send({ type: 'rename_participant', name }), 'Name changed');
          }}
        >
          <label className="field">
            <span>Your name</span>
            <div className="row">
              <input className="input grow" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
              <button className="btn" disabled={busy || !name.trim() || name === view.participants[me]?.name}>
                Save
              </button>
            </div>
          </label>
        </form>
        <div className="stack-sm">
          <h3>Open your model on a laptop</h3>
          <p className="muted small">This personal link signs that device in as you. Do not share it with anyone else.</p>
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard?.writeText(link).then(
                () => toast('Personal link copied'),
                () => toast('Could not copy. Long-press the link instead.', 'error'),
              );
            }}
          >
            Copy my personal link
          </button>
          <input className="input code" readOnly value={link} aria-label="Personal link" onFocus={(e) => e.target.select()} />
        </div>
      </div>
    </Modal>
  );
}
