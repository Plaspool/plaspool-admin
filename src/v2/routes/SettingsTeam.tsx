import { useCallback, useEffect, useState } from 'react';
import {
  Copy,
  Lock,
  MoreHorizontal,
  Plus,
  Settings as SettingsIcon,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';
import {
  refusalOf,
  teamApi,
  type MintedInvite,
  type TeamInvite,
  type TeamRefusal,
  type TeamUser,
} from '../../data/api-team';
import {
  ALL_ROLES,
  ASSIGNABLE_ROLES,
  ROLE_INFO,
  canAssign,
  canManage,
  isAdminRole,
  type Role,
} from '../../../shared/roles';
import { ApiError } from '../../data/errors';
import { getSession } from '../../data/session';
import type { AuthUser } from '../../data/types';
import { dateTime, shortDate } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, EmptyState } from '../ui/primitives';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { TextField } from '../ui/Field';
import { Card } from '../ui/Card';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

/**
 * TEAM — `/settings/team`: accounts, roles, sign-in codes and invites.
 *
 * SENIORITY IS THE SERVER'S TABLE, MIRRORED BY ABSENCE. `shared/roles.ts` is
 * the one file both sides read: `canManage` decides whether a row offers any
 * management at all, `canAssign` decides which roles a picker lists, and an
 * action the viewer cannot take is ABSENT, not disabled — the same rule as the
 * fallback zone's missing Delete. A developer therefore sees no ⋯ on the
 * owner's row or a fellow developer's, and no "Developer" card when re-roling;
 * nothing here bounces off a 409 that the table already predicted.
 *
 * The 409s that remain possible (two admins racing, a stale list) arrive as
 * `TeamRefusal` codes and are shown as the honest sentence each one means —
 * never the codes, never generic prose the server would drift from.
 *
 * THE ONE PER-ROW ACTION SELF-SERVICE ALLOWS IS THE SIGN-IN CODE: hardening
 * your own login needs nobody's signature (`server/routes/users.ts`), so your
 * own row keeps that item even when seniority hides everything else.
 */

const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The honest sentence each 409 refusal means. Keyed by the wire code so the
 *  screen can never show a wrong sentence for a right refusal. */
const REFUSAL_MESSAGE: Record<TeamRefusal, string> = {
  manage_peer: "Developers can't remove or change the owner or other developers.",
  disable_self: "You can't disable your own account — ask another admin.",
  disable_last_owner: 'This is the only owner account — the store always keeps one.',
  role_self: "The owner's role can't change, and nobody edits their own.",
  role_owner: "The owner's role can't change, and nobody edits their own.",
};

const who = (u: { displayName: string; email: string }): string =>
  u.displayName.trim() || u.email;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0]!.toUpperCase()).join('');
}

function AdminOnly() {
  return (
    <div className="page">
      <PageHeader icon={<SettingsIcon />} title="Team" backTo="/settings" backLabel="Settings" />
      <div className="card">
        <EmptyState
          icon={<Lock />}
          title="Owner and developer surface"
          body="Accounts, roles and invites are managed by the owner and the developers. Ask one of them if the team needs changing."
        />
      </div>
    </div>
  );
}

export default function SettingsTeam() {
  const toast = useToast();
  const session = getSession();
  const viewer: AuthUser | null = 'user' in session ? (session.user ?? null) : null;
  const admin = viewer !== null && isAdminRole(viewer.role);

  const [users, setUsers] = useState<TeamUser[] | null>(null);
  const [invites, setInvites] = useState<TeamInvite[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [reRoling, setReRoling] = useState<TeamUser | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<TeamUser | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [members, open] = await Promise.all([
        teamApi.listUsers(signal),
        teamApi.listInvites(false, signal),
      ]);
      setUsers(members);
      setInvites(open);
      setLoadError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setLoadError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    }
  }, []);

  useEffect(() => {
    if (!admin) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, admin]);

  if (!admin || viewer === null) return <AdminOnly />;
  const viewerRole = viewer.role;

  /** Show a refusal's own sentence; `false` means it was not a refusal. */
  function refusalToast(cause: unknown): boolean {
    const refusal = refusalOf(cause);
    if (refusal === null) return false;
    toast.show(REFUSAL_MESSAGE[refusal], 'critical');
    return true;
  }

  function plainToast(cause: unknown) {
    if (refusalToast(cause)) return;
    toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
  }

  async function toggleTwoFactor(u: TeamUser) {
    const next = !u.twoFactorEmail;
    try {
      await teamApi.setTwoFactor(u.id, next);
      toast.show(
        next
          ? `${who(u)} now needs an emailed code to sign in`
          : `${who(u)} signs in with their password alone`,
      );
      void load();
    } catch (cause) {
      plainToast(cause);
    }
  }

  async function disable(u: TeamUser) {
    setConfirmDisable(null);
    try {
      const { sessionsEnded } = await teamApi.disableUser(u.id);
      toast.show(
        sessionsEnded > 0
          ? `${who(u)} disabled — signed out of ${sessionsEnded} ${sessionsEnded === 1 ? 'session' : 'sessions'}`
          : `${who(u)} disabled`,
      );
      void load();
    } catch (cause) {
      plainToast(cause);
      void load();
    }
  }

  async function enable(u: TeamUser) {
    try {
      await teamApi.enableUser(u.id);
      toast.show(`${who(u)} can sign in again — the sessions ended on disable stay gone`);
      void load();
    } catch (cause) {
      plainToast(cause);
    }
  }

  async function revoke(inv: TeamInvite) {
    try {
      await teamApi.revokeInvite(inv.id);
      toast.show(`Invite for ${inv.email} revoked`);
      void load();
    } catch (cause) {
      plainToast(cause);
    }
  }

  const columns: Column<TeamUser>[] = [
    {
      key: 'person',
      header: 'Member',
      primary: true,
      render: (u) => (
        <IdCell
          thumb={
            u.displayName.trim() ? (
              <span style={{ fontSize: 'var(--t-sm)', fontWeight: 'var(--w-semi)', color: 'var(--ink-sub)' }}>
                {initialsOf(u.displayName)}
              </span>
            ) : (
              <UserRound aria-hidden="true" />
            )
          }
          title={who(u)}
          meta={u.displayName.trim() ? u.email : `Joined ${shortDate(u.createdAt)}`}
        />
      ),
    },
    {
      key: 'role',
      header: 'Role',
      label: 'Role',
      mobile: 'keep',
      tight: true,
      render: (u) => <Badge>{ROLE_INFO[u.role].label}</Badge>,
    },
    {
      key: 'status',
      header: 'Status',
      label: 'Status',
      tight: true,
      render: (u) =>
        u.disabledAt === null ? (
          <Badge tone="ok">Active</Badge>
        ) : (
          <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
            <Badge tone="critical">Disabled</Badge>
            <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>
              since {shortDate(u.disabledAt)}
            </span>
          </span>
        ),
    },
    {
      key: 'code',
      header: 'Sign-in code',
      label: 'Sign-in code',
      tight: true,
      render: (u) => (u.twoFactorEmail ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>),
    },
    {
      key: 'act', pin: true,
      header: <span className="sr">Actions</span>,
      label: 'Actions',
      tight: true,
      render: (u) => {
        const self = u.id === viewer.id;
        const manage = canManage(viewerRole, u.role);
        /* No reach, no menu — the codebase rule (the fallback zone's missing
           Delete): a control in front of a guaranteed refusal is a promise
           nobody keeps. Your own row keeps the sign-in code item alone. */
        if (!manage && !self) return null;
        return (
          <Menu
            chrome="bare"
            buttonLabel={`Actions for ${who(u)}`}
            label={
              <span className="btn btn--plain btn--icon" style={{ display: 'inline-grid', placeItems: 'center' }}>
                <MoreHorizontal aria-hidden="true" />
              </span>
            }
          >
            {(close) => {
              if (u.disabledAt !== null) {
                /* A disabled row's whole story is the way back in. */
                return (
                  <MenuItem
                    onSelect={() => {
                      close();
                      void enable(u);
                    }}
                  >
                    Enable account
                  </MenuItem>
                );
              }
              return (
                <>
                  {manage && !self && u.role !== 'owner' ? (
                    <MenuItem
                      onSelect={() => {
                        close();
                        setReRoling(u);
                      }}
                    >
                      Change role…
                    </MenuItem>
                  ) : null}
                  <MenuItem
                    onSelect={() => {
                      close();
                      void toggleTwoFactor(u);
                    }}
                  >
                    {u.twoFactorEmail ? 'Stop requiring sign-in code' : 'Require sign-in code'}
                  </MenuItem>
                  {manage && !self ? (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        critical
                        icon={<Trash2 aria-hidden="true" />}
                        onSelect={() => {
                          close();
                          setConfirmDisable(u);
                        }}
                      >
                        Disable account…
                      </MenuItem>
                    </>
                  ) : null}
                </>
              );
            }}
          </Menu>
        );
      },
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<SettingsIcon />}
        title="Team"
        backTo="/settings"
        backLabel="Settings"
        subtitle="Who can sign in, and what each role may touch."
        actions={
          <Button tone="primary" size="lg" onClick={() => setInviting(true)}>
            <Plus aria-hidden="true" />
            Invite member
          </Button>
        }
      />

      {loadError ? (
        <Banner
          tone="critical"
          title="Couldn’t load the team"
          action={<Button onClick={() => void load()}>Retry</Button>}
        >
          {loadError}
        </Banner>
      ) : null}

      <DataTable
        caption="Team"
        columns={columns}
        rows={users ?? []}
        rowKey={(u) => u.id}
        loading={users === null && !loadError}
        empty={
          <EmptyState
            icon={<Users />}
            title="Nobody here yet"
            body="An invite is the only door into this admin — mint one and the account exists when it is accepted."
          />
        }
        footer={null}
      />

      <p className="page__learn">
        Disabling an account destroys every session it holds, on the spot. Enabling it later
        restores the ability to sign in — the destroyed sessions do not come back.
      </p>

      <Card title="Invites">
        {invites === null && !loadError ? (
          <div className="stack stack--tight" aria-hidden="true">
            <span className="skel" style={{ width: '14rem' }} />
            <span className="skel" style={{ width: '11rem', opacity: 0.7 }} />
          </div>
        ) : (invites ?? []).length === 0 ? (
          <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.5, margin: 0 }}>
            Nobody is waiting on an invite. “Invite member” mints a link that can go by mail or by
            hand — it is the only way a new person ever gets in.
          </p>
        ) : (
          (invites ?? []).map((inv) => (
            <div key={inv.id} className="row" style={{ gap: 'var(--s3)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--t-md)', fontWeight: 'var(--w-medium)' }}>{inv.email}</div>
                <div className="muted" style={{ fontSize: 'var(--t-sm)' }}>
                  {ROLE_INFO[inv.role].label} · expires {dateTime(inv.expiresAt)} · invited by{' '}
                  {inv.invitedByName}
                </div>
              </div>
              <Button
                tone="plain"
                style={{ color: 'var(--critical)' }}
                aria-label={`Revoke invite for ${inv.email}`}
                onClick={() => void revoke(inv)}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          ))
        )}
      </Card>

      {/* ═══ WHAT EACH ROLE ENTAILS ═══ The owner's explicit ask: the words on
          this card are `ROLE_INFO` itself — the same table the server enforces
          — so the description and the permission cannot drift apart. */}
      <Card title="What each role entails">
        {ALL_ROLES.map((role, index) => {
          const info = ROLE_INFO[role];
          return (
            <div
              key={role}
              style={index > 0 ? { borderTop: '1px solid var(--border-sub)', paddingTop: 'var(--s3)' } : undefined}
            >
              <div className="row" style={{ gap: 'var(--s2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 'var(--t-md)', fontWeight: 'var(--w-semi)' }}>{info.label}</span>
                <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>{info.tagline}</span>
              </div>
              <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.55, margin: 'var(--s1) 0 0' }}>
                {info.description}
              </p>
            </div>
          );
        })}
      </Card>

      {inviting ? (
        <InviteModal
          viewerRole={viewerRole}
          onClose={() => setInviting(false)}
          onMinted={() => void load()}
        />
      ) : null}

      {reRoling ? (
        <RoleModal
          user={reRoling}
          viewerRole={viewerRole}
          onClose={() => setReRoling(null)}
          onDone={() => {
            setReRoling(null);
            void load();
          }}
          onRefused={(refusal) => {
            setReRoling(null);
            toast.show(REFUSAL_MESSAGE[refusal], 'critical');
            void load();
          }}
        />
      ) : null}

      {confirmDisable ? (
        <Modal
          title={`Disable ${who(confirmDisable)}?`}
          onClose={() => setConfirmDisable(null)}
          footer={
            <>
              <Button onClick={() => setConfirmDisable(null)}>Cancel</Button>
              <Button tone="critical" onClick={() => void disable(confirmDisable)}>
                Disable account
              </Button>
            </>
          }
        >
          <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
            They are signed out everywhere the moment you confirm — every session the account
            holds is destroyed — and they cannot sign in again until somebody re-enables it.
            Their posts and history stay.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════ ROLE CARDS ══ */

/**
 * The radio-card list both modals share: only what the VIEWER may hand out
 * (`canAssign`), each card carrying the role's label, tagline and description
 * from `ROLE_INFO` — pick from the same words the roles card at the bottom of
 * the page explains.
 */
function RoleCards({
  viewerRole,
  name,
  value,
  onChange,
}: {
  viewerRole: Role;
  /** The radio group's `name` — two modals must never share one. */
  name: string;
  value: Exclude<Role, 'owner'>;
  onChange: (next: Exclude<Role, 'owner'>) => void;
}) {
  const options = ASSIGNABLE_ROLES.filter((role) => canAssign(viewerRole, role));
  return (
    <div className="stack stack--tight" role="radiogroup" aria-label="Role">
      {options.map((role) => {
        const info = ROLE_INFO[role];
        const picked = value === role;
        return (
          <label
            key={role}
            className="check"
            style={{
              alignItems: 'flex-start',
              border: `1px solid ${picked ? 'var(--ink-strong)' : 'var(--border)'}`,
              borderRadius: 'var(--r-md)',
              padding: 'var(--s3)',
              background: picked ? 'var(--surface-sunken)' : 'transparent',
            }}
          >
            <input type="radio" name={name} checked={picked} onChange={() => onChange(role)} />
            <span>
              <span className="row" style={{ gap: 'var(--s2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 'var(--w-semi)' }}>{info.label}</span>
                <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>{info.tagline}</span>
              </span>
              <span className="field__hint" style={{ display: 'block', marginTop: 2 }}>
                {info.description}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════ ROLE MODAL ══ */

function RoleModal({
  user,
  viewerRole,
  onClose,
  onDone,
  onRefused,
}: {
  user: TeamUser;
  viewerRole: Role;
  onClose: () => void;
  onDone: () => void;
  onRefused: (refusal: TeamRefusal) => void;
}) {
  const toast = useToast();
  const assignable = ASSIGNABLE_ROLES.filter((role) => canAssign(viewerRole, role));
  const [role, setRole] = useState<Exclude<Role, 'owner'>>(
    user.role !== 'owner' && assignable.includes(user.role) ? user.role : (assignable[0] ?? 'writer'),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const updated = await teamApi.setRole(user.id, role);
      toast.show(`${who(updated)} is now a ${ROLE_INFO[updated.role].label}`);
      onDone();
    } catch (cause) {
      const refusal = refusalOf(cause);
      if (refusal !== null) {
        onRefused(refusal);
        return;
      }
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Change ${who(user)}’s role`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} disabled={role === user.role} onClick={() => void commit()}>
            Change role
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.5, margin: 0 }}>
          Currently <strong>{ROLE_INFO[user.role].label}</strong>. The change takes effect on
          their next request — nothing signs them out.
        </p>
        <RoleCards viewerRole={viewerRole} name="re-role" value={role} onChange={setRole} />
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}

/* ═════════════════════════════════════════════════════════ INVITE MODAL ══ */

function InviteModal({
  viewerRole,
  onClose,
  onMinted,
}: {
  viewerRole: Role;
  onClose: () => void;
  onMinted: () => void;
}) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('writer');
  const [minted, setMinted] = useState<MintedInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commit() {
    const address = email.trim();
    if (!EMAILISH.test(address)) {
      setError('That does not look like an email address.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await teamApi.createInvite(address, role);
      /* THE MODAL STAYS OPEN. The URL below contains the raw token and is
         minted exactly once — closing on success would throw away the only
         copy (`api-team.ts` on `MintedInvite`). */
      setMinted(result);
      onMinted();
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 400 && cause.detail === 'email'
          ? 'An account already exists for that address.'
          : cause instanceof Error && cause.message
            ? cause.message
            : 'Something went wrong.',
      );
      setBusy(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.show('Invite link copied');
    } catch {
      toast.show('Copy failed — select the link and copy it yourself', 'critical');
    }
  }

  if (minted !== null) {
    return (
      <Modal
        title="Invite created"
        onClose={onClose}
        footer={
          <Button tone="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="stack">
          <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.5, margin: 0 }}>
            {minted.invite.email} joins as {ROLE_INFO[minted.invite.role].label} the moment they
            open this link. It is shown exactly once.
          </p>
          <TextField
            label="Invite link"
            readOnly
            value={minted.invite.url}
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="row" style={{ gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <Button onClick={() => void copy(minted.invite.url)}>
              <Copy aria-hidden="true" />
              Copy link
            </Button>
            <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>
              {minted.emailed
                ? `Emailed to ${minted.invite.email} ✓`
                : 'Mail not configured — send them this link.'}
            </span>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Invite member"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void commit()}>
            Create invite
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField
          label="Email"
          type="email"
          value={email}
          placeholder="ada@plaspool.com"
          autoFocus
          onChange={(event) => {
            setEmail(event.target.value);
            setError(null);
          }}
        />
        <RoleCards viewerRole={viewerRole} name="invite-role" value={role} onChange={setRole} />
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}
