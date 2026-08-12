// @vitest-environment jsdom
/**
 * The three email screens, against a stubbed `fetch`.
 *
 * `fetch` IS STUBBED RATHER THAN `../data/api-email`, deliberately. The backend
 * for HANDOFF §2 A6 is being written in another session right now, and the thing
 * most likely to be wrong when the two halves meet is not a component — it is a
 * path, a method, or a body key. Mocking the api module would assert that the
 * screens call functions that this file also defines, which is a tautology;
 * mocking the transport asserts the requests that actually go on the wire.
 *
 * The four cases that carry the most weight, and why:
 *
 * 1. The preview iframe is sandboxed. It renders author-supplied HTML on the
 *    admin origin; the attribute is the entire boundary and a refactor that
 *    dropped it would look completely fine on screen.
 * 2. A template missing `{{unsubscribe_url}}` warns and still saves. Both
 *    halves matter — blocking the save is the failure mode a reasonable person
 *    would build by accident.
 * 3. The confirm dialog states a count it re-read on opening, and offers no
 *    send button until it has one. This is the last thing between a writer and
 *    a few thousand strangers.
 * 4. The CSV import shows every rejected row and posts only the valid ones,
 *    and not until the consent switch is on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import EmailTemplates from './EmailTemplates';
import EmailBroadcasts from './EmailBroadcasts';
import EmailSubscribers from './EmailSubscribers';

/**
 * jsdom has no `HTMLDialogElement.showModal` (measured here, not assumed — the
 * same shim and the same reason as `RequireAuth.test.tsx:50`). `Dialog` calls it
 * from an effect, so without this the confirm dialog throws during commit and
 * every broadcast case fails against an empty document.
 */
const dialogProto = Object.getPrototypeOf(document.createElement('dialog'));
dialogProto.showModal = function (this: HTMLDialogElement) {
  this.open = true;
};
dialogProto.close = function (this: HTMLDialogElement) {
  this.open = false;
};

/**
 * The other things jsdom does not have, in the shape `Dashboard.test.tsx:122`
 * uses. Radix's Select reaches for pointer capture and `scrollIntoView` the
 * moment its popup opens, and an unhandled `hasPointerCapture is not a
 * function` from inside a React event handler is reported as a whole-file
 * error rather than as a failing assertion.
 */
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// -------------------------------------------------------------- the network

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
}

type Reply = { status?: number; body?: unknown };
/** A handler may answer later, which is how "still loading" is tested at all. */
type Handler = (call: Call) => Reply | Promise<Reply>;

let handlers: Record<string, Handler> = {};
let calls: Call[] = [];
/** Requests no handler answered. Asserted empty, so a typo'd path is loud. */
let unhandled: string[] = [];

const on = (route: string, reply: Handler | Reply) => {
  handlers[route] = typeof reply === 'function' ? reply : () => reply;
};

/** Every call to one route, in order, so a re-read can be told from a cache. */
const callsTo = (route: string): Call[] =>
  calls.filter((c) => `${c.method} ${c.path}` === route);

beforeEach(() => {
  handlers = {};
  calls = [];
  unhandled = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      // `apiFetch` sends app-relative paths; a base is needed only to parse.
      const parsed = new URL(String(input), 'https://studio.test');
      const call: Call = {
        method: init.method ?? 'GET',
        path: parsed.pathname,
        query: parsed.searchParams,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const key = `${call.method} ${call.path}`;
      const handler = handlers[key];
      if (!handler) {
        unhandled.push(key);
        return { ok: false, status: 500, text: async () => '{}' } as unknown as Response;
      }
      const reply = await handler(call);
      const status = reply.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (reply.body === undefined ? '' : JSON.stringify(reply.body)),
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // A screen that quietly asks for a route nobody wrote shows an error banner
  // and otherwise looks like a passing test with an empty list in it.
  expect(unhandled).toEqual([]);
});

// --------------------------------------------------------------- fixtures

const template = (over: Record<string, unknown> = {}) => ({
  id: 't_1',
  name: 'March letter',
  subject: 'What we made in March',
  html: '<p>Hello {{name}}</p><a href="{{unsubscribe_url}}">Unsubscribe</a>',
  text: 'Hello {{name}}\n\nUnsubscribe: {{unsubscribe_url}}',
  updatedAt: Date.UTC(2026, 2, 4, 12),
  updatedBy: 'u_owner',
  ...over,
});

const broadcast = (over: Record<string, unknown> = {}) => ({
  id: 'b_1',
  templateId: 't_1',
  subject: 'What we made in March',
  html: '<p>Hello</p>',
  text: 'Hello',
  status: 'draft',
  createdBy: 'u_owner',
  createdAt: Date.UTC(2026, 2, 4, 12),
  scheduledAt: null,
  startedAt: null,
  finishedAt: null,
  sentCount: 0,
  failedCount: 0,
  recipientCount: 0,
  ...over,
});

const subscriber = (over: Record<string, unknown> = {}) => ({
  id: 's_1',
  email: 'reader@example.com',
  source: 'manual',
  consentAt: Date.UTC(2026, 1, 1),
  unsubscribedAt: null,
  ...over,
});

const mount = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

/** Locale-proof: the screen formats with `toLocaleString`, so the test does too. */
const shown = (n: number): string => n.toLocaleString();

/**
 * The confirm dialog's panel, so a count inside it can be told apart from the
 * composer's own audience numbers sitting behind it — which is the entire
 * distinction two of the cases below are about. Found by its heading rather
 * than by `getByRole('dialog')`: the shimmed `showModal` sets the `open`
 * PROPERTY, and the accessibility tree reads the ATTRIBUTE.
 */
const dialogPanel = (): HTMLElement => {
  const panel = screen
    .getByRole('heading', { name: 'Send this broadcast?' })
    .closest('.dialog__panel');
  if (!panel) throw new Error('the confirm dialog is not open');
  return panel as HTMLElement;
};

// ================================================================ templates

describe('the template editor', () => {
  beforeEach(() => {
    on('GET /api/admin/email/templates', { body: { items: [template()] } });
  });

  it('previews the HTML in an iframe that cannot run scripts', async () => {
    const user = userEvent.setup();
    mount(<EmailTemplates />);

    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    const frame = (await screen.findByTitle('Preview of the HTML body')) as HTMLIFrameElement;
    /*
     * `sandbox=""` is every restriction with no exception. Asserted as an
     * attribute rather than through `frame.sandbox.length`, because the empty
     * token list and a MISSING attribute are both length 0 — and "missing" is
     * precisely the regression this test exists to catch.
     */
    expect(frame.hasAttribute('sandbox')).toBe(true);
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('Hello {{name}}');
  });

  it('follows the source as it is typed, without a render step', async () => {
    const user = userEvent.setup();
    mount(<EmailTemplates />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    const source = screen.getByLabelText('HTML body');
    await user.clear(source);
    await user.type(source, '<h1>Spring</h1>');

    const frame = screen.getByTitle('Preview of the HTML body') as HTMLIFrameElement;
    expect(frame.getAttribute('srcdoc')).toBe('<h1>Spring</h1>');
  });

  it('warns about a missing unsubscribe variable and still saves', async () => {
    const user = userEvent.setup();
    on('GET /api/admin/email/templates', {
      body: { items: [template({ html: '<p>Hi</p>', text: 'Hi' })] },
    });
    on('PATCH /api/admin/email/templates/t_1', (c) => ({
      body: { template: template({ ...(c.body as object) }) },
    }));

    mount(<EmailTemplates />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    expect(screen.getByRole('status').textContent).toMatch(/before this template can be broadcast/i);
    expect(screen.getByRole('status').textContent).toMatch(/you cannot send it/i);

    const save = screen.getByRole('button', { name: /save template/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await user.click(save);

    await waitFor(() => expect(callsTo('PATCH /api/admin/email/templates/t_1')).toHaveLength(1));
    expect(callsTo('PATCH /api/admin/email/templates/t_1')[0].body).toMatchObject({
      name: 'March letter',
      html: '<p>Hi</p>',
    });
  });

  it('marks a template with no unsubscribe link in the list too', async () => {
    on('GET /api/admin/email/templates', {
      body: { items: [template({ html: '<p>Hi</p>', text: 'Hi' })] },
    });
    mount(<EmailTemplates />);
    expect(await screen.findByText(/no unsubscribe link/i)).toBeTruthy();
  });

  it('inserts a variable chip at the caret rather than at the end', async () => {
    const user = userEvent.setup();
    on('GET /api/admin/email/templates', {
      body: { items: [template({ html: 'AB', text: 'x {{unsubscribe_url}}' })] },
    });
    mount(<EmailTemplates />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    const source = screen.getByLabelText('HTML body') as HTMLTextAreaElement;
    source.focus();
    source.setSelectionRange(1, 1);
    await user.click(screen.getByRole('button', { name: '{{name}}' }));

    expect(source.value).toBe('A{{name}}B');
    // And the caret lands after what was inserted, not at the bottom of the
    // body — the whole reason the insert is not a `+=`.
    expect(source.selectionStart).toBe('A{{name}}'.length);
  });

  it('creates a new template with both variables already in it', async () => {
    const user = userEvent.setup();
    on('POST /api/admin/email/templates', (c) => ({
      status: 201,
      body: { template: template({ ...(c.body as object), id: 't_new' }) },
    }));

    mount(<EmailTemplates />);
    await user.click(await screen.findByRole('button', { name: /new template/i }));
    // The starter carries the unsubscribe link, so the warning must NOT be up.
    expect(screen.queryByText(/before this template can be broadcast/i)).toBeNull();

    await user.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() => expect(callsTo('POST /api/admin/email/templates')).toHaveLength(1));
    const sent = callsTo('POST /api/admin/email/templates')[0].body as { html: string };
    expect(sent.html).toContain('{{unsubscribe_url}}');
  });
});

// =============================================================== broadcasts

describe('starting a broadcast', () => {
  beforeEach(() => {
    on('GET /api/admin/email/broadcasts', { body: { items: [] } });
    on('GET /api/admin/email/templates', { body: { items: [template()] } });
    on('GET /api/admin/email/audience', { body: { subscribed: 3, suppressed: 1 } });
    on('POST /api/admin/email/broadcasts', { status: 201, body: { broadcast: broadcast() } });
    on('GET /api/admin/email/broadcasts/b_1', { body: { broadcast: broadcast() } });
  });

  async function openComposer(user: ReturnType<typeof userEvent.setup>) {
    mount(<EmailBroadcasts />);
    await user.click(await screen.findByRole('button', { name: /new broadcast/i }));
    await user.click(await screen.findByRole('radio'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByRole('button', { name: /send broadcast/i });
  }

  it('will not let a template without an unsubscribe link be picked', async () => {
    const user = userEvent.setup();
    on('GET /api/admin/email/templates', {
      body: { items: [template({ html: '<p>Hi</p>', text: 'Hi' })] },
    });

    mount(<EmailBroadcasts />);
    await user.click(await screen.findByRole('button', { name: /new broadcast/i }));

    const radio = (await screen.findByRole('radio')) as HTMLInputElement;
    expect(radio.disabled).toBe(true);
    expect(screen.getByText(/cannot be broadcast/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(callsTo('POST /api/admin/email/broadcasts')).toHaveLength(0);
  });

  it('shows the audience split before anything can be sent', async () => {
    const user = userEvent.setup();
    await openComposer(user);

    expect(screen.getByText(shown(3))).toBeTruthy();
    expect(screen.getByText(/subscribed — will receive this/i)).toBeTruthy();
    expect(screen.getByText(/unsubscribed — will be skipped/i)).toBeTruthy();
  });

  it('sends a test to the caller and to nobody else', async () => {
    const user = userEvent.setup();
    on('POST /api/admin/email/broadcasts/b_1/test', { body: { sent: true } });
    await openComposer(user);

    await user.click(screen.getByRole('button', { name: /send test to me/i }));
    await waitFor(() =>
      expect(callsTo('POST /api/admin/email/broadcasts/b_1/test')).toHaveLength(1),
    );
    // No recipient in the body: there is no way to aim a "test" at someone else.
    expect(callsTo('POST /api/admin/email/broadcasts/b_1/test')[0].body).toBeUndefined();
    expect(callsTo('POST /api/admin/email/broadcasts/b_1/send')).toHaveLength(0);
    expect(await screen.findByText(/a test has been sent to your own address/i)).toBeTruthy();
  });
});

describe('the confirmation in front of a send', () => {
  beforeEach(() => {
    on('GET /api/admin/email/broadcasts', { body: { items: [] } });
    on('GET /api/admin/email/templates', { body: { items: [template()] } });
    on('POST /api/admin/email/broadcasts', { status: 201, body: { broadcast: broadcast() } });
    on('GET /api/admin/email/broadcasts/b_1', { body: { broadcast: broadcast() } });
  });

  async function toTheDialog(user: ReturnType<typeof userEvent.setup>) {
    mount(<EmailBroadcasts />);
    await user.click(await screen.findByRole('button', { name: /new broadcast/i }));
    await user.click(await screen.findByRole('radio'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(await screen.findByRole('button', { name: /send broadcast/i }));
  }

  it('states a count it re-read as the dialog opened, not the one on the screen behind it', async () => {
    const user = userEvent.setup();
    /*
     * The audience GROWS between the composer mounting and the dialog opening —
     * an import in another tab, which is exactly the real case. A dialog that
     * showed 3 here would be asking for agreement to a number that stopped
     * being true while the screen sat open.
     */
    let answered = 0;
    on('GET /api/admin/email/audience', () => ({
      body: answered++ === 0 ? { subscribed: 3, suppressed: 1 } : { subscribed: 1284, suppressed: 12 },
    }));

    await toTheDialog(user);

    expect(await screen.findByText(shown(1284))).toBeTruthy();
    expect(callsTo('GET /api/admin/email/audience').length).toBeGreaterThan(1);
    expect(
      screen.getByRole('button', {
        name: (name) => name.includes(`Send to ${shown(1284)} people`),
      }),
    ).toBeTruthy();
  });

  it('prefers the broadcast’s own recipient set when it has one', async () => {
    const user = userEvent.setup();
    on('GET /api/admin/email/audience', { body: { subscribed: 9000, suppressed: 0 } });
    on('GET /api/admin/email/broadcasts/b_1', {
      body: { broadcast: broadcast({ recipientCount: 42 }) },
    });

    await toTheDialog(user);

    // 42 is what the drain will walk. 9000 is what the list looks like today
    // and has nothing to do with this broadcast — it is on the composer behind
    // the dialog, which is why the query is scoped to the panel.
    await screen.findByText(shown(42));
    const panel = dialogPanel();
    expect(within(panel).getByText(shown(42))).toBeTruthy();
    expect(within(panel).queryByText(shown(9000))).toBeNull();
  });

  it('offers no send button while the count is still being read', async () => {
    const user = userEvent.setup();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    on('GET /api/admin/email/audience', { body: { subscribed: 5, suppressed: 0 } });
    // Answered only after the assertions below have run, which is the whole
    // window this case is about.
    on('GET /api/admin/email/broadcasts/b_1', () =>
      held.then(() => ({ body: { broadcast: broadcast() } })),
    );

    await toTheDialog(user);

    // The point: there is no button at all in that window, not a disabled one
    // sitting next to a stale number.
    const panel = dialogPanel();
    expect(within(panel).getByText(/checking how many people this reaches/i)).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /send to/i })).toBeNull();
    expect(within(panel).getByRole('button', { name: /^cancel$/i })).toBeTruthy();

    release();
    await screen.findByText(shown(5));
  });

  it('sends only when the dialog’s own button is clicked', async () => {
    const user = userEvent.setup();
    on('GET /api/admin/email/audience', { body: { subscribed: 7, suppressed: 0 } });
    on('POST /api/admin/email/broadcasts/b_1/send', {
      body: { broadcast: broadcast({ status: 'sending', recipientCount: 7, sentCount: 4 }) },
    });

    await toTheDialog(user);
    // Opening the dialog is not sending, and neither is the button behind it.
    expect(callsTo('POST /api/admin/email/broadcasts/b_1/send')).toHaveLength(0);

    await user.click(
      await screen.findByRole('button', {
        name: (name) => name.includes(`Send to ${shown(7)} people`),
      }),
    );

    await waitFor(() =>
      expect(callsTo('POST /api/admin/email/broadcasts/b_1/send')).toHaveLength(1),
    );
    expect(await screen.findByText(/sending\./i)).toBeTruthy();
    expect(screen.getByRole('status', { name: /sending the broadcast/i })).toBeTruthy();
    expect(screen.getByText(shown(4))).toBeTruthy();
  });

  it('cancelling sends nothing', async () => {
    const user = userEvent.setup();
    on('GET /api/admin/email/audience', { body: { subscribed: 7, suppressed: 0 } });
    await toTheDialog(user);

    await user.click(await screen.findByRole('button', { name: /^cancel$/i }));
    expect(callsTo('POST /api/admin/email/broadcasts/b_1/send')).toHaveLength(0);
  });
});

// ============================================================== subscribers

describe('the subscriber list', () => {
  beforeEach(() => {
    on('GET /api/admin/email/subscribers', {
      body: { items: [subscriber()], nextCursor: null },
    });
  });

  it('asks the server for the filter it is showing', async () => {
    const user = userEvent.setup();
    mount(<EmailSubscribers />);

    await screen.findByText('reader@example.com');
    expect(callsTo('GET /api/admin/email/subscribers')[0].query.get('filter')).toBe('subscribed');

    await user.click(screen.getByRole('combobox', { name: /which subscribers to show/i }));
    await user.click(await screen.findByRole('option', { name: 'Unsubscribed' }));

    await waitFor(() =>
      expect(
        callsTo('GET /api/admin/email/subscribers').some(
          (c) => c.query.get('filter') === 'unsubscribed',
        ),
      ).toBe(true),
    );
  });

  it('keeps an unsubscribed row visible rather than hiding it', async () => {
    on('GET /api/admin/email/subscribers', {
      body: {
        items: [subscriber({ unsubscribedAt: Date.UTC(2026, 3, 1) })],
        nextCursor: null,
      },
    });
    mount(<EmailSubscribers />);
    expect(await screen.findByText('reader@example.com')).toBeTruthy();
    expect(screen.getByText('unsubscribed')).toBeTruthy();
  });

  it('adds one address', async () => {
    const user = userEvent.setup();
    on('POST /api/admin/email/subscribers', {
      status: 201,
      body: { subscriber: subscriber({ id: 's_2', email: 'new@example.com' }) },
    });

    mount(<EmailSubscribers />);
    await user.type(await screen.findByLabelText(/email address to add/i), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(callsTo('POST /api/admin/email/subscribers')).toHaveLength(1));
    expect(callsTo('POST /api/admin/email/subscribers')[0].body).toEqual({
      email: 'new@example.com',
    });
    expect(await screen.findByText('new@example.com')).toBeTruthy();
  });
});

describe('the CSV import', () => {
  const CSV =
    'Email,Name\r\n' +
    'ada@example.com,Ada\r\n' +
    '"lovelace@example.com","Lovelace, A."\r\n' +
    'not-an-address,Nope\r\n' +
    'ADA@example.com,Duplicate\r\n' +
    '\r\n';

  const upload = async (user: ReturnType<typeof userEvent.setup>, text = CSV) => {
    const file = new File([text], 'list.csv', { type: 'text/csv' });
    await user.upload(screen.getByLabelText(/choose a file/i), file);
  };

  beforeEach(() => {
    on('GET /api/admin/email/subscribers', { body: { items: [], nextCursor: null } });
  });

  it('shows every row and what will happen to it, before anything is sent', async () => {
    const user = userEvent.setup();
    mount(<EmailSubscribers />);
    await upload(user);

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);

    expect(within(table).getByText('not-an-address')).toBeTruthy();
    expect(within(table).getByText('not an email address')).toBeTruthy();
    expect(within(table).getByText('already in this file')).toBeTruthy();
    // A quoted field containing a comma is one cell, not two.
    expect(within(table).getByText('lovelace@example.com')).toBeTruthy();

    expect(screen.getByText(/2 rows are left out/i)).toBeTruthy();
    // The "Name" column exists in the file and is not stored: `email_subscribers`
    // has nowhere to put it, and a silent drop is how someone comes to believe
    // `{{name}}` will resolve to what was in their spreadsheet.
    expect(
      screen.getByText(/only the address is stored\. name is in the file and is not kept\./i),
    ).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith('/import'))).toBe(false);
  });

  it('will not import until the consent switch is on', async () => {
    const user = userEvent.setup();
    mount(<EmailSubscribers />);
    await upload(user);

    const button = (await screen.findByRole('button', {
      name: /import 2 addresses/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    await user.click(screen.getByRole('switch'));
    expect(button.disabled).toBe(false);
  });

  it('posts the valid addresses only, lower-cased and deduplicated', async () => {
    const user = userEvent.setup();
    on('POST /api/admin/email/subscribers/import', { body: { added: 2, skipped: 0 } });

    mount(<EmailSubscribers />);
    await upload(user);
    await user.click(await screen.findByRole('switch'));
    await user.click(screen.getByRole('button', { name: /import 2 addresses/i }));

    await waitFor(() =>
      expect(callsTo('POST /api/admin/email/subscribers/import')).toHaveLength(1),
    );
    expect(callsTo('POST /api/admin/email/subscribers/import')[0].body).toEqual({
      emails: ['ada@example.com', 'lovelace@example.com'],
      consent: true,
    });
    expect(await screen.findByText(/imported 2 addresses/i)).toBeTruthy();
  });

  it('reads a file with no header row as one address per line', async () => {
    const user = userEvent.setup();
    mount(<EmailSubscribers />);
    await upload(user, 'ada@example.com\nlovelace@example.com\n');

    expect(await screen.findByText(/2 addresses will be added/i)).toBeTruthy();
    expect(screen.queryByText(/is not kept/i)).toBeNull();
  });
});
