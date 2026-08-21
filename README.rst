==============
Plaspool Admin
==============

The administrative console behind Plaspool: a local-first publishing studio with
a storefront and marketing back office attached. Content lives in Postgres and
image bytes in object storage, while the browser keeps a full local copy — so the
application opens instantly, keeps accepting writing when the network drops, and
never loses work to a failed request.

Access is by invitation. The first account is the **owner**; every subsequent
account is a **writer**, who can read all published content and edit their own.

.. contents:: Contents
   :local:
   :depth: 1


Quick start
===========

Requires Node 24.x.

.. code-block:: bash

   npm install
   cp .env.example .env    # then fill in the values
   npm run db:migrate
   npm run dev:all

The application is served at http://localhost:5173.

``npm run dev`` starts the front end alone. That is sufficient for design work,
but authentication requires the API, so use ``dev:all`` for anything else.


Capabilities
============

Publishing
----------

- **Block editor** built on TipTap — headings, quotes, code, lists, checklists,
  tables, links, captioned images with alt text, and a reframeable cover image.
  No docked toolbar: a ``+`` opens the block palette beside the current empty
  line, and formatting appears in a selection bubble. Markdown shorthands and
  ``/`` commands are both supported.
- **Syntax-highlighted code blocks**, rendered identically in the editor and in
  the published article.
- **Scoped find and replace** (``Ctrl/Cmd+F``), operating on the document rather
  than the browser page. Replace-all is one undo step.
- **Structure-preserving paste** from Google Docs, Word, Notion or the web,
  discarding the source application's chrome while retaining pasted image data.
- **Pre-publish checks** that warn — never block — on missing alt text, an empty
  excerpt, absent category, skipped heading levels, dead links, and images still
  hotlinked from third-party origins.
- **Autosave with revision history.** Every save is retained and explicit saves
  become checkpoints. Restoring writes forward, so history is never destructive.
- **Full-text search against the server**, so results are identical on every
  device and cover content the local browser has never opened. Matching is on
  whole words.
- **Soft deletion.** Trash is recoverable in one click; permanent deletion is the
  only destructive action and is owner-only.
- **Complete export** — a single JSON bundle containing every post and its full
  revision history, available to owners and writers alike. Import uploads a
  bundle, images included, and reports failures alongside successes.

Commerce and marketing
----------------------

- **Catalog** management with categories, tags, variants, SKU generation and
  case-folded lookup.
- **Orders and fulfillment**, inventory tracking, and a customer directory.
- **Returns desk** — a drag-and-drop board with per-return detail, logging and
  bulk selection.
- **Rewards and loyalty** programs, promotional banners, and a service-area
  registry defining collection coverage.
- **Audit trail** across shop mutations.

Platform
--------

- **Offline-first.** Changes are persisted locally and transmitted when the
  connection returns. Work that never reached the server is listed on a recovery
  screen and can be written to a file. Creating a post and uploading an image are
  the only operations that require connectivity, and both say so plainly.
- **No third-party runtime requests.** Fonts are bundled and a service worker
  caches the application shell — never content.
- **Light and dark themes**, following the system preference or set explicitly.
  Every text and surface pairing is verified to WCAG AA in both.
- **Keyboard-complete.** Every shortcut is enumerated in-app (``?``, or
  ``Ctrl/Cmd+/``), and each one is covered by a test.


Technology
==========

===================  =========================================================
Layer                Stack
===================  =========================================================
Front end            React 19, TypeScript, Vite, Radix UI, TipTap
Local persistence    Dexie (IndexedDB), service worker
API                  Hono, deployed as a Vercel function
Database             Neon serverless Postgres via Drizzle ORM
Object storage       Cloudflare R2 (S3-compatible API)
Transactional mail   Resend
Testing              Vitest
Linting              oxlint
===================  =========================================================


Configuration
=============

Copy ``.env.example`` to ``.env``. ``server/env.ts`` validates the required
variables at boot and throws naming anything missing — never the values.

===========================  ================================================
Variable                     Purpose
===========================  ================================================
``DATABASE_URL``             Neon Postgres connection string. **Required.**
``SESSION_SECRET``           Session signing key, minimum 32 characters.
                             **Required.**
``APP_ORIGINS``              Comma-separated exact origins, matched by
                             equality and never by suffix. **Required.**
``RESEND_API_KEY``           Outbound mail for password reset. Optional.
``MAIL_FROM``                Verified sender address. Optional.
``R2_ACCOUNT_ID``            Cloudflare R2 account identifier.
``R2_BUCKET``                R2 bucket name.
``R2_ACCESS_KEY_ID``         R2 access key.
``R2_SECRET_ACCESS_KEY``     R2 secret key.
===========================  ================================================

Mail configuration may be left blank: the application boots and serves
everything else, and ``POST /api/auth/forgot`` answers ``501`` uniformly for
every address rather than only for addresses that have an account.

Commerce variables are read lazily by the modules that need them and are not
validated at boot.

Storefront cache purges need no variable at all. The storefront caches its
product fetch for an hour, so every catalogue write in the admin pushes a purge
to ``POST /api/revalidate`` on it and the edit is live in seconds instead. The
URL is a repository constant in
``server/shop/catalog/utils/revalidate-url.ts`` — it is public, and holding it
in the repo means a fresh clone and every preview behave like production, with
no deployment that silently stops purging because somebody forgot to set
something. Purges are fire-and-forget: scheduled after the write commits, never
awaited, and a failure is logged and dropped, because the storefront's own timer
is already the floor. A **test process never purges**, unless it has installed a
recording transport — see the guard in ``server/shop/catalog/revalidate.ts``.

.. warning::

   ``.env`` holds real credentials and is excluded from version control.
   ``.env.example`` is the checked-in template and must never contain values.


Project layout
==============

.. code-block:: text

   src/
     routes/       Dashboard, Editor, Reader, Login, Shop, Marketing screens
     editor/       TipTap configuration, node views, autosave
     components/   Design-system UI primitives
     data/         API client, IndexedDB cache, pending queue, sync
     styles/       Design tokens, base styles, prose styles

   shared/         Types, document schema, validation, backup bundle format
                   — imported by both client and server

   server/
     routes/       HTTP surface
     repo/         Data access
     db/           Drizzle schema and migrations
     storage/      Object storage adapters
     shop/         Catalog, inventory, orders, admin
     marketing/    Returns, rewards, banners, service areas, notifications

Two boundaries are load-bearing. ``src/data/api.ts`` is the only file under
``src/`` that calls ``fetch``. ``shared/`` depends on neither side, so the client
and server cannot hold two different answers to the same question.


Development
===========

===========================  ================================================
Command                      Effect
===========================  ================================================
``npm run dev``              Front end only (Vite dev server)
``npm run dev:api``          API only
``npm run dev:all``          Both concurrently — the normal target
``npm run build``            Type-check, then build client and server bundles
``npm test``                 Run the Vitest suite
``npm run lint``             Run oxlint
``npm run db:generate``      Generate a Drizzle migration from schema changes
``npm run db:migrate``       Apply pending migrations
``npm run preview``          Serve the production build locally
===========================  ================================================


License
=======

Proprietary. All rights reserved.
