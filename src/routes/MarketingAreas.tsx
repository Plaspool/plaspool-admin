import { useCallback, useEffect, useMemo, useState } from 'react';
import { MapPin } from 'lucide-react';
import { marketingApi, type AreasView, type ServiceArea } from '../data/api-marketing';
import { ApiError } from '../data/errors';
import { getSession } from '../data/session';
import { useToast } from '../components/Toast';
import { Switch } from '../components/ui/Switch';
import { Skeleton } from '../components/ui/Feedback';
import { useDelayed } from '../components/ui/useDelayed';
import { Picker } from '../components/ui/Picker';
import { explainLoad, explainWrite } from './marketing/queue-shared';
import './marketing.css';

/**
 * Where we collect — the list of places the business sends a van.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS THE SCREEN THAT MAKES THE MODEL NATIONAL.
 *
 * Every region ships loaded and every area outside the one served region ships
 * SWITCHED OFF. Expanding to a new city is an owner flipping a Switch here —
 * not a migration, not a deploy, not a developer. That is the entire argument
 * for `marketing_service_areas` being a table rather than a constant, and this
 * screen is where the argument pays off.
 *
 * IT CAN RENAME AND ADD, not merely toggle. The shipped dataset has real errors
 * in it — it misspells at least one town and files at least one place under the
 * wrong state — and since everything outside the served region ships inactive,
 * no customer meets a bad name until an owner switches it on. So the correction
 * has to be available at the same moment the switch is, or the owner's only
 * option is to switch on a lie.
 *
 * OWNER-ONLY CONTROLS ARE ABSENT FOR A WRITER, never disabled (spec D12). Which
 * districts are served decides where the business sends a driver; a writer sees
 * the list read-only, because knowing where the vans go is part of processing
 * returns and deciding it is not.
 *
 * ONE STATE AT A TIME, CHOSEN FROM A SEARCHABLE PICKER. The shipped dataset is
 * every local government area in the country — 37 states, several hundred rows
 * — and this screen rendered all of them, every state, stacked. Finding Maitama
 * meant scrolling past Abia, Adamawa, Akwa Ibom and thirty more headings, and
 * the browser laid out the entire list to do it. The picker turns "scroll until
 * you see it" into "type three letters", and the page under it holds one state's
 * worth of rows. Nothing about the data changed: `byRegion` still groups the
 * whole response, and the tallies in the picker are counted across all of it, so
 * "3 of 17 switched on" is true whether or not you are looking at that state.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Regions in the order the API sends them, each with its served tally. */
export function byRegion(areas: readonly ServiceArea[]): {
  region: string;
  areas: ServiceArea[];
  served: number;
}[] {
  const regions = [...new Set(areas.map((area) => area.region))];
  return regions.map((region) => {
    const inRegion = areas.filter((area) => area.region === region);
    return { region, areas: inRegion, served: inRegion.filter((area) => area.active).length };
  });
}

export default function MarketingAreas() {
  const { notify } = useToast();
  const session = getSession();
  const isOwner = session.status === 'authed' && session.user.role === 'owner';

  const [view, setView] = useState<AreasView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const showSkeletons = useDelayed(loading);
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [adding, setAdding] = useState<{ region: string; name: string } | null>(null);
  const [addProblem, setAddProblem] = useState<string | null>(null);
  /**
   * Which state's rows are on screen. `null` until the first response lands,
   * and then the first region that has anything switched on — the state this
   * business actually operates in, which is the one an owner opened this screen
   * to adjust. Falling back to the first region alphabetically would open every
   * visit on Abia, which nobody serves.
   */
  const [region, setRegion] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    /* EVERYTHING, not `?active=true`: this screen is where an owner switches a
     * region ON, so the rows that are off are the whole point of it. */
    return marketingApi
      .listAreas(false, signal)
      .then((next) => {
        if (signal?.aborted) return;
        setView(next);
        setProblem(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (signal?.aborted) return;
        setProblem(explainLoad(err, 'The areas didn’t load.'));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  async function patch(area: ServiceArea, patchBody: { active?: boolean; name?: string }): Promise<void> {
    setBusy(area.id);
    try {
      await marketingApi.patchArea(area.id, { expectedRevision: area.revision, ...patchBody });
      await load();
      notify(patchBody.name !== undefined ? 'Area renamed' : patchBody.active === true ? 'Area switched on' : 'Area switched off');
    } catch (err) {
      /*
       * `area_in_use` IS THE ONE REFUSAL THAT NEEDS ITS OWN PATH. Switching off
       * a district that still holds open returns would strand them — off every
       * board, into the out-of-area footer, unrewardable, with nothing on screen
       * to say why. The count comes back with the error so the message is an
       * instruction rather than a wall.
       */
      if (err instanceof ApiError && err.code === 'area_in_use') {
        /* `body` is `unknown` by design — the client never trusts a payload's
         * shape — so the count is narrowed rather than asserted. Without one the
         * message is still an instruction, just a vaguer one. */
        const payload = err.body as { open?: unknown } | null;
        const open = typeof payload?.open === 'number' ? payload.open : null;
        notify(
          open === null
            ? 'That area still has open returns. Finish or move them first.'
            : `${open} open ${open === 1 ? 'return is' : 'returns are'} still on that board. Finish or move them before switching it off.`,
          { tone: 'danger' },
        );
      } else if (err instanceof ApiError && err.code === 'duplicate_area') {
        notify('That region already has an area with that name.', { tone: 'danger' });
      } else if (err instanceof ApiError && err.code === 'stale_write') {
        notify('Somebody else edited that area. Reloading the list.', { tone: 'danger' });
        await load();
      } else {
        notify(explainWrite(err), { tone: 'danger' });
      }
    } finally {
      setBusy(null);
      setRenaming(null);
    }
  }

  async function add(): Promise<void> {
    if (adding === null || adding.name.trim() === '' || adding.region.trim() === '') return;
    setAddProblem(null);
    try {
      await marketingApi.createArea({ region: adding.region.trim(), name: adding.name.trim() });
      setAdding(null);
      await load();
      /* Created OFF, like every other area — switching one on is the separate,
       * deliberate act. Said out loud so nobody waits for a van. */
      notify('Area added — switch it on when a driver covers it');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'duplicate_area') {
        setAddProblem('That region already has an area with that name.');
      } else {
        setAddProblem(explainWrite(err));
      }
    }
  }

  const groups = useMemo(() => (view === null ? [] : byRegion(view.areas)), [view]);

  /*
   * The opening choice, made once per load and never again — an owner who has
   * navigated to Kano does not want a refresh of the list to move them back.
   * `setRegion` inside the render pass would be the React way to do this and
   * would fight the picker; keying it on `groups` is the honest version.
   */
  useEffect(() => {
    if (groups.length === 0) return;
    setRegion((chosen) => {
      if (chosen !== null && groups.some((group) => group.region === chosen)) return chosen;
      return (groups.find((group) => group.served > 0) ?? groups[0]!).region;
    });
  }, [groups]);

  const shown = groups.find((group) => group.region === region) ?? null;
  const servedTotal = groups.reduce((n, group) => n + group.served, 0);

  return (
    <div className="mktscr">
      <header className="mktscr__head">
        <div className="mktscr__headrow">
          <div>
            <h1 className="mktscr__title">
              <MapPin className="mktdesk__flag" aria-hidden="true" /> Areas
            </h1>
            <p className="mktscr__lede">
              Where we collect. A return can only earn points if its address is in an area that is
              switched on — so this list is the rewards programme's map.
              {servedTotal > 0 && (
                <>
                  {' '}
                  <strong>
                    {servedTotal} {servedTotal === 1 ? 'area is' : 'areas are'} switched on
                  </strong>{' '}
                  across the country.
                </>
              )}
            </p>
          </div>

          {/*
            THE STATE PICKER, which is this screen's navigation and not a filter.
            A filter narrows a list you can still see the whole of; this chooses
            which of 37 lists is rendered at all. Its rows carry the served tally
            so the answer to "where do we operate" is in the picker itself —
            otherwise finding it means opening every state in turn, which is the
            scrolling this replaced.
          */}
          {groups.length > 0 && (
            <div className="mktscr__headacts">
              <Picker
                label="State"
                value={region}
                onChange={setRegion}
                items={groups.map((group) => ({
                  value: group.region,
                  label: group.region,
                  badge: group.served,
                  note: group.served === 0 ? `${group.areas.length} areas` : undefined,
                }))}
                icon={<MapPin className="ui-ic" aria-hidden="true" />}
                searchPlaceholder="Search states…"
                emptyText="No state matches that."
                align="end"
              />
            </div>
          )}
        </div>
      </header>

      {problem !== null && <p className="mktform__error">{problem}</p>}
      {showSkeletons && view === null && <Skeleton height="12rem" />}

      {view !== null && (
        <>
          {view.outOfArea.open > 0 && (
            <p className="notice">
              {view.outOfArea.open} open{' '}
              {view.outOfArea.open === 1 ? 'return belongs' : 'returns belong'} to no area at all.
              They can be closed with a reason, but they can never be awarded.
            </p>
          )}

          {/*
            ONE STATE — the one the picker names. Still a `map` over the same
            `byRegion` grouping rather than a single object pulled out of it, so
            the rows below are the rows this screen has always rendered and the
            day a "show every state" affordance is wanted it is a change to this
            array and to nothing else.
          */}
          {(shown === null ? [] : [shown]).map((group) => (
            <section className="mktarea" key={group.region}>
              <header className="mktarea__head">
                <h2 className="mktarea__region">{group.region}</h2>
                <p className="mktarea__tally">
                  {/* The number an owner is actually managing: how much of this
                      region we have promised to reach. */}
                  {group.served} of {group.areas.length} switched on
                </p>
              </header>

              <ul className="mktarea__list">
                {group.areas.map((area) => (
                  <li className="mktarea__row" key={area.id}>
                    {renaming?.id === area.id ? (
                      <form
                        className="mktarea__rename"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void patch(area, { name: renaming.value });
                        }}
                      >
                        <input
                          className="mktform__input"
                          value={renaming.value}
                          autoFocus
                          aria-label={`Rename ${area.name}`}
                          onChange={(event) =>
                            setRenaming({ id: area.id, value: event.target.value })
                          }
                        />
                        <button type="submit" className="btn btn--sm" disabled={busy === area.id}>
                          Save
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => setRenaming(null)}
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <>
                        <span className="mktarea__name">{area.name}</span>
                        {/* DERIVED FROM `seeded` AND NOTHING ELSE — never by
                            matching a key or a name, which the grep guards
                            forbid. A rename keeps it true. */}
                        {area.seeded && <span className="chip">Shipped</span>}
                        {area.open > 0 && (
                          <span className="mktarea__open">{area.open} open</span>
                        )}
                        {isOwner && (
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => setRenaming({ id: area.id, value: area.name })}
                          >
                            Rename
                          </button>
                        )}
                      </>
                    )}

                    {isOwner ? (
                      <Switch
                        checked={area.active}
                        label={`Collect from ${area.name}`}
                        /* Guarded here rather than by a `disabled` prop the
                         * shared Switch does not have: a second click while the
                         * first PATCH is in flight would race its own CAS and
                         * answer `stale_write` for no reason. */
                        onChange={(next) => {
                          if (busy === null) void patch(area, { active: next });
                        }}
                      />
                    ) : (
                      <span className="mktarea__state">
                        {area.active ? 'Collecting' : 'Not collecting'}
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              {isOwner && (
                <div className="mktarea__add">
                  {adding?.region === group.region ? (
                    <form
                      className="mktarea__rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void add();
                      }}
                    >
                      <input
                        className="mktform__input"
                        value={adding.name}
                        autoFocus
                        placeholder="Name of the place"
                        aria-label={`New area in ${group.region}`}
                        onChange={(event) =>
                          setAdding({ region: group.region, name: event.target.value })
                        }
                      />
                      <button type="submit" className="btn btn--sm">
                        Add
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => {
                          setAdding(null);
                          setAddProblem(null);
                        }}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setAdding({ region: group.region, name: '' })}
                    >
                      Add an area
                    </button>
                  )}
                  {adding?.region === group.region && addProblem !== null && (
                    <p className="mktform__error">{addProblem}</p>
                  )}
                </div>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
