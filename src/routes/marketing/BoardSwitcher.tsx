import { AlertTriangle, MapPin } from 'lucide-react';
import { Picker, type PickerItem } from '../../components/ui/Picker';
import { OUT_OF_AREA, type AreasView, type ServiceArea } from '../../data/api-marketing';

/**
 * Which board you are looking at, and where there is work at all.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A DISTRICT IS A BOARD, NOT A SWIMLANE, AND THIS IS HOW YOU MOVE BETWEEN THEM.
 *
 * The expensive decision on this screen is which van goes where today, and it is
 * made one district at a time — so each district gets a whole board and this
 * picker is how you reach the next one. It doubles as the answer to "where is
 * there work at all", which is why every row carries a count.
 *
 * AN IDLE DISTRICT IS LISTED, QUIET, AND REACHABLE. Removing it would read as
 * "we do not serve there", which is a different and much worse claim than
 * "nothing is waiting there today".
 *
 * It used to be listed and INERT, on the reasoning that the picker should never
 * send somebody to a board with nothing to do on it. That was wrong twice. The
 * screen can already be sitting on an idle board — open it on a quiet morning
 * and every column says "Nothing here" — so a rule against reaching one was a
 * rule against reaching a state the app hands you anyway. And now that the list
 * has a search field, a row you typed the name of and cannot click is the most
 * frustrating control on the screen. It stays quiet: no badge, "nothing
 * waiting" beside it, and never the default.
 *
 * THE BADGE IS `--ink` ON `--paper` AND CARRIES NO COLOUR OF ITS OWN. Those two
 * tokens swap between themes, so one rule gives a near-black disc with light
 * type in the light theme and a white disc with black type in the dark one. A
 * third colour here would be a third thing to maintain and would say nothing the
 * number does not.
 *
 * THE COUNT COMES FROM THE AREAS ENDPOINT, NEVER FROM THE ROWS ON SCREEN. The
 * board you are looking at holds one district's cards; counting those would
 * badge every other district with zero, which is the switcher lying about
 * exactly the thing it exists to answer.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** What the picker shows when it is closed. `null` is the desk's own state —
 *  no board chosen yet — which only happens before the first fetch lands. */
export function currentBoard(areas: ServiceArea[], district: string | null): ServiceArea | null {
  if (district === null || district === OUT_OF_AREA) return null;
  return areas.find((area) => area.id === district) ?? null;
}

/**
 * The board a screen should open on when the URL names none.
 *
 * THE BUSIEST SERVED DISTRICT, and "busiest" is `needsAction` rather than `open`
 * — the same judgement the desk makes. Landing an operator on the board with the
 * most work waiting for a person is the one default that is never wrong; landing
 * them alphabetically on an empty board is a click they always have to undo.
 *
 * `null` when nothing is waiting anywhere, which the caller renders as the first
 * served district rather than as an error: a quiet morning is not a failure.
 */
export function busiestBoard(areas: ServiceArea[]): ServiceArea | null {
  const served = areas.filter((area) => area.active);
  if (served.length === 0) return null;
  const busiest = served.reduce((best, area) => (area.needsAction > best.needsAction ? area : best));
  return busiest.needsAction > 0 ? busiest : served[0];
}

/**
 * Group the served areas by region — but ONLY when more than one region has one.
 *
 * With a single region served, a heading over every row is chrome that tells you
 * nothing you did not already know. The day a second region is switched on, the
 * headings appear by themselves.
 */
export function groupedForSwitcher(areas: ServiceArea[]): { region: string | null; areas: ServiceArea[] }[] {
  const served = areas.filter((area) => area.active);
  const regions = [...new Set(served.map((area) => area.region))];
  if (regions.length <= 1) return [{ region: null, areas: served }];
  return regions.map((region) => ({
    region,
    areas: served.filter((area) => area.region === region),
  }));
}

/** The switcher's rows: every served district, grouped by region when there
 *  is more than one, quiet where there is nothing waiting. */
export function switcherItems(areas: readonly ServiceArea[]): PickerItem<string>[] {
  return groupedForSwitcher([...areas]).flatMap((group) =>
    group.areas.map((area) => ({
      value: area.id,
      label: area.name,
      group: group.region ?? undefined,
      badge: area.needsAction,
      note: area.needsAction === 0 ? 'nothing waiting' : undefined,
      /* Typed as part of the name even when the heading is not drawn: somebody
         looking for a district in Abia will type "Abia". */
      keywords: area.region,
    })),
  );
}

export function BoardSwitcher({
  view,
  district,
  onChoose,
}: {
  view: AreasView | null;
  district: string | null;
  onChoose: (district: string) => void;
}) {
  const areas = view?.areas ?? [];
  const current = currentBoard(areas, district);
  const outOfArea = view?.outOfArea ?? { needsAction: 0, open: 0 };

  const label =
    district === OUT_OF_AREA
      ? 'Outside the served areas'
      : (current?.name ?? (view === null ? 'Loading boards…' : 'Choose a board'));

  return (
    <Picker
      label="Switch board"
      value={district}
      triggerLabel={label}
      badge={current?.needsAction}
      items={switcherItems(areas)}
      onChange={onChoose}
      icon={<MapPin className="ui-ic" aria-hidden="true" />}
      searchPlaceholder="Search districts…"
      emptyText={
        areas.length === 0 && view !== null
          ? 'No areas are switched on yet. Turn one on under Areas to start taking returns.'
          : 'No district matches that.'
      }
      /* END-ALIGNED, because this control lives in the top-right corner of the
         screen and a popup hanging off its left edge would run off the window. */
      align="end"
      footer={
        /*
          THE FOOTER IS NOT A DISTRICT. Returns whose address resolves to no
          served area have no board — they can be cancelled or rejected, and they
          can never be awarded. Given a row among the districts it would sort
          somewhere in the list, appear in search results for a place name, and
          read as somewhere a van goes — exactly the claim this design refuses to
          make. Below the fold of the list, it is the one row the search cannot
          hide either, which is right for the pile nothing else will show you.
        */
        outOfArea.open > 0
          ? (close) => (
              <button
                type="button"
                className={`ui-picker__row mktswitch__out${district === OUT_OF_AREA ? ' is-chosen' : ''}`}
                onClick={() => {
                  close();
                  onChoose(OUT_OF_AREA);
                }}
              >
                <AlertTriangle className="ui-ic mktswitch__warn" aria-hidden="true" />
                <span className="ui-picker__label">Outside the served areas</span>
                <span className="ui-picker__badge">{outOfArea.open}</span>
              </button>
            )
          : undefined
      }
    />
  );
}
