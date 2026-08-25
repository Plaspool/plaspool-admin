import { Hammer } from 'lucide-react';
import { PageHeader } from '../ui/Page';
import { ButtonLink } from '../ui/primitives';

/**
 * The screen every route v2 has not redesigned yet renders.
 *
 * IT IS A REAL v2 SCREEN, and that is the point of it. The alternative — render
 * the v1 component inside the v2 shell — was considered and rejected: a
 * neobrutalist card with a green accent sitting inside the new chrome makes the
 * comparison this build exists for impossible to read, and it makes v2 look
 * half-finished in a way that is about the mixture rather than about the work.
 *
 * IT NAMES WHAT IS MISSING. A "coming soon" with no list is indistinguishable
 * from an abandoned route. The todos are the specific screens still owed, so
 * the next session has its worklist on screen rather than in a plan file.
 */
export function Soon({
  title,
  icon,
  what,
  todos,
}: {
  title: string;
  icon?: React.ReactNode;
  /** One sentence naming what this section does, in the present tense — it
   *  exists in v1 and works today, it is only the v2 surface that is owed. */
  what: string;
  todos: string[];
}) {
  return (
    <div className="page">
      <PageHeader icon={icon} title={title} />
      <div className="card">
        <div className="soon">
          <span className="soon__mark" aria-hidden="true">
            <Hammer />
          </span>
          <h2 className="soon__title">Not redesigned yet</h2>
          <p className="soon__body">
            {what} It works in the current admin — this screen is waiting on its v2 design, and
            nothing from v1 is mounted here on purpose, so the two versions stay honest to compare.
          </p>
          <div className="soon__todo">
            <h3>Still owed</h3>
            <ul>
              {todos.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
          <ButtonLink to="/home" tone="default">
            Back to home
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
