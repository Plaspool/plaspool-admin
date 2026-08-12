// @vitest-environment jsdom
/**
 * The migration screen's job is the DISCLOSURE, not the upload.
 *
 * Three things migration does cannot be undone by the writer — history is not
 * carried, the revision counter restarts, and a published post's address can
 * move — and the posts being uploaded predate accounts, so they land under
 * whichever name is signed in. Every one of those has to be readable *before*
 * the button, and the button has to be unreachable until the writer says yes.
 * That ordering is what these tests assert, because a result screen that
 * explains what just happened is not a disclosure.
 *
 * `../data/migrate` is mocked whole: what it does is `src/data/migrate.test.ts`'s
 * subject, and driving Dexie and a stubbed network from here would test that
 * module twice and this one not at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Migrate } from './Migrate';
import {
  canRetireLocalCopies,
  migrateLocalPosts,
  retireLocalCopies,
  surveyLocalPosts,
  type MigrationReport,
  type MigrationSurvey,
} from '../data/migrate';
import type { LocalPost } from '../data/db';
import type { AuthUser } from '../data/types';

vi.mock('../data/migrate', () => ({
  surveyLocalPosts: vi.fn(),
  migrateLocalPosts: vi.fn(),
  canRetireLocalCopies: vi.fn(),
  retireLocalCopies: vi.fn(),
}));

const USER: AuthUser = {
  id: 'u_alice',
  email: 'alice@example.com',
  displayName: 'Alice Kern',
  role: 'writer',
};

const localPost = (over: Partial<LocalPost> = {}): LocalPost =>
  ({
    id: 'p_1',
    title: 'The long way round',
    subtitle: '',
    slug: null,
    excerpt: '',
    excerptSource: 'derived',
    content: { type: 'doc', content: [] },
    coverImage: null,
    category: '',
    tags: [],
    template: null,
    status: 'draft',
    createdAt: 1,
    // 2026-03-04, chosen so the rendered date is checkable without pinning a
    // locale: the year is in every format a browser produces.
    updatedAt: Date.UTC(2026, 2, 4, 12),
    publishedAt: null,
    deletedAt: null,
    wordCount: 0,
    readingTime: 0,
    authorId: '',
    authorName: '',
    revision: 1,
    migratedAt: null,
    ...over,
  }) as LocalPost;

const survey = (over: Partial<MigrationSurvey> = {}): MigrationSurvey => ({
  pending: [localPost()],
  migrated: [],
  excluded: [],
  imageCount: 0,
  revisionCount: 0,
  ...over,
});

const report = (over: Partial<MigrationReport> = {}): MigrationReport => ({
  confirmed: ['p_1'],
  excluded: [],
  failed: [],
  images: { uploaded: 0, reused: 0, missing: 0, failed: 0 },
  revisionsNotCarried: 0,
  stoppedBy: null,
  ...over,
});

function renderScreen() {
  return render(
    <MemoryRouter>
      <Migrate user={USER} />
    </MemoryRouter>,
  );
}

/** True when `first` really does come before `second` in the document. */
function precedes(first: Element, second: Element): boolean {
  return !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/*
 * EXPLICIT, because this project does not set `globals: true`. Without it
 * Testing Library never registers its own `afterEach`, every render stacks in
 * the same document, and the second test onward fails with "found multiple
 * elements" — which reads like an assertion problem and is not one.
 */
afterEach(cleanup);

beforeEach(() => {
  // `mockResolvedValue` replaces the implementation and keeps the call history,
  // so without this "does not upload anything on mount" passes or fails
  // depending on which test ran before it.
  vi.clearAllMocks();
  vi.mocked(surveyLocalPosts).mockResolvedValue(survey());
  vi.mocked(canRetireLocalCopies).mockResolvedValue(false);
  vi.mocked(migrateLocalPosts).mockResolvedValue(report());
  vi.mocked(retireLocalCopies).mockResolvedValue({ posts: 1, revisions: 0, images: 0 });
});

describe('what the screen says before the button', () => {
  it('states all three losses and the account, above the upload button', async () => {
    renderScreen();

    const history = await screen.findByText(/edit history is not carried over/i);
    const address = screen.getByText(/a web address can change/i);
    const revision = screen.getByText(/at revision 1/i);
    const account = screen.getByText('Alice Kern');
    const button = screen.getByRole('button', { name: /upload to the blog/i });

    for (const [name, node] of [
      ['history', history],
      ['address change', address],
      ['revision 1', revision],
      ['account name', account],
    ] as const) {
      expect(precedes(node, button), `“${name}” must be readable before the button`).toBe(true);
    }
  });

  it('says plainly that the posts predate the connection and will be published as this account', async () => {
    renderScreen();
    const blurb = await screen.findByText(/written on this device/i);
    expect(blurb.textContent).toMatch(/before it was connected to the blog/i);
    expect(blurb.textContent).toMatch(/no record of who wrote/i);
    expect(blurb.textContent).toContain('Alice Kern');
  });

  it('names the number of snapshots that stay behind', async () => {
    vi.mocked(surveyLocalPosts).mockResolvedValue(survey({ revisionCount: 47 }));
    renderScreen();
    expect(await screen.findByText(/47 saved snapshots stay on this device/i)).toBeTruthy();
  });

  it('lists every post by title and date', async () => {
    vi.mocked(surveyLocalPosts).mockResolvedValue(
      survey({
        pending: [
          localPost({ id: 'p_1', title: 'The long way round' }),
          localPost({ id: 'p_2', title: 'Second thoughts', status: 'published' }),
        ],
      }),
    );
    renderScreen();

    expect(await screen.findByText('The long way round')).toBeTruthy();
    expect(screen.getByText('Second thoughts')).toBeTruthy();
    expect(screen.getAllByText(/last edited .*2026/i)).toHaveLength(2);
    // The status is shown too: "published" and "draft" are not the same
    // decision to upload under someone else's name.
    expect(screen.getByText('published')).toBeTruthy();
  });
});

describe('the confirmation', () => {
  it('keeps the button disabled until the writer explicitly agrees', async () => {
    const user = userEvent.setup();
    renderScreen();

    // `.disabled` rather than `toBeDisabled()`: this repo has no
    // `@testing-library/jest-dom`, and the matcher would be a silent
    // `Invalid Chai property` rather than an assertion.
    const button = (await screen.findByRole('button', {
      name: /upload to the blog/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    await user.click(screen.getByRole('switch', { name: /upload these posts as alice kern/i }));
    expect(button.disabled).toBe(false);

    await user.click(button);
    await waitFor(() => expect(vi.mocked(migrateLocalPosts)).toHaveBeenCalledWith('u_alice', expect.any(Function)));
  });

  it('does not upload anything on mount', async () => {
    renderScreen();
    await screen.findByRole('button', { name: /upload to the blog/i });
    expect(vi.mocked(migrateLocalPosts)).not.toHaveBeenCalled();
  });
});

describe('posts that cannot go', () => {
  it('lists each one with its reason and says it stays put', async () => {
    vi.mocked(surveyLocalPosts).mockResolvedValue(
      survey({
        excluded: [
          { id: 'p_x', title: 'Too big', reason: 'too_large', path: 'title', updatedAt: 1 },
          { id: 'p_y', title: 'Bad picture', reason: 'bad_protocol', path: 'content[3]', updatedAt: 1 },
        ],
      }),
    );
    renderScreen();

    expect(await screen.findByText('Too big')).toBeTruthy();
    expect(screen.getByText(/too large — title/i)).toBeTruthy();
    expect(screen.getByText(/bad protocol — content\[3\]/i)).toBeTruthy();
    expect(screen.getByText(/stay on this device untouched/i)).toBeTruthy();
  });
});

describe('the result', () => {
  it('explains a rate-limited stop in minutes and promises no double upload', async () => {
    const user = userEvent.setup();
    vi.mocked(migrateLocalPosts).mockResolvedValue(
      report({ confirmed: [], stoppedBy: { reason: 'rate_limited', retryAfter: 1800 } }),
    );
    renderScreen();

    await user.click(await screen.findByRole('switch'));
    await user.click(screen.getByRole('button', { name: /upload to the blog/i }));

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toMatch(/hourly upload limit/i);
    expect(notice.textContent).toMatch(/about 30 minutes/i);
    expect(notice.textContent).toMatch(/nothing already uploaded will be uploaded twice/i);
  });

  it('names each post the blog refused, with the detail it gave', async () => {
    const user = userEvent.setup();
    vi.mocked(migrateLocalPosts).mockResolvedValue(
      report({ confirmed: [], failed: [{ id: 'p_1', title: 'Poison', detail: 'content[7]' }] }),
    );
    renderScreen();

    await user.click(await screen.findByRole('switch'));
    await user.click(screen.getByRole('button', { name: /upload to the blog/i }));

    expect(await screen.findByText(/the blog refused this one: content\[7\]/i)).toBeTruthy();
  });
});

describe('removing the local copies', () => {
  it('is not offered while anything is still un-migrated', async () => {
    renderScreen();
    await screen.findByRole('button', { name: /upload to the blog/i });
    expect(screen.queryByRole('button', { name: /remove local copies/i })).toBeNull();
  });

  it('appears only once every post is stamped, and says what it will not delete', async () => {
    vi.mocked(canRetireLocalCopies).mockResolvedValue(true);
    vi.mocked(surveyLocalPosts).mockResolvedValue(
      survey({ pending: [], migrated: [localPost({ migratedAt: 1 })] }),
    );
    const user = userEvent.setup();
    renderScreen();

    const button = await screen.findByRole('button', { name: /remove local copies/i });
    expect(screen.getByText(/images that were never uploaded are kept/i)).toBeTruthy();

    await user.click(button);
    await waitFor(() => expect(vi.mocked(retireLocalCopies)).toHaveBeenCalled());
    expect(await screen.findByText(/removed 1 local copy/i)).toBeTruthy();
  });
});

describe('an empty library', () => {
  it('says so rather than offering a button that would do nothing', async () => {
    vi.mocked(surveyLocalPosts).mockResolvedValue(survey({ pending: [] }));
    renderScreen();
    expect(await screen.findByText(/nothing left to upload/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /upload to the blog/i })).toBeNull();
  });
});
