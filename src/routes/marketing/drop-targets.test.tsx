import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  rectIntersection,
  type Active,
  type ClientRect,
  type CollisionDetection,
  type DroppableContainer,
} from '@dnd-kit/core';

/**
 * THE BOARD'S DROP TARGETS — that they exist at all.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FAILURE THIS FILE EXISTS FOR IS A BOARD THAT DRAGS AND CANNOT DROP.
 *
 * A card lifts, the overlay follows the pointer, the columns light up — and the
 * release does nothing. No error, no message, no request, no card moved. It
 * shipped in exactly that state: `useDroppable` was called for each column by a
 * component that returned `null`, so dnd-kit held four drop targets whose node
 * was never a node. An unmeasured droppable is left out of `droppableRects`
 * ENTIRELY — the library measures `node ? new Rect(…) : null` and keeps only
 * the truthy ones — so every collision check ran against an empty set,
 * `event.over` was always `null`, and `onDragEnd` returned on its first line.
 *
 * The bug is invisible from the DOM, because the board renders identically. It
 * is invisible to `drop.test.ts` too, which pins what a drop DECIDES and is
 * never reached, because no drop ever resolves.
 *
 * NOT DRIVEN THROUGH SYNTHETIC POINTER EVENTS, deliberately, and for the same
 * reason the resolver next door is a pure function: a jsdom drag asserts that
 * dnd-kit's sensors work — which is dnd-kit's business — against a layout where
 * every rect is zero. What is asserted here is the WIRING, which is the half
 * that was wrong: each column's DOM node reaches the droppable that claims it,
 * and each `useDroppable` runs somewhere the context can hear it.
 *
 * THE SECOND TRAP IS THE CONTEXT, and it is quieter than the first. Called from
 * the component that RENDERS `<DndContext>`, `useDroppable` reads the context
 * from ABOVE itself, finds the default, and registers with nobody — no warning,
 * no error, the same dead board. The `Below` marker in the mock asks exactly
 * the question dnd-kit asks silently.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const fixture = vi.hoisted(() => ({
  session: {
    status: 'authed',
    user: {
      id: 'u_owner',
      email: 'o@test.local',
      displayName: 'An Owner',
      role: 'owner' as 'owner' | 'writer',
    },
  },
}));

vi.mock('../../data/session', () => ({
  getSession: () => fixture.session,
  subscribe: () => () => {},
  initSession: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../../data/sync', () => ({ revalidate: vi.fn() }));

/**
 * What dnd-kit was actually told, per column: the ref object its `setNodeRef`
 * fills in, and whether the hook that produced it ran below the provider. The
 * two ways this board has been dead are `node.current === null` and
 * `below === false`.
 */
const dnd = vi.hoisted(() => ({
  columns: new Map<string, { node: { current: HTMLElement | null }; below: boolean }>(),
  /** The detector the screen hands `DndContext`, kept as a value so a release
   *  that lands clear of every column can be asked of it directly. */
  detect: null as CollisionDetection | null,
}));

/*
 * THE REAL LIBRARY, WITH TWO WIRES TAPPED. `importOriginal` keeps the actual
 * `DndContext` and the actual `useDroppable`, because a hand-written fake would
 * only prove that the fake registers drop targets — which is the one thing
 * nobody doubts.
 */
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  const { createContext, createElement, useContext } = await import('react');

  /* Rendered BY the real context as its child, so a droppable can be asked the
   * one question that separates a registered drop target from a silent one. */
  const Below = createContext(false);

  return {
    ...actual,
    DndContext: function DndContext(props: {
      collisionDetection?: CollisionDetection;
      children?: ReactNode;
    }) {
      dnd.detect = props.collisionDetection ?? null;
      return createElement(
        actual.DndContext,
        props,
        createElement(Below.Provider, { value: true }, props.children),
      );
    },
    useDroppable: function useDroppable(args: Parameters<typeof actual.useDroppable>[0]) {
      const below = useContext(Below);
      const droppable = actual.useDroppable(args);
      dnd.columns.set(String(args.id), { node: droppable.node, below });
      return droppable;
    },
  };
});

import { ToastProvider } from '../../components/Toast';
import {
  NOW,
  areasView,
  boardPage,
  cabbageArea,
  needsActionPage,
  programs,
} from '../../data/marketing-fixtures';
import { BOARD_COLUMNS } from './ReturnsBoard';
import { ReturnsScreen } from './ReturnsScreen';

// --------------------------------------------------------------- what jsdom lacks

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

// --------------------------------------------------------------------- the server

beforeEach(() => {
  dnd.columns.clear();
  dnd.detect = null;
  /* Pinned rather than faked wholesale: the ages this board renders are read off
   * `Date.now()`, and a suite whose answers depend on the minute it ran fails at
   * midnight. */
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'https://studio.test');
      const body =
        url.pathname === '/api/marketing/areas'
          ? { areas: areasView.areas, outOfArea: areasView.outOfArea }
          : url.pathname === '/api/marketing/programs'
            ? { programs }
            : url.searchParams.get('view') === 'needs_action'
              ? needsActionPage
              : boardPage;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * THE BOARD HAS LANDED — the heading comes from `GET /areas` and the cards from
 * a second `GET /returns`, so waiting on the heading alone is a race the suite
 * loses on a busy machine.
 *
 * BOTH WAITS NAME THEIR OWN TIMEOUT, and 1 000 ms — the default — is not enough
 * here. This screen is one of the heavy jsdom suites, and beside another of
 * them these two reads have been measured resolving past four seconds on a
 * loaded machine. That is a slow machine, not a broken board: the assertions
 * below are unchanged, they are simply allowed to wait for the render they are
 * about. A red bar from a busy CPU teaches everyone to disbelieve the suite.
 */
const LANDING = { timeout: 8000 };

async function board(): Promise<void> {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/marketing/returns']}>
        <ReturnsScreen />
      </MemoryRouter>
    </ToastProvider>,
  );
  await screen.findByRole('heading', { name: cabbageArea.name, level: 2 }, LANDING);
  await screen.findByText('Dara A.', { selector: '.mktcard__who' }, LANDING);
}

// ============================================================================

describe('the four columns are drop targets', () => {
  it('hands each column’s DOM NODE to the droppable that claims it', async () => {
    await board();

    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THE DEAD BOARD FAILS. `node.current` is the element dnd-kit
     * will measure; left `null` it is dropped from `droppableRects`, every
     * collision runs against nothing, and `event.over` is `null` for the life
     * of the screen.
     *
     * Compared to the element BY IDENTITY rather than "some node exists": a ref
     * that landed on the canvas, or on a card wrapper, or on three columns out
     * of four is a board that is wrong in a way no screenshot shows.
     * ═══════════════════════════════════════════════════════════════════════
     */
    expect([...dnd.columns.keys()].sort()).toEqual([...BOARD_COLUMNS].sort());

    for (const status of BOARD_COLUMNS) {
      const registered = dnd.columns.get(status);
      const element = document.querySelector(`[data-column="${status}"]`);
      expect(element, `no column rendered for ${status}`).not.toBeNull();
      expect(registered?.node.current, `${status} registered no node`).toBe(element);

      /* …and it was registered WITH THE CONTEXT, not with the default a hook
       * above the provider reads. Both halves are needed: a ref on a node
       * nobody is listening to is the same dead board, reached from the other
       * side. */
      expect(registered?.below, `${status} registered outside the DndContext`).toBe(true);
    }
  });
});

describe('a release that lands clear of the columns', () => {
  /* A four-column board: fixed-width lists side by side with a gutter, all of
   * one height because the canvas is a stretching flex row. */
  const WIDTH = 272;
  const GUTTER = 24;
  const FOOT = 600;

  const columnRects = new Map<string, ClientRect>(
    BOARD_COLUMNS.map((status, index) => {
      const left = index * (WIDTH + GUTTER);
      return [
        status,
        { top: 0, left, right: left + WIDTH, bottom: FOOT, width: WIDTH, height: FOOT },
      ];
    }),
  );

  /** The dragged card, released below the foot of the board and centred on one
   *  column — the overlay touching no column rect at all. */
  const releasedUnder = (status: string): ClientRect => {
    const column = columnRects.get(status);
    if (column === undefined) throw new Error(`no column ${status}`);
    return {
      top: FOOT + 40,
      bottom: FOOT + 160,
      left: column.left,
      right: column.left + WIDTH,
      width: WIDTH,
      height: 120,
    };
  };

  const args = (collisionRect: ClientRect) => ({
    active: { id: 'ret_dara_1' } as unknown as Active,
    collisionRect,
    droppableRects: columnRects,
    droppableContainers: [...columnRects.keys()].map((id) => ({
      id,
    })) as unknown as DroppableContainer[],
    pointerCoordinates: {
      x: collisionRect.left + collisionRect.width / 2,
      y: collisionRect.top + collisionRect.height / 2,
    },
  });

  it('still names the column it was released under, rather than nothing', async () => {
    await board();

    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE DEFAULT DETECTOR IS A SILENT DEAD DROP, which is why the screen names
     * one. `rectIntersection` answers with the droppable the dragged rect
     * OVERLAPS MOST — and a card released past the foot of the lists, or in a
     * gutter, or up on the desk overlaps none of them. It returns nothing,
     * `over` is `null`, and the release does nothing and says nothing: the same
     * symptom as an unwired ref, from a different cause.
     *
     * `closestCenter` has no such hole. Every release resolves to a column, and
     * an illegal one is REFUSED OUT LOUD by `resolveDrop` — which is this
     * board's whole position on silence.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const released = args(releasedUnder('scheduled'));
    expect(rectIntersection(released)).toEqual([]);

    const detect = dnd.detect;
    expect(detect, 'the screen left DndContext on its default detector').not.toBeNull();
    expect(detect?.(released)[0]?.id).toBe('scheduled');
  });
});
